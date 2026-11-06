/**
 * A Google Doc with tabs, for offline tests: each tab is a stub document (stub-docs.ts), read as
 * documents.get gives a tabbed document (with includeTabsContent, every tab's content under
 * `tabs`, child tabs under their parent; without it, the first tab's at the top), and written as
 * batchUpdate writes one: each request goes to the tab it names (Location, Range and
 * EndOfSegmentLocation take a tabId; UpdateDocumentStyle and DeleteHeader name it themselves), to
 * the first tab when it names none, and is refused when it names a tab that isn't there or two tabs.
 */
import type { docs_v1 } from "googleapis";
import { DocsApiError, StubDocument } from "./stub-docs";

export interface StubTabSpec { id: string; title: string; children?: StubTabSpec[] }

interface TabNode { id: string; title: string; doc: StubDocument; children: TabNode[] }

/** Every tabId a request names, anywhere in it */
function tabIdsIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => tabIdsIn(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "tabId" && typeof x === "string") out.add(x);
      else tabIdsIn(x, out);
    }
  }
  return out;
}

/** The request without its tabIds, as the one-tab stub reads requests */
function withoutTabIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTabIds);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "tabId").map(([k, x]) => [k, withoutTabIds(x)]));
}

export class TabbedStub {
  roots: TabNode[];
  revision = 1;
  /** Requests each tab was sent, by tab id */
  sent = new Map<string, object[]>();

  constructor(public readonly documentId: string, public title: string, tabs: StubTabSpec[]) {
    const make = (s: StubTabSpec): TabNode => ({ id: s.id, title: s.title, doc: new StubDocument(documentId, title), children: (s.children ?? []).map(make) });
    this.roots = tabs.map(make);
  }

  get revisionId() { return `rev${this.revision}`; }

  all(): TabNode[] {
    const out: TabNode[] = [];
    const walk = (t: TabNode) => { out.push(t); t.children.forEach(walk); };
    this.roots.forEach(walk);
    return out;
  }

  tab(id: string): StubDocument {
    const t = this.all().find((x) => x.id === id);
    if (!t) throw new DocsApiError(`Requested tab not found: ${id}`, 400);
    return t.doc;
  }

  /** Delete a tab (and its children), as a collaborator might */
  removeTab(id: string) {
    const drop = (list: TabNode[]): TabNode[] => list.filter((t) => t.id !== id).map((t) => ({ ...t, children: drop(t.children) }));
    this.roots = drop(this.roots);
    this.revision++;
  }

  /** Move a top-level tab to the front, as dragging it in Docs does */
  moveFirst(id: string) {
    const k = this.roots.findIndex((t) => t.id === id);
    if (k < 0) throw new Error(`no top-level tab ${id}`);
    this.roots = [this.roots[k], ...this.roots.filter((_, i) => i !== k)];
    this.revision++;
  }

  get(includeTabsContent: boolean): docs_v1.Schema$Document {
    const read = (t: TabNode, level: number, index: number, parent?: string): docs_v1.Schema$Tab => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { documentId, title, revisionId, ...content } = t.doc.toDocument();
      return {
        tabProperties: { tabId: t.id, title: t.title, index, nestingLevel: level, ...(parent ? { parentTabId: parent } : {}) },
        documentTab: content as docs_v1.Schema$DocumentTab,
        childTabs: t.children.map((c, i) => read(c, level + 1, i, t.id)),
      };
    };
    const head = { documentId: this.documentId, title: this.title, revisionId: this.revisionId };
    if (includeTabsContent) return { ...head, tabs: this.roots.map((t, i) => read(t, 0, i)) };
    // Without its tabs, a document reads as its first tab
    const { body, lists, namedStyles, documentStyle } = this.roots[0].doc.toDocument();
    return { ...head, body, lists, namedStyles, documentStyle };
  }

  batchUpdate(requests: object[], requiredRevisionId?: string) {
    if (requiredRevisionId && requiredRevisionId !== this.revisionId) {
      throw new DocsApiError(`The document has been modified since the specified revision (${requiredRevisionId} vs ${this.revisionId}); the batch was not applied`, 400);
    }
    // All or nothing, across tabs
    const saved = this.all().map((t) => ({ t, items: structuredClone(t.doc.items), lists: structuredClone(t.doc.lists) }));
    try {
      for (const r of requests) {
        const ids = [...tabIdsIn(r)];
        if (ids.length > 1) throw new DocsApiError(`A request names more than one tab: ${ids.join(", ")}`, 400);
        const id = ids[0] ?? this.roots[0].id;
        const doc = this.tab(id);
        doc.batchUpdate([withoutTabIds(r) as never]);
        this.sent.set(id, [...(this.sent.get(id) ?? []), r]);
      }
    } catch (err) {
      for (const s of saved) { s.t.doc.items = s.items; s.t.doc.lists = s.lists; }
      throw err;
    }
    this.revision++;
  }
}

/**
 * A googleapis docs client over tabbed stub documents, for code that calls Google itself
 * (src/lib/google.ts): documents.get and documents.batchUpdate, with Google's error shape
 */
export function stubDocsClient(docs: Map<string, TabbedStub>) {
  const find = (id: string) => {
    const d = docs.get(id);
    if (!d) throw new DocsApiError(`Requested entity was not found: ${id}`, 404);
    return d;
  };
  return {
    documents: {
      async get({ documentId, includeTabsContent }: { documentId: string; includeTabsContent?: boolean; fields?: string }) {
        return { data: find(documentId).get(!!includeTabsContent) };
      },
      async batchUpdate({ documentId, requestBody }: { documentId: string; requestBody: { requests: object[]; writeControl?: { requiredRevisionId?: string } } }) {
        const d = find(documentId);
        d.batchUpdate(requestBody.requests, requestBody.writeControl?.requiredRevisionId);
        return { data: { documentId, replies: requestBody.requests.map(() => ({})), writeControl: { requiredRevisionId: d.revisionId } } };
      },
    },
  };
}
