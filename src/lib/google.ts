import { google, type docs_v1, type sheets_v4 } from "googleapis";
import type { Existing, SheetsRequest } from "./sheets/steps";
import { indexedText } from "./doc-import";
import { log } from "./log";
import { flattenTabs, inTab, openTab, type OpenTab } from "./doc-tabs";
import { exportGlyphs, nameLists, unnamedLists } from "./list-glyphs";

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      const isRetryable = code === 429 || (typeof code === "number" && code >= 500);
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      log.warn("google.retry", { attempt, maxAttempts, status: code, delayMs: Math.round(delay) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry: unreachable");
}

export function getOAuth2Client(redirectUri?: string) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    log.error("google.misconfigured", { message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local" });
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(redirectUri?: string, state?: string) {
  const client = getOAuth2Client(redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    ...(state ? { state } : {}),
    scope: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

export async function getTokensFromCode(code: string, redirectUri?: string) {
  const client = getOAuth2Client(redirectUri);
  const { tokens } = await client.getToken(code);
  return tokens;
}

/** A value inside a Drive query's quotes: its backslashes and quotes escaped */
export const driveQueryString = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * The user's Google Docs, most recently changed first, never ones in the trash. With `search`,
 * only those whose name contains it.
 */
export async function listRecentDocs(accessToken: string, maxResults = 15, search?: string | null) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: "v3", auth: client });
  const name = (search ?? "").trim().slice(0, 200);
  const res = await withRetry(() =>
    drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and trashed=false${name ? ` and name contains '${driveQueryString(name)}'` : ""}`,
      orderBy: "modifiedTime desc",
      pageSize: Math.max(1, Math.min(100, Math.floor(maxResults))),
      fields: "files(id, name, modifiedTime)",
    })
  );

  return (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    modifiedTime: f.modifiedTime!,
  }));
}

/** A Drive file's fields, for a document the user can see (404 when they can't) */
async function driveFile(accessToken: string, fileId: string, fields: string) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: "v3", auth: client, timeout: 20_000 });
  return (await withRetry(() => drive.files.get({ fileId, fields, supportsAllDrives: true }))).data;
}

/** Whether the user can edit the document (false: they can only view or comment on it) */
export async function canEditDocument(accessToken: string, documentId: string): Promise<boolean> {
  return (await driveFile(accessToken, documentId, "capabilities(canEdit)")).capabilities?.canEdit === true;
}

/** The document's name in Drive */
export async function getDocName(accessToken: string, documentId: string): Promise<string> {
  return (await driveFile(accessToken, documentId, "name")).name || "Untitled document";
}

export async function createGoogleDoc(
  accessToken: string,
  title: string = "Untitled Document"
): Promise<{ id: string; name: string }> {
  // Never retried: a create that timed out may still have made the document, and a retry would make a second
  const res = await docsClient(accessToken).documents.create({ requestBody: { title } });

  return {
    id: res.data.documentId!,
    name: res.data.title || title,
  };
}

export interface DocSnapshot {
  /** Index just past the last character (insert at endIndex - 1 to append) */
  endIndex: number;
  /** Last characters of the document body, for idempotency checks */
  tail: string;
  wordCount: number;
  /** The body with position i holding the character at Docs index i (see indexedText) */
  chars: string;
  revisionId: string;
  /** Words in each tab asked for, by id (a tab that is gone has none) */
  tabWords?: Record<string, number>;
}

/** A tab that isn't in the document (any more): what a deleted tab reads as */
export class TabGoneError extends Error {
  code = 404;
  constructor() { super("Requested entity was not found: that tab of the document is gone"); }
}

/**
 * The document with all its tabs, and one of them (`tabId`'s, or the first) where a document
 * without tabs has its content. Throws TabGoneError when that tab isn't there.
 */
export async function getDocument(accessToken: string, documentId: string, tabId?: string | null): Promise<OpenTab> {
  const open = openTab(await readDocument(accessToken, documentId), tabId);
  if (!open) throw new TabGoneError();
  await nameUnnamedLists(accessToken, documentId, open);
  return open;
}

/** documents.get with every tab's content */
async function readDocument(accessToken: string, documentId: string): Promise<docs_v1.Schema$Document> {
  const docs = docsClient(accessToken);
  return (await withRetry(() => docs.documents.get({ documentId, includeTabsContent: true }))).data;
}

/** How many tabs' lists are named at once (each is an export of that tab) */
const NAMING_AT_ONCE = 4;

/**
 * The document as Docs gives it, with every tab, each tab's lists named as getDocument names them
 * (so what is imported from it matches what the editor shows for that tab)
 */
export async function getRawDocument(accessToken: string, documentId: string): Promise<docs_v1.Schema$Document> {
  const doc = await readDocument(accessToken, documentId);
  const tabs = flattenTabs(doc);
  if (!tabs.length) {
    const open = openTab(doc);
    if (open) await nameUnnamedLists(accessToken, documentId, open);
    return doc;
  }
  const pending = tabs.map((t) => ({ t, open: openTab(doc, t.id)! })).filter((x) => unnamedLists(x.open.doc).length);
  for (let i = 0; i < pending.length; i += NAMING_AT_ONCE) {
    await Promise.all(pending.slice(i, i + NAMING_AT_ONCE).map(async ({ t, open }) => {
      await nameUnnamedLists(accessToken, documentId, open);
      // (the tab's lists are the ones its open copy named; kept with the tab whatever openTab shares)
      if (t.tab.documentTab) t.tab.documentTab.lists = open.doc.lists;
    }));
  }
  return doc;
}

/**
 * Lists the API gives no glyph for (a checklist, or the bullets of an older preset) are told apart by
 * the tab's own HTML export, which draws each level's glyph (list-glyphs.ts). Without the export they
 * stay as the API gives them.
 */
async function nameUnnamedLists(accessToken: string, documentId: string, open: OpenTab) {
  const ids = unnamedLists(open.doc);
  if (!ids.length) return;
  try {
    const html = await exportHtml(accessToken, documentId, open.tabId);
    const named = nameLists(open.doc, exportGlyphs(html), ids);
    if (named.length) log.info("docs.lists_named", { lists: named.length, of: ids.length });
  } catch (err) {
    log.warn("docs.lists_unnamed", { lists: ids.length, err });
  }
}

/** A tab's HTML as Docs exports it (the first tab's when there is none), at most 20 MB */
export async function exportHtml(accessToken: string, documentId: string, tabId?: string | null): Promise<string> {
  const url = `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/export?format=html${tabId ? `&tab=${encodeURIComponent(tabId)}` : ""}`;
  const res = await withRetry(async () => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw Object.assign(new Error(`Docs export failed: HTTP ${r.status}`), { code: r.status });
    if (!/html/i.test(r.headers.get("content-type") ?? "")) throw Object.assign(new Error("Docs export didn't give HTML"), { code: 415 });
    return r;
  });
  const text = await res.text();
  if (text.length > 20_000_000) throw Object.assign(new Error("Docs export is too large"), { code: 413 });
  return text;
}

/** Just the document's revision id: a cheap way to notice changes made in Google Docs */
export async function getRevisionId(accessToken: string, documentId: string): Promise<string> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const doc = await withRetry(() => docs.documents.get({ documentId, fields: "revisionId" }));
  return doc.data.revisionId ?? "";
}

/**
 * One documents.get that yields everything the runner needs about the target doc: the tab it types
 * into (TabGoneError when that is gone) and, for a job typing into several, the words in `countTabs`
 */
export async function getDocSnapshot(accessToken: string, documentId: string, tabId?: string | null, countTabs?: readonly string[] | null): Promise<DocSnapshot> {
  const doc = await readDocument(accessToken, documentId);
  const open = openTab(doc, tabId);
  if (!open) throw new TabGoneError();
  // (lists aren't named: nothing a snapshot gives depends on their glyphs)
  const snap = snapshotOf(open.doc);
  return countTabs?.length ? { ...snap, tabWords: tabWordCounts(doc, countTabs) } : snap;
}

/** Words in text as a snapshot counts them: images and structure separate words */
const wordsOf = (chars: string) => {
  const words = chars.replace(/[\u0000\uFFFC]/g, " ").trim();
  return words ? words.split(/\s+/).length : 0;
};

/** Words in each of these tabs of a document read with its tabs, by id (a tab that isn't there has none) */
export function tabWordCounts(doc: docs_v1.Schema$Document, tabIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of tabIds) {
    const open = openTab(doc, id);
    if (open) out[id] = wordsOf(indexedText(open.doc));
  }
  return out;
}

/** Words in these tabs together (a job's baseline); with none, in the first tab */
export function wordsInTabs(doc: docs_v1.Schema$Document, tabIds: readonly string[]): number {
  if (!tabIds.length) {
    const open = openTab(doc);
    return open ? wordsOf(indexedText(open.doc)) : 0;
  }
  return Object.values(tabWordCounts(doc, tabIds)).reduce((a, b) => a + b, 0);
}

export function snapshotOf(data: docs_v1.Schema$Document, tailChars = 400): DocSnapshot {
  const content = data.body?.content ?? [];
  const endIndex = content.slice(-1)[0]?.endIndex ?? 1;
  let text = "";
  for (const element of content) {
    for (const el of element.paragraph?.elements ?? []) {
      if (el.textRun?.content) text += el.textRun.content;
      // An inline image or page break occupies one index, like the placeholder in our source text
      else if (el.inlineObjectElement) text += "\uFFFC";
      else if (el.pageBreak) text += "\u000C";
    }
  }
  const chars = indexedText(data);
  const wordCount = wordsOf(chars);
  // Google Docs always ends the body with a trailing newline that is not user text.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { endIndex, tail: body.slice(-tailChars), wordCount, chars, revisionId: data.revisionId ?? "" };
}

/** A Docs client whose calls give up after a while, so a slow Google never outlives a worker's lock */
function docsClient(accessToken: string) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return google.docs({ version: "v1", auth: client, timeout: 20_000 });
}

export async function deleteRange(accessToken: string, documentId: string, startIndex: number, endIndex: number, requiredRevisionId?: string, tabId?: string | null) {
  const docs = docsClient(accessToken);
  await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: inTab([{ deleteContentRange: { range: { startIndex, endIndex } } }], tabId),
        ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
      },
    })
  );
}

/**
 * Apply edits made against revision `revisionId`. Docs merges them with
 * anything collaborators changed since. Returns the revision afterwards.
 */
export async function editDocument(accessToken: string, documentId: string, requests: object[], revisionId?: string): Promise<string> {
  return (await editDocumentWithReplies(accessToken, documentId, requests, revisionId)).revisionId;
}

/** Which tab edits go to: its id, and whether it is the document's first */
export interface EditTab { id: string; first: boolean }

/** As editDocument, with each request's reply (ids of created headers, footers and footnotes) */
export async function editDocumentWithReplies(accessToken: string, documentId: string, requests: object[], revisionId?: string, tab?: EditTab | null): Promise<{ revisionId: string; replies: Record<string, unknown>[] }> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  const res = await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: inTab(requests, tab?.id, tab?.first), ...(revisionId ? { writeControl: { targetRevisionId: revisionId } } : {}) },
    })
  );
  return { revisionId: res.data.writeControl?.requiredRevisionId ?? "", replies: (res.data.replies ?? []) as Record<string, unknown>[] };
}

/** Rename a Google Doc (its Drive file name) */
export async function renameDoc(accessToken: string, documentId: string, name: string): Promise<string> {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: "v3", auth: client });
  const res = await withRetry(() => drive.files.update({ fileId: documentId, requestBody: { name }, fields: "name" }));
  return res.data.name ?? name;
}

/**
 * The document as Google lays it out: Drive's PDF export. One tab of it: Docs' own export, as
 * File > Download does it (Drive's has no way to pick a tab)
 */
export async function exportPdf(accessToken: string, documentId: string, tabId?: string | null): Promise<Uint8Array> {
  if (tabId) {
    const url = `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/export?format=pdf&tab=${encodeURIComponent(tabId)}`;
    const res = await withRetry(async () => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw Object.assign(new Error(`Docs export failed: HTTP ${r.status}`), { code: r.status });
      if (!/pdf/i.test(r.headers.get("content-type") ?? "")) throw Object.assign(new Error("Docs export didn't give a PDF"), { code: 415 });
      return r;
    });
    return new Uint8Array(await res.arrayBuffer());
  }
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: "v3", auth: client });
  const res = await withRetry(() => drive.files.export({ fileId: documentId, mimeType: "application/pdf" }, { responseType: "arraybuffer" }));
  return new Uint8Array(res.data as ArrayBuffer);
}

/**
 * Apply Docs requests in one atomic batchUpdate. With `requiredRevisionId`
 * Google refuses the batch (400) when the document changed since that
 * revision was read, so indices computed from it are never applied stale.
 */
export async function batchUpdate(accessToken: string, documentId: string, requests: object[], requiredRevisionId?: string, tabId?: string | null) {
  await batchUpdateWithReplies(accessToken, documentId, requests, { requiredRevisionId, tabId });
}

export interface BatchOptions {
  /** Refused (400) when the document moved past this revision */
  requiredRevisionId?: string;
  /** The tab the requests go to; a request that names its own tab keeps it */
  tabId?: string | null;
  /** Whether that tab is the document's first (a header or footer there is the document's own) */
  first?: boolean;
}

/** One request's reply: the ids of what it made (a tab, header, footer, footnote, image), or nothing */
export type BatchReply = docs_v1.Schema$Response & Record<string, unknown>;

/** As batchUpdate, with each request's reply, in order */
export async function batchUpdateWithReplies(accessToken: string, documentId: string, requests: object[], opts: BatchOptions = {}): Promise<BatchReply[]> {
  if (requests.length === 0) return [];
  const docs = docsClient(accessToken);
  const { requiredRevisionId, tabId, first } = opts;
  const res = await withRetry(() => docs.documents.batchUpdate({ documentId, requestBody: { requests: inTab(requests, tabId, first), ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) } }));
  return (res.data.replies ?? []) as BatchReply[];
}

/** A new tab, made as Docs makes one (blank, Google's default styles): its id */
export async function createTab(accessToken: string, documentId: string, props: { title: string; parentTabId?: string | null; index?: number; iconEmoji?: string | null }): Promise<string> {
  const tabProperties: docs_v1.Schema$TabProperties = {
    ...(props.title.trim() ? { title: props.title.trim() } : {}),
    ...(props.parentTabId ? { parentTabId: props.parentTabId } : {}),
    ...(props.index != null ? { index: props.index } : {}),
    ...(props.iconEmoji ? { iconEmoji: props.iconEmoji } : {}),
  };
  const replies = await batchUpdateWithReplies(accessToken, documentId, [{ addDocumentTab: { tabProperties } }]);
  const tabId = replies[0]?.addDocumentTab?.tabProperties?.tabId;
  if (!tabId) throw new Error("Google Docs made the tab but didn't say which it is");
  return tabId;
}

/** Give a tab another name */
export async function renameTab(accessToken: string, documentId: string, tabId: string, title: string): Promise<void> {
  await batchUpdateWithReplies(accessToken, documentId, [{ updateDocumentTabProperties: { tabProperties: { tabId, title }, fields: "title" } }]);
}

export async function insertAtIndex(
  accessToken: string,
  documentId: string,
  text: string,
  index: number,
  /** Formatting requests applied atomically with the insert */
  extraRequests: object[] = []
) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  const docs = google.docs({ version: "v1", auth: client });
  await withRetry(() =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ insertText: { location: { index }, text } }, ...extraRequests],
      },
    })
  );
  return { insertedAt: index, length: text.length };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expiry_date: number;
} | null> {
  try {
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    if (credentials.access_token) {
      return {
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
      };
    }
    return null;
  } catch (error) {
    log.warn("google.token_refresh_failed", { err: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function getUserInfo(accessToken: string) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const res = await oauth2.userinfo.get();
  return {
    id: res.data.id || "",
    name: res.data.name || "User",
    email: res.data.email || "",
    picture: res.data.picture || "",
  };
}

// ── Google Sheets ──────────────────────────────────────────────────────────

/** A Sheets client whose calls give up after a while, like the Docs one */
function sheetsClient(accessToken: string) {
  const client = getOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return google.sheets({ version: "v4", auth: client, timeout: 25_000 });
}

/** Google's own words when the Sheets API is switched off for the project the app signs in with */
export const isSheetsApiDisabled = (err: unknown): boolean => /sheets\.googleapis\.com|Google Sheets API has not been used|SERVICE_DISABLED/i.test(err instanceof Error ? err.message : String(err));

/**
 * A new, empty Google Sheet with one tab (id 0). Its locale is en_US whatever the account's is:
 * formulas and number formats are written the way an .xlsx file stores them.
 */
export async function createSpreadsheet(accessToken: string, title: string, timeZone?: string | null): Promise<{ id: string; name: string }> {
  // Never retried: a create that timed out may still have made the spreadsheet
  const res = await sheetsClient(accessToken).spreadsheets.create({
    requestBody: { properties: { title, locale: "en_US", ...(timeZone ? { timeZone } : {}) }, sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] },
    fields: "spreadsheetId,properties.title",
  });
  return { id: res.data.spreadsheetId!, name: res.data.properties?.title || title };
}

/** One atomic spreadsheets.batchUpdate */
export async function sheetsBatchUpdate(accessToken: string, spreadsheetId: string, requests: SheetsRequest[]): Promise<void> {
  if (!requests.length) return;
  const sheets = sheetsClient(accessToken);
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests as sheets_v4.Schema$Request[] } }));
}

/** The tabs, named ranges and conditional formatting a spreadsheet has (see sheets/steps.ts) */
export async function sheetsExisting(accessToken: string, spreadsheetId: string): Promise<Existing> {
  const sheets = sheetsClient(accessToken);
  const res = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties.sheetId,conditionalFormats.ranges.sheetId,rowGroups.depth,columnGroups.depth,charts.chartId),namedRanges.namedRangeId" }));
  const sheetIds = new Set<number>();
  const conditionalRules = new Map<number, number>();
  const groups = new Map<number, number>();
  const chartIds = new Set<number>();
  for (const s of res.data.sheets ?? []) {
    const id = s.properties?.sheetId ?? 0;
    sheetIds.add(id);
    conditionalRules.set(id, s.conditionalFormats?.length ?? 0);
    groups.set(id, (s.rowGroups?.length ?? 0) + (s.columnGroups?.length ?? 0));
    for (const c of s.charts ?? []) if (c.chartId != null) chartIds.add(c.chartId);
  }
  return { sheetIds, conditionalRules, groups, chartIds, namedRangeIds: new Set((res.data.namedRanges ?? []).map((n) => n.namedRangeId ?? "")) };
}
