"use client";

/**
 * Import PDF: a PDF is read on the server (/api/pdf/import) into editor
 * content, then put on the page as new text, glowing, for a sync to type in
 * like anything else typed or pasted. A blank document takes it straight
 * away, with the PDF's page size and margins and its header and footer; a
 * document with content gets a new Google Doc for it, or takes it at its
 * end, or has its content replaced.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { groupColumns, PENDING_MARK, segmentEdits, tokenize } from "@/lib/doc-model";
import { PAPERS, parsePageSetup, type PageSetup, type PaperId } from "@/lib/page-setup";
import type { EditorNode } from "@/lib/rich-text";
// (types only: the reader itself never reaches the browser)
import type { PdfImportBody } from "@/lib/pdf-route";
import { LOAD_META, loadDocument } from "./doc-sync";
import { sanitize, withoutMark } from "./doc-json";
import { postJson } from "./api";
import { tabFields, type DocContent, type DocRefs, type Setter } from "./doc-state";
import type { Segments } from "./use-header-footers";

export type { PdfImportBody };

/** The largest PDF that can be imported (the route's MAX_PDF_BYTES) */
export const MAX_PDF_BYTES = 4 * 1024 * 1024;
/** The route gives up at 60 s; this is a little longer, for the upload */
const CLIENT_TIMEOUT_MS = 75_000;
/** The snackbar after an import, which offers Undo while nothing else has changed */
export const PDF_IMPORTED = "PDF imported. Check it over, then start the sync.";

/** What the dialog shows while the PDF is read, in order */
export const READ_STEPS = ["Uploading", "Reading text and fonts", "Rebuilding the layout", "Copying images"] as const;

/** Where the PDF goes in a document that already has content */
export type Destination = "new" | "append" | "replace";

export interface PdfFile { name: string; size: number }

export type PdfStage =
  | { kind: "pick"; error?: string }
  | { kind: "reading"; file: PdfFile; step: number; sent: number }
  | { kind: "result"; file: PdfFile; result: PdfImportBody; choice: Destination; confirming: boolean; error?: string }
  | { kind: "applying"; file: PdfFile; text: string; cancelable?: boolean };

// ── Pure helpers (tested in use-pdf-import.test.ts) ─────────────────────────

/** Nothing on the page but empty paragraphs: no text, new or old, no images, tables or breaks */
export function isBlankDoc(doc: EditorNode | JSONContent | null | undefined): boolean {
  return !!doc && tokenize(doc as EditorNode).every((t) => t.k === "nl");
}

const flat = (blocks: EditorNode[]): EditorNode[] => blocks.flatMap((b) => (b.type === "columnSection" ? flat(b.content ?? []) : [b]));
const EMPTY_PARAGRAPH: EditorNode = { type: "paragraph", attrs: {}, content: [] };

/**
 * Docs has a paragraph before every table: one it makes, if there is none. A PDF that starts with a
 * table, put at the start of a document (or after a block kept there), starts with that empty line,
 * as Docs will have it; else the save would try to take Docs' line out again, and Docs refuses.
 */
const lineBeforeTable = (nodes: EditorNode[]): EditorNode[] => (nodes[0]?.type === "table" ? [EMPTY_PARAGRAPH, ...nodes] : nodes);

/** A blank document with the PDF's content */
export function blankWithPdf(nodes: EditorNode[]): EditorNode {
  return { type: "doc", content: groupColumns(lineBeforeTable(nodes)) };
}

/** The document with the PDF's content after what it has (in its last section) */
export function appendPdf(doc: EditorNode, nodes: EditorNode[]): EditorNode {
  return { type: "doc", content: groupColumns([...(doc.content ?? []), ...nodes]) };
}

/**
 * The PDF's content in place of the document's. What the page can't change (section breaks, smart
 * chips, a table of contents) stays, each after an empty paragraph as Docs needs it; everything else
 * goes, and the save deletes it from the Google Doc. Kept blocks that were next to each other (the
 * entries of a table of contents, smart chips one after another) stay next to each other: Docs had
 * them so, and a paragraph between them would be a new one.
 */
export function replaceWithPdf(doc: EditorNode, nodes: EditorNode[]): EditorNode {
  const kept: EditorNode[] = [];
  let before: EditorNode | null = null;
  for (const b of flat(doc.content ?? [])) {
    if (!b.attrs?.locked) {
      before = b;
      continue;
    }
    const first = b.attrs?.kind === "section" && b.attrs?.first === true;
    if (!first && before) {
      // The paragraph before it, emptied (it keeps its style, so nothing else about it changes)
      kept.push(before.type === "paragraph" ? { ...before, content: [] } : EMPTY_PARAGRAPH);
    }
    kept.push(b);
    before = null;
  }
  return { type: "doc", content: groupColumns([...kept, ...lineBeforeTable(nodes)]) };
}

/** A header's or footer's content as it is saved: written straight to the new segment */
export function segmentRequests(nodes: EditorNode[], segmentId: string): Record<string, unknown>[] {
  return segmentEdits({ type: "doc", content: [EMPTY_PARAGRAPH] }, { type: "doc", content: nodes }, segmentId).requests;
}

/** The new document's name: the file's, without ".pdf" */
export function pdfTitle(fileName: string): string {
  const name = fileName.replace(/\.pdf$/i, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return name || "Imported PDF";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "12 pages · 3 headings · 48 paragraphs · 2 tables · 5 images" */
export function summaryLine(r: Pick<PdfImportBody, "pages" | "stats">): string {
  const s = r.stats;
  const parts = [plural(r.pages, "page")];
  if (s.headings) parts.push(plural(s.headings, "heading"));
  if (s.paragraphs) parts.push(plural(s.paragraphs, "paragraph"));
  if (s.listItems) parts.push(plural(s.listItems, "list item"));
  if (s.tables) parts.push(plural(s.tables, "table"));
  if (s.images) parts.push(plural(s.images, "image"));
  return parts.join(" · ");
}

const METRIC = new Set<PaperId>(["a3", "a4", "a5", "b4", "b5"]);

/** "Letter · 1 in margins", "A4 · 2 cm top and bottom, 2.5 cm sides", "Letter, landscape · top 1, bottom 1, left 0.5, right 0.75 in" */
export function pageLabel(s: PageSetup): string {
  const metric = s.custom ? false : METRIC.has(s.paper);
  const unit = (pt: number) => (metric ? Math.round((pt / 72) * 25.4) / 10 : Math.round((pt / 72) * 100) / 100);
  const u = metric ? "cm" : "in";
  const size = s.custom ? `${unit(s.custom.w)} × ${unit(s.custom.h)} ${u}` : PAPERS[s.paper].label.replace(/\s*\(.*\)$/, "");
  const m = s.margins;
  const margins = m.top === m.bottom && m.left === m.right
    ? m.top === m.left ? `${unit(m.top)} ${u} margins` : `${unit(m.top)} ${u} top and bottom, ${unit(m.left)} ${u} sides`
    : `top ${unit(m.top)}, bottom ${unit(m.bottom)}, left ${unit(m.left)}, right ${unit(m.right)} ${u}`;
  return `${size}${s.orientation === "landscape" ? ", landscape" : ""} · ${margins}`;
}

/** "2.4 MB", "380 KB" */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why a file can't be sent, before it is: not a PDF, or too large */
export function checkFile(file: { name: string; type: string; size: number }): string | null {
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!pdf) return "That isn't a PDF. Choose a file whose name ends in .pdf.";
  if (file.size > MAX_PDF_BYTES) return `This PDF is ${fileSize(file.size)}. You can import a PDF of up to 4 MB: make it smaller (for example by saving it again with smaller images), or split it.`;
  if (!file.size) return "This file is empty.";
  return null;
}

/** What a failed upload says, by its status and the route's answer */
export function failureMessage(status: number, body: unknown): string {
  const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  if (status === 0) return "You're offline, or SyncStream can't be reached. Check your connection, then try again.";
  if (status === 401) return "Your Google sign-in expired. Choose Reconnect Google account in the account menu, then import the PDF again.";
  if (status === 413) return "This PDF is over 4 MB, the most you can import. Make it smaller (for example by saving it again with smaller images), or split it, then import it again.";
  if (status === 429) return `You've imported several PDFs in a short time. ${error.replace(/^Too many requests\.\s*/, "") || "Try again in a minute."}`;
  if (status === 504 && !error) return "This PDF took too long to read. Try again, or import a shorter part of it.";
  return error || "Couldn't import this PDF. Try again.";
}

/** The route's answer, checked: null when it isn't one */
export function parseResult(body: unknown): PdfImportBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<PdfImportBody>;
  const pageSetup = parsePageSetup(b.pageSetup);
  if (!Array.isArray(b.nodes) || !b.nodes.length || !pageSetup || typeof b.pages !== "number" || !b.stats || typeof b.stats !== "object") return null;
  const nodes = (list: unknown) => (Array.isArray(list) && list.length ? (list as EditorNode[]) : undefined);
  const st = b.stats as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    nodes: b.nodes,
    pageSetup,
    ...(nodes(b.header) ? { header: nodes(b.header) } : {}),
    ...(nodes(b.footer) ? { footer: nodes(b.footer) } : {}),
    fonts: Array.isArray(b.fonts) ? b.fonts.filter((f): f is string => typeof f === "string") : [],
    pages: b.pages,
    tagged: b.tagged === true,
    warnings: Array.isArray(b.warnings) ? b.warnings.filter((w): w is string => typeof w === "string") : [],
    stats: { paragraphs: count(st.paragraphs), headings: count(st.headings), listItems: count(st.listItems), tables: count(st.tables), images: count(st.images), links: count(st.links) },
  };
}

/** POST the file, reporting the upload's progress; never throws (status 0: no answer, -1: cancelled) */
function send(file: File, signal: AbortSignal, onSent: (fraction: number) => void, onUploaded: () => void): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/pdf/import");
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.timeout = CLIENT_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onSent(e.loaded / e.total); };
    xhr.upload.onload = () => onUploaded();
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON: a proxy's page */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: null });
    xhr.ontimeout = () => resolve({ status: 504, body: null });
    xhr.onabort = () => resolve({ status: -1, body: null });
    if (signal.aborted) { resolve({ status: -1, body: null }); return; }
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** What Undo puts back: the page as it was, and for a blank page its setup, and the header and footer made */
interface UndoState {
  key: string;
  mode: "blank" | "append";
  before: EditorNode;
  setup: PageSetup;
  pageless: boolean;
  created: { header?: string; footer?: string };
}

export function usePdfImport({ editor, refs, docContent, selectedDocId, docKey, docJSON, setDocJSON, setSnack, setScopeError, saveNow, pageSetup, pageless, applyPageSetup, hasHeader, hasFooter, setSegments, createDoc, blocked }: {
  editor: Editor | null;
  refs: DocRefs;
  docContent: DocContent | null;
  selectedDocId: string;
  /** The document and tab on the page */
  docKey: string;
  docJSON: JSONContent | null;
  setDocJSON: Setter<JSONContent | null>;
  setSnack: Setter<string | null>;
  setScopeError: Setter<boolean>;
  saveNow: () => Promise<boolean>;
  pageSetup: PageSetup;
  pageless: boolean;
  /** Page setup as the dialog applies it: shown here and written to the Google Doc; false when Google Docs refused it */
  applyPageSetup: (setup: PageSetup, pageless: boolean) => Promise<boolean>;
  /** The document has a header (footer) already: the PDF's isn't added then */
  hasHeader: boolean;
  hasFooter: boolean;
  setSegments: Setter<Segments>;
  /** Make a Google Doc and open it; its id, or null when it couldn't be made (it says why) */
  createDoc: (title?: string) => Promise<string | null>;
  /** What keeps a PDF from going onto the page now */
  blocked: { focusedJob: boolean; docBusy: boolean; docLoading: boolean; startingSync: boolean; creatingDoc: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PdfStage>({ kind: "pick" });
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  /** The new Google Doc being made for the PDF, until it is open on the page */
  const pendingNew = useRef<{ docId: string; file: PdfFile; result: PdfImportBody } | null>(null);
  const undoRef = useRef<UndoState | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  // What the callbacks below read when they run (a step may wait on Google in between)
  const latest = useRef({ applyPageSetup, saveNow, pageSetup, pageless, hasHeader, hasFooter, docKey, docBusy: blocked.docBusy });
  latest.current = { applyPageSetup, saveNow, pageSetup, pageless, hasHeader, hasFooter, docKey, docBusy: blocked.docBusy };

  const ready = docContent?.status === "ready" && docContent.docId === selectedDocId;
  const disabledReason = !selectedDocId
    ? "Open or make a Google Doc first"
    : blocked.focusedJob
      ? "Go back to editing first"
      : blocked.docBusy
        ? "A sync is typing into this document. You can import a PDF when it finishes."
        : blocked.docLoading || docContent?.status === "loading"
          ? "The document is still opening"
          : !ready
            ? "This document couldn't be opened"
            : blocked.startingSync
              ? "A sync is starting"
              : blocked.creatingDoc
                ? "A new document is being made"
                : null;

  const blank = useMemo(() => (open && stage.kind === "result" ? isBlankDoc(docJSON ?? editor?.getJSON()) : false), [open, stage.kind, docJSON, editor]);

  // A page with nothing on it (a doc just made): the panel offers the PDF up front, else in a line
  const [pageBlank, setPageBlank] = useState(false);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !ready) { setPageBlank(false); return; }
    // (anything past a few empty lines isn't blank: no need to read a long document on every key)
    const check = () => setPageBlank(!editor.isDestroyed && editor.state.doc.content.size <= 64 && isBlankDoc(editor.getJSON()));
    check();
    editor.on("update", check);
    return () => { editor.off("update", check); };
  }, [editor, ready, docKey, docJSON]);

  const openDialog = useCallback(() => {
    if (disabledReason) return;
    setStage({ kind: "pick" });
    setOpen(true);
  }, [disabledReason]);

  const stop = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const stageRef = useRef(stage);
  stageRef.current = stage;
  // (the same function throughout: the dialog's focus handling starts over when it changes)
  const close = useCallback(() => {
    const s = stageRef.current;
    if (s.kind === "applying" && !s.cancelable) return; // half done: it finishes first
    stop();
    pendingNew.current = null;
    setOpen(false);
  }, [stop]);

  /** Back to choosing a file, nothing changed */
  const cancelReading = useCallback(() => { stop(); setStage({ kind: "pick" }); }, [stop]);

  const pick = useCallback(async (file: File) => {
    const problem = checkFile(file);
    if (problem) { setStage({ kind: "pick", error: problem }); return; }
    stop();
    const run = runRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const info: PdfFile = { name: file.name, size: file.size };
    setStage({ kind: "reading", file: info, step: 0, sent: 0 });
    const step = (n: number, sent?: number) => setStage((s) => (s.kind === "reading" && runRef.current === run && n >= s.step ? { ...s, step: n, sent: sent ?? s.sent } : s));
    // Some browsers and proxies never say how the upload goes: a PDF this small is up by then
    let heard = false;
    const assume = setTimeout(() => { if (!heard) step(1, 1); }, 1500);
    const { status, body } = await send(file, ctrl.signal, (f) => { heard = true; step(f >= 1 ? 1 : 0, f); }, () => step(1, 1));
    clearTimeout(assume);
    if (runRef.current !== run || status === -1) return;
    abortRef.current = null;
    const result = status === 200 ? parseResult(body) : null;
    if (!result) {
      if (status === 401) setScopeError(true);
      setStage({ kind: "pick", error: status === 200 ? "Couldn't import this PDF. Try again." : failureMessage(status, body) });
      return;
    }
    setStage({ kind: "result", file: info, result, choice: "new", confirming: false });
  }, [stop, setScopeError]);

  // The server's own steps can't be seen from here: after the upload, the text says what it is doing
  // in the order it does it, at the pace a PDF this size usually takes, and waits on the last one
  const readingStep = stage.kind === "reading" ? stage.step : -1;
  const readingSize = stage.kind === "reading" ? stage.file.size : 0;
  useEffect(() => {
    if (readingStep < 1 || readingStep >= READ_STEPS.length - 1) return;
    const ms = readingStep === 1 ? 900 + readingSize / 4000 : 1600 + readingSize / 2500;
    const id = setTimeout(() => setStage((s) => (s.kind === "reading" && s.step === readingStep ? { ...s, step: s.step + 1 } : s)), Math.min(ms, 6000));
    return () => clearTimeout(id);
  }, [readingStep, readingSize]);

  const choose = useCallback((choice: Destination) => setStage((s) => (s.kind === "result" ? { ...s, choice, confirming: false, error: undefined } : s)), []);
  const confirmReplace = useCallback((on: boolean) => setStage((s) => (s.kind === "result" ? { ...s, confirming: on } : s)), []);

  // Undo is for the page as the import left it: an edit, or another document or tab, ends it
  useEffect(() => {
    if (!editor) return;
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (undoRef.current && transaction.docChanged && !transaction.getMeta(LOAD_META)) { undoRef.current = null; setCanUndo(false); }
    };
    editor.on("transaction", onTr);
    return () => { editor.off("transaction", onTr); };
  }, [editor]);
  useEffect(() => { if (undoRef.current && undoRef.current.key !== docKey) { undoRef.current = null; setCanUndo(false); } }, [docKey]);

  /** Show `doc` on the page as the document plus new text; false when the editor can't take it */
  const show = useCallback((doc: EditorNode): boolean => {
    if (!editor) return false;
    try {
      loadDocument(editor, doc, true);
    } catch (err) {
      console.error("The editor couldn't take the imported PDF as it is:", err);
      const clean = sanitize(doc);
      try { if (!clean) return false; loadDocument(editor, clean, true); } catch { return false; }
    }
    setDocJSON(editor.getJSON());
    return true;
  }, [editor, setDocJSON]);

  /** A header and footer like the PDF's, where the document has none: made and filled in Google Docs now */
  const addSegments = useCallback(async (r: PdfImportBody, content: DocContent): Promise<{ created: UndoState["created"]; failed: boolean }> => {
    const created: UndoState["created"] = {};
    let failed = false;
    for (const which of ["header", "footer"] as const) {
      const nodes = r[which];
      if (!nodes?.length || (which === "header" ? latest.current.hasHeader : latest.current.hasFooter)) continue;
      await latest.current.saveNow();
      const make = which === "header" ? { createHeader: { type: "DEFAULT" } } : { createFooter: { type: "DEFAULT" } };
      type Reply = { createHeader?: { headerId?: string }; createFooter?: { footerId?: string } };
      const made = await postJson<{ revisionId?: string; replies?: Reply[] }>("/api/docs/edit", { documentId: content.docId, revisionId: refs.revisionRef.current, requests: [make], ...tabFields(content) });
      if (made.status === 401) setScopeError(true);
      const id = made.data.replies?.[0]?.createHeader?.headerId ?? made.data.replies?.[0]?.createFooter?.footerId;
      if (made.ok && made.data.revisionId) refs.revisionRef.current = made.data.revisionId;
      if (!made.ok || !id) { failed = true; continue; }
      created[which] = id;
      // Saved as it is: nothing in a header glows, a sync never types there
      const saved = withoutMark({ type: "doc", content: nodes }, PENDING_MARK).content ?? [];
      let base: EditorNode[] = [EMPTY_PARAGRAPH];
      const requests = segmentRequests(saved, id);
      if (requests.length) {
        const filled = await postJson<{ revisionId?: string }>("/api/docs/edit", { documentId: content.docId, revisionId: refs.revisionRef.current, requests, ...tabFields(content) });
        if (filled.ok) { base = saved; if (filled.data.revisionId) refs.revisionRef.current = filled.data.revisionId; } else failed = true;
      } else base = saved;
      setSegments((s) => ({ ...s, [which]: { id, base } }));
    }
    return { created, failed };
  }, [refs, setScopeError, setSegments]);

  /** Put the PDF on the open page: on a blank page, after what's there, or in its place */
  const putOnPage = useCallback(async (mode: "blank" | "append" | "replace", file: PdfFile, r: PdfImportBody) => {
    const content = refs.docContentRef.current;
    if (!editor || content?.status !== "ready") {
      setStage((s) => (s.kind === "result" ? { ...s, confirming: false, error: "The document isn't open any more. Open it again, then import the PDF." } : s));
      return;
    }
    const applying: PdfStage = { kind: "applying", file, text: mode === "append" ? "Adding it after what's here" : mode === "replace" ? "Replacing what's here" : "Putting it on the page" };
    stageRef.current = applying;
    setStage(applying);
    const before = editor.getJSON() as EditorNode;
    const key = latest.current.docKey;
    const setup = latest.current.pageSetup;
    const wasPageless = latest.current.pageless;
    const startsAt = mode === "append" ? editor.state.doc.content.size : 0;
    const target = mode === "append" ? appendPdf(before, r.nodes) : mode === "replace" ? replaceWithPdf(before, r.nodes) : blankWithPdf(r.nodes);
    if (!show(target)) {
      setStage({ kind: "result", file, result: r, choice: mode === "blank" ? "new" : mode, confirming: false, error: "Couldn't put this PDF on the page. Try another PDF." });
      return;
    }
    let failed = false;
    let setupOk = true;
    let created: UndoState["created"] = {};
    // The page takes the PDF's paper and margins, as Page setup would (one added at the end keeps this one's)
    if (mode !== "append") {
      setupOk = await latest.current.applyPageSetup(r.pageSetup, false);
      ({ created, failed } = await addSegments(r, content));
    }
    undoRef.current = mode === "replace" ? null : { key, mode, before, setup, pageless: wasPageless, created };
    setCanUndo(mode !== "replace");
    setOpen(false);
    setStage({ kind: "pick" });
    // This message takes the place of Google's refusal, so it says what didn't go in
    const missed = [!setupOk && "page size and margins", failed && "header or footer"].filter(Boolean).join(" or its ");
    setSnack(missed ? `PDF imported, without its ${missed}: Google Docs didn't take them. Check it over, then start the sync.` : PDF_IMPORTED);
    // The caret goes to where the PDF starts, once the dialog has given focus back
    setTimeout(() => {
      if (editor.isDestroyed) return;
      const at = Math.min(startsAt + 1, editor.state.doc.content.size);
      try { editor.chain().focus().setTextSelection(at).scrollIntoView().run(); } catch { /* the page changed meanwhile */ }
    }, 30);
  }, [editor, refs, show, addSegments, setSnack]);

  const startNewDoc = useCallback(async (file: PdfFile, r: PdfImportBody) => {
    stageRef.current = { kind: "applying", file, text: "Making a new Google Doc" };
    setStage(stageRef.current);
    // Made with the PDF's name, in the one request
    const id = await createDoc(pdfTitle(file.name));
    if (!id) {
      setStage({ kind: "result", file, result: r, choice: "new", confirming: false, error: "Couldn't make the new Google Doc. Try again, or pick another way to import it." });
      return;
    }
    pendingNew.current = { docId: id, file, result: r };
    setStage({ kind: "applying", file, text: "Opening the new Google Doc", cancelable: true });
  }, [createDoc]);

  // The new Google Doc (named after the PDF) is open on the page: it gets the PDF
  useEffect(() => {
    const p = pendingNew.current;
    if (!p || docContent?.docId !== p.docId || selectedDocId !== p.docId) return;
    if (docContent.status === "failed") {
      pendingNew.current = null;
      setStage({ kind: "result", file: p.file, result: p.result, choice: "new", confirming: false, error: "The new Google Doc was made but couldn't be opened. Open it from File > Open, then import the PDF there." });
      return;
    }
    if (docContent.status !== "ready") return;
    pendingNew.current = null;
    void putOnPage("blank", p.file, p.result);
  }, [docContent, selectedDocId, putOnPage]);

  /** The dialog's main button */
  const apply = useCallback(() => {
    // (once: a second press while the first is under way would import it twice)
    if (stage.kind !== "result" || stageRef.current.kind !== "result") return;
    const { file, result, choice } = stage;
    if (latest.current.docBusy && (blank || choice !== "new")) {
      setStage({ ...stage, confirming: false, error: "A sync started typing into this document. Import the PDF into a new Google Doc, or wait until the sync finishes." });
      return;
    }
    if (blank) { void putOnPage("blank", file, result); return; }
    if (choice === "new") { void startNewDoc(file, result); return; }
    if (choice === "replace" && !stage.confirming) { confirmReplace(true); return; }
    void putOnPage(choice, file, result);
  }, [stage, blank, putOnPage, startNewDoc, confirmReplace]);

  const undo = useCallback(async () => {
    const u = undoRef.current;
    undoRef.current = null;
    setCanUndo(false);
    const content = refs.docContentRef.current;
    if (!u || !editor || u.key !== latest.current.docKey || content?.status !== "ready") return;
    show(u.before);
    setSnack(null);
    if (u.mode !== "blank") return;
    await latest.current.applyPageSetup(u.setup, u.pageless);
    const requests = [
      ...(u.created.header ? [{ deleteHeader: { headerId: u.created.header } }] : []),
      ...(u.created.footer ? [{ deleteFooter: { footerId: u.created.footer } }] : []),
    ];
    if (!requests.length) return;
    // The header and footer go from the document and tab they were made in, even when another one
    // has opened meanwhile (then without a revision: the page knows only the open one's)
    const shown = () => { const c = refs.docContentRef.current; return c?.status === "ready" && c.docId === content.docId && (c.tabId ?? null) === (content.tabId ?? null); };
    const here = shown();
    if (here) await latest.current.saveNow();
    const { ok, data } = await postJson<{ revisionId?: string }>("/api/docs/edit", { documentId: content.docId, ...(here ? { revisionId: refs.revisionRef.current } : {}), requests, ...tabFields(content) });
    if (!ok) { setSnack("Couldn't remove the PDF's header and footer. Remove them from Insert > Headers & footers."); return; }
    if (data.revisionId && shown()) refs.revisionRef.current = data.revisionId;
    setSegments((s) => ({
      ...s,
      ...(u.created.header && s.header?.id === u.created.header ? { header: null } : {}),
      ...(u.created.footer && s.footer?.id === u.created.footer ? { footer: null } : {}),
    }));
  }, [editor, refs, show, setSnack, setSegments]);

  /** The snackbar's action while it says the PDF was imported */
  const snackAction = useCallback((snack: string | null) => (snack?.startsWith("PDF imported") && canUndo ? { label: "Undo", run: () => { void undo(); } } : null), [canUndo, undo]);

  /** The header and footer the document has already: the PDF's aren't added where it has one */
  const docHas = useMemo(() => ({ header: hasHeader, footer: hasFooter }), [hasHeader, hasFooter]);

  return { open, stage, blank, pageBlank, docHas, disabledReason, openDialog, close, pick, cancelReading, choose, confirmReplace, apply, snackAction };
}

export type PdfImport = ReturnType<typeof usePdfImport>;
