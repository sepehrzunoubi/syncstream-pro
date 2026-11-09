/**
 * Shared test harness: a fake Google behind every `/api/*` route, a signed-in
 * cookie, the editor exposed as `window.ssEditor`, and helpers to drive it.
 *
 * Tests import `test` and `expect` from here instead of `@playwright/test`.
 */
import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { ImportedDoc } from "../src/lib/doc-import";
import { fixtureContent, fixtureDocument, tabContent, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, type Fixture } from "./fixtures/google-doc";
import type { DocTab } from "../src/lib/doc-tabs";

declare global {
  interface Window {
    ssEditor?: Editor;
  }
}

export { expect };
/** The body editor (headers, footers and footnotes are `.ss-doc` editors of their own) */
export const DOC = '.ss-doc[aria-label="Text to sync"]';
export { CLOSING_TEXT, FIXTURE_DOC_ID, FIXTURE_DOC_NAME, LONG_BODY, plainParagraphs, tabContent } from "./fixtures/google-doc";

/** One batchUpdate the editor sent to `/api/docs/edit` */
export interface EditBody {
  documentId: string;
  revisionId?: string;
  tabId?: string;
  firstTab?: boolean;
  requests: Record<string, Record<string, unknown>>[];
}

/** What `/api/sync/start` received */
export interface StartBody {
  documentId: string;
  documentName?: string;
  tabId?: string;
  revisionId?: string;
  segments?: { at: number; mode: "inline" | "before"; text: string; format: unknown }[];
  text?: string;
  context?: { doc?: unknown; ranges?: [number, number][] } | null;
  targetMinutes?: number | null;
  breaks?: "auto" | number[] | { at: number; minutes: number }[];
  typoFrequency?: number;
  seed?: number;
  startInMinutes?: number;
}

/** What `/api/sheets/start` received */
export interface SheetStartBody {
  workbook: { name: string; sheets: { id: number; name: string; cells: { r: number; c: number; v?: unknown; f?: string }[] }[] };
  name?: string;
  targetMinutes?: number | null;
  seed?: number;
  startInMinutes?: number;
  timeZone?: string;
}

/** What `/api/sync/breaks` received */
export interface BreaksBody {
  jobId: string;
  version?: number;
  breaks: { at: number; minutes: number }[];
  current?: { end: true } | { minutes: number };
}

interface Draft {
  doc?: { type: "doc"; content: Record<string, unknown>[] };
  selectedDocId?: string | null;
  selectedTabId?: string;
  durationMinutes?: number | null;
  breaksMode?: "auto" | "none" | "custom" | "manual";
  customBreaks?: number[];
  breakLength?: string;
  typoFrequency?: number;
  zoom?: number | "fit";
  pageless?: boolean;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Google, as the app sees it through its own API routes. Everything the
 * editor sends is recorded so tests can assert the exact Docs requests.
 */
export class FakeGoogle {
  readonly fixture: Fixture = fixtureDocument();
  user = { id: "user-1", name: "Test Author", email: "author@example.test", picture: "" };
  docs: { id: string; name: string; modifiedTime: string }[] = [{ id: FIXTURE_DOC_ID, name: FIXTURE_DOC_NAME, modifiedTime: new Date().toISOString() }];
  /** The body of `/api/docs/content`: the fixture document, imported like a real one */
  content: ImportedDoc = fixtureContent(this.fixture);
  revision = this.content.revisionId;
  /** The revisions returned to the editor, one per save or rename, in order */
  revisions: string[] = [];
  /** Google's own page starts (`/api/docs/pages`); none by default so the editor measures pages itself */
  pages: string[] = [];
  /**
   * How later reads of the content answer. After every save the app reads the document back to
   * compare it with what it expects; a stub can't apply Docs requests, so by default those reads
   * fail the way an unreachable Google does, and the editor keeps its own copy (which is what the
   * app does in that case). "always" serves the fixture every time, for reloads.
   */
  contentMode: "once" | "always" = "once";
  contentReads = 0;
  /** Content reads per document id ("once" counts each document's reads on its own) */
  contentReadsOf: Record<string, number> = {};
  private contentServedOf: Record<string, number> = {};
  /**
   * Other documents' content, by id (any other id reads as the fixture). New Google Doc adds a blank
   * one here; `contentDelay` holds a document's content back that long, in ms, to see it opening
   */
  contents: Record<string, ImportedDoc> = {};
  contentDelay: Record<string, number> = {};
  /** Documents that can't be read: the status their content read answers with */
  contentErrors: Record<string, number> = {};
  /** Reads of a document still to answer as a busy Google does (429, try again in a second) */
  contentBusy: Record<string, number> = {};
  /** What `/api/docs/create` received; how long it takes to answer, in ms; with `createFails`, it fails */
  creates: Record<string, unknown>[] = [];
  createDelay = 0;
  createFails = false;
  /** Drive lists a new document only after this many reads of the list (it takes a moment there too) */
  listLag = 0;
  private unlisted: { doc: { id: string; name: string; modifiedTime: string }; reads: number }[] = [];
  /**
   * The document's tabs, when it has them: the first is `content`, the others' content is in
   * `tabContents`. Each content read records the tab asked for (null: none).
   */
  tabs: DocTab[] | null = null;
  tabContents: Record<string, ImportedDoc> = {};
  contentTabs: (string | null)[] = [];
  pageTabs: (string | null)[] = [];
  edits: EditBody[] = [];
  renames: { documentId: string; name: string }[] = [];
  starts: StartBody[] = [];
  /** What `/api/sheets/start` received; with `sheetStartFailure`, it answers with that instead */
  sheetStarts: SheetStartBody[] = [];
  sheetStartFailure: { status: number; error: string } | null = null;
  /** The sync history `/api/history` lists, and the ids it was asked to forget ("*": all of it) */
  history: Record<string, unknown>[] = [];
  historyRemoved: string[] = [];
  breakEdits: BreaksBody[] = [];
  jobs: Record<string, unknown>[] = [];
  /** Images uploaded (their data URLs); with `imagesFail`, the upload route answers with an error */
  uploads: string[] = [];
  imagesFail = false;
  /** Uploads answered with an error */
  imageFailures = 0;
  /** How long the upload route takes to answer, in ms */
  imageDelay = 0;
  /** Uploads still to answer as the route does when a user has sent too many (429, try again in a second) */
  imagesTooMany = 0;
  /** Uploads answered with 429, and the most the route had in hand at once */
  imageRefusals = 0;
  imagesAtOnce = 0;
  private imagesNow = 0;
  /** How long starting a sync takes, in ms; with `startFailure`, the start route answers with it */
  startDelay = 0;
  startFailure: { status: number; error: string } | null = null;
  /** Calls to API routes this fake doesn't know: always a bug in the test or the app */
  unexpected: string[] = [];

  /** Every Docs request sent so far, in order, optionally only those of one kind */
  requests(kind?: string): Record<string, unknown>[] {
    const all = this.edits.flatMap((e) => e.requests);
    return kind ? all.filter((r) => kind in r).map((r) => r[kind]) : all;
  }

  /** The kinds of request sent so far, e.g. ["updateTextStyle", "deleteContentRange"] */
  kinds(): string[] {
    return this.requests().map((r) => Object.keys(r)[0]);
  }

  private nextRevision(): string {
    this.revision = `fixture-rev-${this.revisions.length + 2}`;
    this.revisions.push(this.revision);
    return this.revision;
  }

  async install(page: Page): Promise<void> {
    // Google Fonts aren't reachable from the test runner; failing fast keeps page loads quick
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.route(/\/api\//, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const body = () => (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      switch (path) {
        case "/api/auth/me":
          return json(route, { authenticated: true, user: this.user });
        case "/api/auth/logout":
          return json(route, { ok: true });
        case "/api/docs":
          // Documents made a moment ago show up after a few reads, as in Drive
          for (const u of this.unlisted) if (++u.reads > this.listLag) this.docs = [u.doc, ...this.docs.filter((d) => d.id !== u.doc.id)];
          this.unlisted = this.unlisted.filter((u) => u.reads <= this.listLag);
          return json(route, { docs: this.docs });
        case "/api/docs/create": {
          const b = body();
          this.creates.push(b);
          if (this.createDelay) await new Promise((r) => setTimeout(r, this.createDelay));
          if (this.createFails) return json(route, { error: "Couldn't create the document. Try again." }, 502);
          const name = typeof b.title === "string" && b.title.trim() ? b.title.trim() : "Untitled document";
          const doc = { id: `new-doc-${this.creates.length}-e2e0000000`, name, modifiedTime: new Date().toISOString() };
          this.contents[doc.id] = { ...tabContent([""]), revisionId: `${doc.id}-rev-1` };
          if (this.listLag > 0) this.unlisted.push({ doc, reads: 0 });
          else this.docs = [doc, ...this.docs];
          return json(route, { id: doc.id, name });
        }
        case "/api/docs/content": {
          this.contentReads += 1;
          const id = url.searchParams.get("id") ?? "";
          this.contentReadsOf[id] = (this.contentReadsOf[id] ?? 0) + 1;
          const asked = url.searchParams.get("tab");
          this.contentTabs.push(asked);
          if (this.contentDelay[id]) await new Promise((r) => setTimeout(r, this.contentDelay[id]));
          if (this.contentErrors[id]) return json(route, { error: "That document could not be found." }, this.contentErrors[id]);
          if (this.contentBusy[id] > 0) {
            this.contentBusy[id]--;
            return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "1" }, body: JSON.stringify({ error: "Too many requests. Try again in 1 second.", code: "rate_limited" }) });
          }
          // "once": the first answer with the content is the only one (a busy answer gave none)
          const served = (this.contentServedOf[id] = (this.contentServedOf[id] ?? 0) + 1);
          if (this.contentMode === "once" && served > 1) return json(route, { error: "Couldn't load this document" }, 502);
          const other = this.contents[id];
          if (other) return json(route, { ...other, revisionId: other.revisionId });
          if (!this.tabs) return json(route, { ...this.content, revisionId: this.revision });
          const tab = this.tabs.find((t) => t.id === asked) ?? this.tabs[0];
          const content = tab === this.tabs[0] ? this.content : this.tabContents[tab.id];
          return json(route, { ...content, revisionId: this.revision, tabs: this.tabs, tabId: tab.id, ...(asked && tab.id !== asked ? { tabGone: true } : {}) });
        }
        case "/api/docs/revision":
          return json(route, { revisionId: this.revision });
        case "/api/docs/pages":
          this.pageTabs.push(url.searchParams.get("tab"));
          return json(route, { pages: this.pages });
        case "/api/docs/edit": {
          const b = body() as unknown as EditBody;
          this.edits.push(b);
          return json(route, { revisionId: this.nextRevision(), replies: b.requests.map(() => ({})) });
        }
        case "/api/images": {
          this.imagesAtOnce = Math.max(this.imagesAtOnce, ++this.imagesNow);
          if (this.imageDelay) await new Promise((r) => setTimeout(r, this.imageDelay));
          this.imagesNow--;
          if (this.imagesTooMany > 0) {
            this.imagesTooMany--;
            this.imageRefusals++;
            return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "1" }, body: JSON.stringify({ error: "Too many requests. Try again in 1 second.", code: "rate_limited" }) });
          }
          if (this.imagesFail) { this.imageFailures++; return json(route, { error: "Image storage is unavailable" }, 503); }
          this.uploads.push(String(body().dataUrl ?? ""));
          return json(route, { url: `https://images.e2e.test/img/${this.uploads.length}.png` });
        }
        case "/api/docs/rename": {
          const b = body() as { documentId: string; name: string };
          this.renames.push(b);
          this.docs = this.docs.map((d) => (d.id === b.documentId ? { ...d, name: b.name } : d));
          return json(route, { name: b.name });
        }
        case "/api/sync/list":
          return json(route, { jobs: this.jobs, now: Date.now() });
        case "/api/sync/start": {
          if (this.startDelay) await new Promise((r) => setTimeout(r, this.startDelay));
          const b = body() as unknown as StartBody;
          this.starts.push(b);
          if (this.startFailure) return json(route, { error: this.startFailure.error }, this.startFailure.status);
          const text = b.segments ? b.segments.map((s) => s.text).join("") : b.text ?? "";
          const now = Date.now();
          const job = {
            id: `sync_${this.starts.length}`,
            userId: this.user.id,
            documentId: b.documentId,
            documentName: b.documentName ?? "Untitled document",
            ...(b.tabId ? { tabId: b.tabId, tabTitle: this.tabs?.find((t) => t.id === b.tabId)?.title } : {}),
            status: "running",
            createdAt: now,
            startAt: now,
            startedAt: now,
            currentAction: 0,
            totalActions: 20,
            charsSent: 0,
            totalChars: text.length,
            typoSubStep: 0,
            typoCharsInDoc: 0,
            generation: 0,
            failures: 0,
            activity: "Typing",
            etaTargetAt: now + 10 * 60_000,
            nextActionAt: now + 3000,
            wpm: 32,
            baselineWordCount: 0,
            breaks: [],
            completedBreaks: [],
            lastUpdate: now,
            sourceText: text,
            context: b.context ?? null,
          };
          this.jobs = [job, ...this.jobs];
          return json(route, { job });
        }
        case "/api/sync/source": {
          const job = this.jobs.find((j) => j.id === url.searchParams.get("jobId"));
          if (!job) return json(route, { error: "Not found" }, 404);
          return json(route, { sourceText: job.sourceText, format: null, context: job.context });
        }
        case "/api/sync/pause":
        case "/api/sync/resume":
        case "/api/sync/cancel": {
          const id = body().jobId;
          const status = path.endsWith("pause") ? "paused" : path.endsWith("resume") ? "running" : "cancelled";
          this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, status, lastUpdate: Date.now() } : j));
          return json(route, { job: this.jobs.find((j) => j.id === id) });
        }
        case "/api/sync/breaks": {
          // Like the server: the breaks ahead are replaced, the ones before editableFrom kept
          const b = body() as unknown as BreaksBody;
          this.breakEdits.push(b);
          const job = this.jobs.find((j) => j.id === b.jobId) as Record<string, unknown> | undefined;
          if (!job) return json(route, { error: "Job not found" }, 404);
          if ((b.version ?? 0) !== ((job.breaksVersion as number | undefined) ?? 0)) return json(route, { error: "The breaks were changed somewhere else. Check them and try again." }, 409);
          const from = (job.editableFrom as number | undefined) ?? 0;
          const at = (job.breakAt as number[] | undefined) ?? [];
          const mins = (job.breaks as number[] | undefined) ?? [];
          const kept = at.map((a, i) => ({ at: a, minutes: mins[i] })).filter((x) => x.at < from);
          const all = [...kept, ...b.breaks].sort((x, y) => x.at - y.at);
          const next = { ...job, breakAt: all.map((x) => x.at), breaks: all.map((x) => x.minutes), breaksVersion: ((job.breaksVersion as number | undefined) ?? 0) + 1 };
          this.jobs = this.jobs.map((j) => (j.id === b.jobId ? next : j));
          return json(route, { job: next, applied: true });
        }
        case "/api/sync/dismiss":
          this.jobs = this.jobs.filter((j) => j.id !== body().jobId);
          return json(route, { ok: true });
        case "/api/sheets/start": {
          const b = body() as unknown as SheetStartBody;
          this.sheetStarts.push(b);
          if (this.sheetStartFailure) return json(route, { error: this.sheetStartFailure.error }, this.sheetStartFailure.status);
          const now = Date.now();
          const job = {
            id: `sheet_${this.sheetStarts.length}`, userId: this.user.id, kind: "sheet", documentId: `spreadsheet-${this.sheetStarts.length}`, documentName: b.name ?? "Untitled spreadsheet",
            status: b.startInMinutes ? "scheduled" : "running", createdAt: now, startAt: now + (b.startInMinutes ?? 0) * 60_000, startedAt: now,
            currentAction: 0, totalActions: 100, charsSent: 0, totalChars: 1000, typoSubStep: 0, typoCharsInDoc: 0, generation: 0, failures: 0,
            activity: "Naming the tab", etaTargetAt: now + 600_000, wpm: 0, baselineWordCount: 0, breaks: [], completedBreaks: [], lastUpdate: now,
          };
          this.jobs = [job, ...this.jobs];
          return json(route, { job, totalMs: 600_000, seed: b.seed ?? 1, fitsTarget: true });
        }
        case "/api/sheets/source":
          return json(route, { error: "This sync's spreadsheet is no longer stored." }, 404);
        case "/api/history": {
          if (method === "DELETE") {
            const b = body() as { id?: string; all?: boolean };
            this.historyRemoved.push(b.all ? "*" : String(b.id));
            this.history = b.all ? [] : this.history.filter((e) => e.id !== b.id);
            return json(route, { ok: true });
          }
          return json(route, { entries: this.history, now: Date.now() });
        }
        default:
          this.unexpected.push(`${method} ${path}`);
          return json(route, { error: `e2e: no fake for ${method} ${path}` }, 404);
      }
    });
  }
}

/** A paragraph as the page shows it */
export interface ParagraphView {
  text: string;
  style: string;
  list: string | null;
  level: number;
  label: string | null;
  align: string;
}

/** Drives the dashboard through the real editor (`window.ssEditor`) */
export class App {
  constructor(readonly page: Page, readonly api: FakeGoogle) {}

  /** The body editor */
  get doc() {
    return this.page.locator(DOC);
  }

  /**
   * Open the dashboard. By default the fixture document is selected; `plain` instead opens a
   * draft typed without a document (nothing to save, everything pending), as the pagination
   * tests want.
   */
  /** `named: false` opens a document that doesn't start with the fixture's name (an empty one) */
  async open(opts: { draft?: Draft; plain?: Record<string, unknown>[]; named?: boolean } = {}): Promise<void> {
    const draft: Draft = { selectedDocId: FIXTURE_DOC_ID, breaksMode: "auto", durationMinutes: 60, ...opts.draft };
    if (opts.plain) {
      this.api.docs = [];
      draft.doc = { type: "doc", content: opts.plain };
      draft.selectedDocId = null;
    }
    await this.page.context().addCookies([{ name: "google_access_token", value: "e2e-token", domain: "localhost", path: "/" }]);
    await this.api.install(this.page);
    await this.page.addInitScript((d: Draft) => {
      localStorage.setItem("ss_debug", "1");
      localStorage.setItem("syncstream_draft_v2", JSON.stringify(d));
    }, draft);
    await this.page.goto("/dashboard");
    await this.doc.locator("p").first().waitFor();
    if (opts.plain) {
      await expect(this.doc).toContainText((opts.plain[0] as { content?: { text?: string }[] }).content?.[0]?.text ?? "");
    } else {
      // The document is in: its paragraphs are on the page and the editor glows new text
      await expect(this.page.locator(`${DOC}.ss-glow`)).toBeAttached();
      if (opts.named !== false) await expect(this.doc).toContainText(FIXTURE_DOC_NAME);
      await expect(this.subtitle()).toContainText(/Edits save to Google Docs|New text glows/);
    }
    await this.page.waitForFunction(() => !!window.ssEditor);
  }

  /** The line under the document name: what the workspace is doing */
  subtitle() {
    return this.page.locator("header [data-ss-status-text]").first();
  }

  /** The editor's document as JSON */
  json(): Promise<Record<string, unknown>> {
    return this.page.evaluate(() => window.ssEditor!.getJSON() as Record<string, unknown>);
  }

  /** All text in the editor, paragraphs joined with newlines */
  text(): Promise<string> {
    return this.page.evaluate(() => window.ssEditor!.state.doc.textBetween(0, window.ssEditor!.state.doc.content.size, "\n", "￼"));
  }

  /** The top-level paragraphs as the page renders them */
  paragraphs(): Promise<ParagraphView[]> {
    return this.page.evaluate((sel) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${sel} > p`)).map((p) => ({
        text: p.textContent ?? "",
        style: p.dataset.style ?? "normal",
        list: p.dataset.list ?? null,
        level: Number(p.dataset.level ?? 0),
        label: p.dataset.label ?? null,
        align: getComputedStyle(p).textAlign,
      })), DOC
    );
  }

  /** The glowing (pending) text, in document order */
  pending(): Promise<string[]> {
    return this.page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .ss-add`)).map((e) => e.textContent ?? ""), DOC);
  }

  /** Where `text` first occurs: editor positions of the match and of its paragraph's content */
  locate(text: string): Promise<{ from: number; to: number; paraStart: number; paraEnd: number }> {
    return this.page.evaluate((needle) => {
      const ed = window.ssEditor!;
      let found: { from: number; to: number; paraStart: number; paraEnd: number } | null = null;
      ed.state.doc.descendants((node, pos) => {
        if (found || !node.isTextblock) return !found;
        const t = node.textBetween(0, node.content.size, "", "￼");
        const i = t.indexOf(needle);
        if (i >= 0) found = { from: pos + 1 + i, to: pos + 1 + i + needle.length, paraStart: pos + 1, paraEnd: pos + 1 + node.content.size };
        return false;
      });
      if (!found) throw new Error(`"${needle}" is not in the document`);
      return found;
    }, text);
  }

  /** Put the caret right after the first occurrence of `text` and focus the editor */
  async caretAfter(text: string): Promise<void> {
    const { to } = await this.locate(text);
    await this.setSelection(to, to);
  }

  /** Put the caret right before the first occurrence of `text` */
  async caretBefore(text: string): Promise<void> {
    const { from } = await this.locate(text);
    await this.setSelection(from, from);
  }

  /** Put the caret at the end of the paragraph that contains `text` */
  async caretAtEnd(text: string): Promise<void> {
    const { paraEnd } = await this.locate(text);
    await this.setSelection(paraEnd, paraEnd);
  }

  /** Select the first occurrence of `text` */
  async select(text: string): Promise<void> {
    const { from, to } = await this.locate(text);
    await this.setSelection(from, to);
  }

  /** Select the whole paragraph that contains `text` */
  async selectParagraph(text: string): Promise<void> {
    const { paraStart, paraEnd } = await this.locate(text);
    await this.setSelection(paraStart, paraEnd);
  }

  async setSelection(from: number, to: number): Promise<void> {
    await this.page.evaluate(([f, t]) => { window.ssEditor!.chain().focus().setTextSelection({ from: f, to: t }).run(); }, [from, to]);
    await expect.poll(() => this.page.evaluate(() => window.ssEditor!.isFocused)).toBe(true);
  }

  /** Paste into the editor at the current selection, as the clipboard would (HTML and/or plain text) */
  async paste(data: { html?: string; text: string; slice?: string }): Promise<void> {
    await this.page.evaluate(({ html, text, slice, sel }) => {
      const dt = new DataTransfer();
      // Google Docs' own copy of the selection, as Chrome hands it to the page
      if (slice) dt.setData("application/x-vnd.google-docs-document-slice-clip+wrapped", slice);
      if (html) dt.setData("text/html", html);
      dt.setData("text/plain", text);
      document.querySelector(sel)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { ...data, sel: DOC });
  }

  /** Number of page sheets drawn behind the text */
  sheets(): Promise<number> {
    return this.page.locator(".ss-sheet").count();
  }

  /** Open a top menu and choose an item */
  async menu(top: string, item: string): Promise<void> {
    await this.page.locator(".ss-menubar-trigger", { hasText: top }).click();
    // An item's accessible name includes its shortcut, so match the label itself
    await this.page.getByRole("menuitem").filter({ has: this.page.getByText(item, { exact: true }) }).click();
  }

  /** The Docs requests the editor saves; waits until at least `atLeast` batches were sent */
  async waitForSave(atLeast = 1): Promise<void> {
    await expect.poll(() => this.api.edits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(atLeast);
  }
}

export const test = base.extend<{ api: FakeGoogle; app: App }>({
  api: async ({}, provide) => { // eslint-disable-line no-empty-pattern
    await provide(new FakeGoogle());
  },
  app: async ({ page, api }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await provide(new App(page, api));
    expect(errors, "no uncaught errors in the page").toEqual([]);
    expect(api.unexpected, "every API call had a fake").toEqual([]);
  },
});
