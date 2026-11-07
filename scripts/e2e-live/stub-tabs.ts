/**
 * A Google Doc with tabs, for offline tests: each tab is a stub document (stub-docs.ts), read as
 * documents.get gives a tabbed document (with includeTabsContent, every tab's content under
 * `tabs`, child tabs under their parent; without it, the first tab's at the top), and written as
 * batchUpdate writes one: each request goes to the tab it names (Location, Range and
 * EndOfSegmentLocation take a tabId; UpdateDocumentStyle and DeleteHeader name it themselves), to
 * the first tab when it names none, and is refused when it names a tab that isn't there or two tabs.
 * Tabs are made (addDocumentTab: blank, Google's default styles, a new id in the reply), renamed
 * and re-iconed (updateDocumentTabProperties) and deleted (deleteTab) as Docs does it, within the
 * limits Docs Help gives: at most 100 tabs, nested at most 3 deep.
 */
import type { docs_v1 } from "googleapis";
import { DocsApiError, StubDocument } from "./stub-docs";

export interface StubTabSpec { id: string; title: string; emoji?: string; children?: StubTabSpec[] }

interface TabNode { id: string; title: string; emoji?: string; doc: StubDocument; children: TabNode[] }

const MAX_TABS = 100;
const MAX_LEVELS = 3;
const bad = (message: string) => new DocsApiError(message, 400);

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
  private tabSeq = 0;

  constructor(
    public readonly documentId: string,
    public title: string,
    tabs: StubTabSpec[],
    /** Each tab's document (a strict stub's, say) */
    private readonly makeDoc: (documentId: string, title: string) => StubDocument = (id, t) => new StubDocument(id, t)
  ) {
    const make = (s: StubTabSpec): TabNode => ({ id: s.id, title: s.title, ...(s.emoji ? { emoji: s.emoji } : {}), doc: makeDoc(documentId, title), children: (s.children ?? []).map(make) });
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
    this.dropTab(id);
    this.revision++;
  }

  private dropTab(id: string) {
    const drop = (list: TabNode[]): TabNode[] => list.filter((t) => t.id !== id).map((t) => ({ ...t, children: drop(t.children) }));
    this.roots = drop(this.roots);
  }

  /** The tab and the list it is in, with how deep that is */
  private find(id: string): { node: TabNode; level: number } | null {
    const walk = (list: TabNode[], level: number): { node: TabNode; level: number } | null => {
      for (const t of list) {
        if (t.id === id) return { node: t, level };
        const found = walk(t.children, level + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(this.roots, 0);
  }

  /** "All properties are optional"; the new tab is blank, and its id comes back in the reply */
  private addTab(props: docs_v1.Schema$TabProperties): docs_v1.Schema$Response {
    if (props.tabId) throw bad("Invalid requests[0].addDocumentTab: a new tab's id is given by Google Docs");
    if (this.all().length >= MAX_TABS) throw bad(`A document can have at most ${MAX_TABS} tabs`);
    const parent = props.parentTabId ? this.find(props.parentTabId) : null;
    if (props.parentTabId && !parent) throw bad(`Invalid parent tab ID: ${props.parentTabId}`);
    const level = parent ? parent.level + 1 : 0;
    if (level >= MAX_LEVELS) throw bad(`Tabs can be nested at most ${MAX_LEVELS} levels deep`);
    const siblings = parent ? parent.node.children : this.roots;
    const index = props.index ?? siblings.length;
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) throw bad(`Invalid tab index ${props.index}`);
    let id = "";
    do id = `t.${++this.tabSeq}`; while (this.find(id));
    const title = props.title || `Tab ${this.all().length + 1}`;
    const node: TabNode = { id, title, ...(props.iconEmoji ? { emoji: props.iconEmoji } : {}), doc: this.makeDoc(this.documentId, this.title), children: [] };
    siblings.splice(index, 0, node);
    return { addDocumentTab: { tabProperties: { tabId: id, title, index, nestingLevel: level, ...(parent ? { parentTabId: parent.node.id } : {}), ...(node.emoji ? { iconEmoji: node.emoji } : {}) } } };
  }

  /** A tab's name and icon; where it sits isn't modelled */
  private updateTab(u: docs_v1.Schema$UpdateDocumentTabPropertiesRequest) {
    const id = u.tabProperties?.tabId;
    const found = id ? this.find(id) : null;
    if (!found) throw bad(`Invalid tab ID: ${id}`);
    const fields = (u.fields ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    if (!fields.length) throw bad("fields is required");
    for (const f of fields.includes("*") ? ["title", "iconEmoji"] : fields) {
      if (f === "title") found.node.title = u.tabProperties?.title || "";
      else if (f === "iconEmoji") {
        if (u.tabProperties?.iconEmoji) found.node.emoji = u.tabProperties.iconEmoji;
        else delete found.node.emoji;
      } else throw bad(`The stub does not model tab field ${f}`);
    }
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
        tabProperties: { tabId: t.id, title: t.title, index, nestingLevel: level, ...(parent ? { parentTabId: parent } : {}), ...(t.emoji ? { iconEmoji: t.emoji } : {}) },
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

  /** Applies every request or none, across tabs; each one's reply */
  batchUpdate(requests: object[], requiredRevisionId?: string): object[] {
    if (requiredRevisionId && requiredRevisionId !== this.revisionId) {
      throw new DocsApiError(`The document has been modified since the specified revision (${requiredRevisionId} vs ${this.revisionId}); the batch was not applied`, 400);
    }
    // All or nothing, across tabs: their content and the tabs themselves
    const restores = this.all().map((t) => t.doc.checkpoint());
    const tree = (list: TabNode[]): TabNode[] => list.map((t) => ({ ...t, children: tree(t.children) }));
    const roots = tree(this.roots);
    const sent = new Map(this.sent);
    const seq = this.tabSeq;
    const replies: object[] = [];
    try {
      for (const r of requests) {
        const tabRequest = r as { addDocumentTab?: docs_v1.Schema$AddDocumentTabRequest; updateDocumentTabProperties?: docs_v1.Schema$UpdateDocumentTabPropertiesRequest; deleteTab?: { tabId?: string } };
        if (tabRequest.addDocumentTab) { replies.push(this.addTab(tabRequest.addDocumentTab.tabProperties ?? {})); continue; }
        if (tabRequest.updateDocumentTabProperties) { this.updateTab(tabRequest.updateDocumentTabProperties); replies.push({}); continue; }
        if (tabRequest.deleteTab) {
          const id = tabRequest.deleteTab.tabId;
          if (!id || !this.find(id)) throw bad(`Invalid tab ID: ${id}`);
          if (this.all().length === 1) throw bad("A document's only tab can't be deleted");
          this.dropTab(id);
          replies.push({});
          continue;
        }
        const ids = [...tabIdsIn(r)];
        if (ids.length > 1) throw new DocsApiError(`A request names more than one tab: ${ids.join(", ")}`, 400);
        const id = ids[0] ?? this.roots[0].id;
        const doc = this.tab(id);
        replies.push(...doc.batchUpdate([withoutTabIds(r) as never]));
        this.sent.set(id, [...(this.sent.get(id) ?? []), r]);
      }
    } catch (err) {
      for (const restore of restores) restore();
      this.roots = roots;
      this.sent = sent;
      this.tabSeq = seq;
      throw err;
    }
    this.revision++;
    return replies;
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
        const replies = d.batchUpdate(requestBody.requests, requestBody.writeControl?.requiredRevisionId);
        return { data: { documentId, replies, writeControl: { requiredRevisionId: d.revisionId } } };
      },
    },
  };
}
