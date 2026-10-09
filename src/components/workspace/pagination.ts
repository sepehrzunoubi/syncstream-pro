import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** Page and margins in CSS px (96 per inch); Letter with 1in margins by default */
export interface PageGeometry { w: number; h: number; top: number; bottom: number; left: number; right: number }
export const DEFAULT_GEOMETRY: PageGeometry = { w: 816, h: 1056, top: 96, bottom: 96, left: 96, right: 96 };
/** Docs-like gap between pages */
export const PAGE_GAP = 16;
const sameGeometry = (a: PageGeometry, b: PageGeometry) => a.w === b.w && a.h === b.h && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

interface Break { pos: number; height: number; block: boolean }
interface PaginationState {
  breaks: Break[];
  pages: number;
  enabled: boolean;
  deco: DecorationSet;
  geometry: PageGeometry;
  reserves: number[];
  /** Positions where Google Docs itself starts a page (from its PDF export); measured breaks only follow the last one */
  pins: number[];
}

export const paginationKey = new PluginKey<PaginationState>("ssPagination");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pagination: {
      setPaginated: (on: boolean) => ReturnType;
      /** Page size and margins from the document's page setup */
      setPageGeometry: (geometry: PageGeometry) => ReturnType;
      /** Space at the bottom of each page taken by footnotes, in px */
      setPageReserves: (reserves: number[]) => ReturnType;
      /** Where Google Docs starts each page after the first, as document positions; [] to measure everything */
      setPinnedBreaks: (positions: number[]) => ReturnType;
    };
  }
}

function gapElement(height: number, block: boolean): HTMLElement {
  const el = document.createElement(block ? "div" : "span");
  el.className = "ss-page-gap";
  el.style.height = `${height}px`;
  el.dataset.gap = String(height);
  el.setAttribute("contenteditable", "false");
  el.setAttribute("aria-hidden", "true");
  return el;
}

function decorate(doc: Parameters<typeof DecorationSet.create>[0], breaks: Break[]): DecorationSet {
  return DecorationSet.create(
    doc,
    breaks
      .filter((b) => b.pos >= 0 && b.pos <= doc.content.size)
      .map((b) => Decoration.widget(b.pos, () => gapElement(b.height, b.block), { side: -1, key: `gap:${b.block ? "b" : "i"}:${b.height}`, ignoreSelection: true }))
  );
}

interface Fragment { node: Node; index: number; top: number; bottom: number; left: number; mid: number }
interface Line { top: number; bottom: number; first: Fragment }

/** Line boxes of a paragraph, in editor-local pixels, skipping page gaps */
function linesOf(el: HTMLElement, toLocal: (clientY: number) => number): Line[] {
  const frags: Fragment[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const e = n as HTMLElement;
        if (e.classList.contains("ss-page-gap") || e.classList.contains("ss-caret")) return NodeFilter.FILTER_REJECT;
        return e.tagName === "IMG" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return n.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const rects = n.nodeType === 3 ? (range.selectNodeContents(n), Array.from(range.getClientRects())) : [(n as Element).getBoundingClientRect()];
    rects.forEach((r, index) => {
      if (r.height === 0) return;
      frags.push({ node: n!, index, top: toLocal(r.top), bottom: toLocal(r.bottom), left: r.left, mid: (r.top + r.bottom) / 2 });
    });
  }
  const lines: Line[] = [];
  for (const f of frags) {
    const cur = lines[lines.length - 1];
    if (cur && f.top < cur.bottom - 1) {
      cur.top = Math.min(cur.top, f.top);
      cur.bottom = Math.max(cur.bottom, f.bottom);
    } else {
      lines.push({ top: f.top, bottom: f.bottom, first: f });
    }
  }
  return lines;
}

/** Document position where a line starts */
function lineStartPos(view: EditorView, line: Line, toLocal: (y: number) => number): number | null {
  const { node, index } = line.first;
  try {
    if (node.nodeType !== 3) {
      const target = (node as Element).closest("[data-resize-container]") ?? (node as Element);
      const parent = target.parentNode!;
      return view.posAtDOM(parent, Array.prototype.indexOf.call(parent.childNodes, target));
    }
    if (index === 0) return view.posAtDOM(node, 0);
    // The text node wraps onto this line: find the first character on it
    const text = node.textContent ?? "";
    const range = document.createRange();
    let lo = 0;
    let hi = text.length - 1;
    let ans = text.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      range.setStart(node, mid);
      range.setEnd(node, mid + 1);
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (toLocal(r.top) >= line.top - 1) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return view.posAtDOM(node, ans);
  } catch {
    return null;
  }
}

/**
 * Where pages break. Measured in "flow" space (the layout minus our own
 * gaps), so adding gaps never changes the answer and the result is stable.
 */
function measure(view: EditorView, geom: PageGeometry, reserves: number[] = [], pins: number[] = []): Break[] {
  const FULL_H = geom.h - geom.top - geom.bottom;
  // The current page's room for text: less where footnotes sit
  let CONTENT_H = FULL_H - (reserves[0] ?? 0);
  const BETWEEN = geom.bottom + PAGE_GAP + geom.top;
  const breaks: Break[] = [];
  const nextPage = () => { CONTENT_H = FULL_H - (reserves[breaks.length] ?? 0); };
  const dom = view.dom as HTMLElement;
  const box = dom.getBoundingClientRect();
  const scale = box.width / (dom.offsetWidth || box.width || 1) || 1;
  const toLocal = (clientY: number) => (clientY - box.top) / scale;
  const gapSize = (el: Element) => parseFloat((el as HTMLElement).dataset.gap || "0");
  let removed = 0;
  let pageStart = 0;

  // Google's page starts come first, exactly where its PDF has them
  let pinnedUntil = -1;
  const gapsAbove = (y: number) => Array.from(dom.querySelectorAll(".ss-page-gap")).reduce((s, g) => (toLocal(g.getBoundingClientRect().top) < y ? s + gapSize(g) : s), 0);
  for (const pos of pins) {
    if (pos <= 0 || pos >= view.state.doc.content.size) continue;
    let y: number;
    try { y = toLocal(view.coordsAtPos(pos).top); } catch { continue; }
    const flowY = y - gapsAbove(y);
    if (flowY <= pageStart + 1) continue;
    const $pos = view.state.doc.resolve(pos);
    // At a paragraph's start the gap goes before the paragraph, as measured block breaks do
    const block = $pos.parentOffset === 0 && $pos.depth === 1;
    breaks.push({ pos: block ? $pos.before(1) : pos, height: Math.round((CONTENT_H - (flowY - pageStart) + BETWEEN) * 2) / 2, block });
    pageStart = flowY;
    pinnedUntil = pos;
    nextPage();
  }

  const all = Array.from(dom.children) as HTMLElement[];
  const children = all.filter((c) => !c.classList.contains("ss-page-gap"));
  const keepOf = (el: HTMLElement | undefined) => (el?.getAttribute("data-keep") ?? "").split(" ");
  // Paragraph tops in flow space, so a break can be moved up to an earlier paragraph
  const flowTop = new Map<HTMLElement, number>();
  let lastBreakPara = -1;
  let ci = -1;
  // After a page break, or a next-page section break, the next paragraph starts a page
  let forceNext = false;

  for (const child of all) {
    // Our own gaps are not part of the flow
    if (child.classList.contains("ss-page-gap")) { removed += gapSize(child); continue; }
    ci++;
    const inner = Array.from(child.querySelectorAll(".ss-page-gap"));
    const innerTotal = inner.reduce((s, g) => s + gapSize(g), 0);
    const r = child.getBoundingClientRect();
    const top = toLocal(r.top) - removed;
    const bottom = toLocal(r.bottom) - removed - innerTotal;
    flowTop.set(child, top);
    // What Google already paginated is left alone; measuring starts after the last pin
    if (pinnedUntil >= 0) {
      const childStart = view.posAtDOM(child, 0) - 1;
      const childEnd = childStart + ((view.state.doc.nodeAt(childStart)?.nodeSize) ?? 1);
      if (childEnd <= pinnedUntil) { removed += innerTotal; forceNext = false; continue; }
    }
    const forced = forceNext;
    forceNext = !!child.querySelector("[data-page-break]") || (child.getAttribute("data-kind") === "section" && child.getAttribute("data-section") !== "continuous");
    if (forced && top > pageStart + 1) {
      breaks.push({ pos: view.posAtDOM(child, 0) - 1, height: Math.round((CONTENT_H - (top - pageStart) + BETWEEN) * 2) / 2, block: true });
      pageStart = top;
      lastBreakPara = ci;
      nextPage();
    }
    if (bottom - pageStart <= CONTENT_H + 0.5) { removed += innerTotal; continue; }
    const keep = keepOf(child);
    const fits = bottom - top <= CONTENT_H;
    // Keep with next: a paragraph that would end a page moves to the next one with its follower
    const breakBefore = (k: number): boolean => {
      let q = k;
      while (q > lastBreakPara + 1 && keepOf(children[q - 1]).includes("next") && (flowTop.get(children[q - 1]) ?? 0) > pageStart + 1) q--;
      const el = children[q];
      const t = flowTop.get(el) ?? top;
      if (t <= pageStart + 1) return false;
      const pos = view.posAtDOM(el, 0) - 1;
      breaks.push({ pos, height: Math.round((CONTENT_H - (t - pageStart) + BETWEEN) * 2) / 2, block: true });
      pageStart = t;
      lastBreakPara = q;
      nextPage();
      return true;
    };
    // A table moves to the next page whole (Docs breaks tables by row; cells here stay together); so does a column section
    if (child.classList.contains("tableWrapper") || child.tagName === "TABLE" || child.classList.contains("ss-section-cols")) {
      if (top > pageStart + 1 && fits) { breakBefore(ci); removed += innerTotal; continue; }
      removed += innerTotal;
      continue;
    }
    // Keep lines together: the whole paragraph goes to the next page
    if (keep.includes("lines") && fits && breakBefore(ci)) {
      if (bottom - pageStart <= CONTENT_H + 0.5) { removed += innerTotal; continue; }
    }

    const gapTops = inner.map((g) => ({ top: toLocal(g.getBoundingClientRect().top), size: gapSize(g) }));
    const lines = linesOf(child, toLocal).map((l) => {
      const above = gapTops.filter((g) => g.top < l.top).reduce((s, g) => s + g.size, 0);
      return { ...l, ft: l.top - removed - above, fb: l.bottom - removed - above };
    });
    // An empty paragraph (a new line with nothing typed yet) has no text to measure: its box is its one line
    if (!lines.length) lines.push({ top: toLocal(r.top), bottom: toLocal(r.bottom), first: null as unknown as Fragment, ft: top, fb: bottom });
    // Prevent single lines (Docs' default): never leave one line alone on either page
    const singleLines = !keep.includes("single") && lines.length >= 2;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      // Lines up to the last pinned page start are Google's
      if (pinnedUntil >= 0 && i > 0 && (lineStartPos(view, L, toLocal) ?? Infinity) <= pinnedUntil) continue;
      if (L.fb - pageStart <= CONTENT_H + 0.5) continue;
      let at = i;
      if (singleLines && at === 1 && fits) at = 0; // an orphan: move the whole paragraph
      else if (singleLines && at === 1 && lines.length >= 4) at = 2;
      if (singleLines && at === lines.length - 1 && at >= 2) at = lines.length - 2; // a widow: take one more line along
      if (at === 0) {
        if (!breakBefore(ci) && top > pageStart + 1) {
          breaks.push({ pos: view.posAtDOM(child, 0) - 1, height: Math.round((CONTENT_H - (top - pageStart) + BETWEEN) * 2) / 2, block: true });
          pageStart = top;
          nextPage();
        }
      } else {
        const Lb = lines[at];
        const breakTop = (lines[at - 1].fb + Lb.ft) / 2;
        const pos = lineStartPos(view, Lb, toLocal);
        if (pos != null && breakTop > pageStart + 1) {
          breaks.push({ pos, height: Math.round((CONTENT_H - (breakTop - pageStart) + BETWEEN) * 2) / 2, block: false });
          pageStart = breakTop;
          lastBreakPara = ci;
          nextPage();
        }
      }
      if (at > i) i = at;
    }
    removed += innerTotal;
  }
  return breaks;
}

const same = (a: Break[], b: Break[]) =>
  a.length === b.length && a.every((x, i) => x.pos === b[i].pos && x.block === b[i].block && Math.abs(x.height - b[i].height) < 1);

/** Splits the editor into US Letter pages, like Docs' default layout. */
export const Pagination = Extension.create<{ enabled: boolean }>({
  name: "pagination",
  addOptions() {
    return { enabled: true };
  },
  addCommands() {
    return {
      setPaginated: (on) => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(paginationKey, { enabled: on }).setMeta("addToHistory", false));
        return true;
      },
      setPageGeometry: (geometry) => ({ tr, state, dispatch }) => {
        const cur = paginationKey.getState(state)?.geometry;
        if (cur && sameGeometry(cur, geometry)) return true;
        if (dispatch) dispatch(tr.setMeta(paginationKey, { geometry }).setMeta("addToHistory", false));
        return true;
      },
      setPinnedBreaks: (positions) => ({ tr, state, dispatch }) => {
        const cur = paginationKey.getState(state)?.pins ?? [];
        const next = positions.filter((p, i, all) => Number.isInteger(p) && p > 0 && (i === 0 || p > all[i - 1]));
        if (cur.length === next.length && cur.every((v, i) => v === next[i])) return true;
        if (dispatch) dispatch(tr.setMeta(paginationKey, { pins: next }).setMeta("addToHistory", false));
        return true;
      },
      setPageReserves: (reserves) => ({ tr, state, dispatch }) => {
        const cur = paginationKey.getState(state)?.reserves ?? [];
        const trimmed = [...reserves];
        while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
        if (cur.length === trimmed.length && cur.every((v, i) => Math.abs(v - trimmed[i]) < 1)) return true;
        if (dispatch) dispatch(tr.setMeta(paginationKey, { reserves: trimmed }).setMeta("addToHistory", false));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const initial = this.options.enabled;
    return [
      new Plugin<PaginationState>({
        key: paginationKey,
        state: {
          init: (_, state) => ({ breaks: [], pages: 1, enabled: initial, deco: DecorationSet.create(state.doc, []), geometry: DEFAULT_GEOMETRY, reserves: [], pins: [] }),
          apply(tr, value) {
            const meta = tr.getMeta(paginationKey) as Partial<Pick<PaginationState, "breaks" | "enabled" | "geometry" | "reserves" | "pins">> | undefined;
            if (meta) {
              const enabled = meta.enabled ?? value.enabled;
              const geometry = meta.geometry ?? value.geometry;
              const reserves = meta.reserves ?? value.reserves;
              const pins = meta.pins ?? value.pins;
              // Turning pages on or changing the page starts from no breaks; they are measured again
              const reset = meta.enabled != null || meta.geometry != null || meta.pins != null;
              const breaks = enabled ? meta.breaks ?? (reset ? [] : value.breaks) : [];
              return { breaks, pages: breaks.length + 1, enabled, deco: decorate(tr.doc, breaks), geometry, reserves, pins };
            }
            if (!tr.docChanged) return value;
            const breaks = value.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos, -1) }));
            // Google's page starts stay with the text they precede
            const pins = value.pins.map((p) => tr.mapping.map(p, 1)).filter((p, i, all) => i === 0 || p > all[i - 1]);
            return { ...value, breaks, pins, deco: value.deco.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => paginationKey.getState(state)?.deco,
        },
        view: (view) => {
          let frame = 0;
          let recent = 0;
          let windowStart = 0;
          const run = () => {
            frame = 0;
            const st = paginationKey.getState(view.state);
            if (!st?.enabled || !view.dom.isConnected) return;
            const now = performance.now();
            if (now - windowStart > 1000) { windowStart = now; recent = 0; }
            if (recent > 8) return; // never loop
            const breaks = measure(view, st.geometry, st.reserves, st.pins);
            if (!same(breaks, st.breaks)) {
              recent++;
              view.dispatch(view.state.tr.setMeta(paginationKey, { breaks }).setMeta("addToHistory", false));
            }
          };
          const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
          const ro = new ResizeObserver(schedule);
          ro.observe(view.dom);
          const onFonts = () => schedule();
          document.fonts?.addEventListener?.("loadingdone", onFonts);
          window.addEventListener("resize", schedule);
          schedule();
          return {
            update: schedule,
            destroy() {
              if (frame) cancelAnimationFrame(frame);
              ro.disconnect();
              document.fonts?.removeEventListener?.("loadingdone", onFonts);
              window.removeEventListener("resize", schedule);
            },
          };
        },
      }),
    ];
  },
});

// ── Progress marks for the read-only view of a running sync ────────────────

export const progressKey = new PluginKey<Progress>("ssProgress");

/** How far a sync has typed; `ranges` are the editor tokens each segment came from */
export interface Progress {
  typed: number;
  ranges?: [number, number][] | null;
}

/**
 * Source offset (text with "\n" between paragraphs, 1 per image) → document
 * position, for a document that is all source text.
 */
export function offsetToPos(doc: Parameters<typeof DecorationSet.create>[0], offset: number): number {
  let chars = 0;
  let result = -1;
  doc.forEach((para, paraPos, idx) => {
    if (result >= 0) return;
    if (idx > 0) chars += 1; // the newline before this paragraph
    let len = 0;
    para.forEach((c) => { len += c.isText ? c.text!.length : 1; });
    if (offset > chars + len) { chars += len; return; }
    let rem = offset - chars;
    let pos = paraPos + 1;
    para.forEach((c) => {
      if (result >= 0) return;
      if (rem <= 0) { result = pos; return; }
      if (c.isText) {
        const l = c.text!.length;
        if (rem <= l) { result = pos + rem; return; }
        rem -= l;
        pos += l;
      } else {
        rem -= 1;
        pos += c.nodeSize;
      }
    });
    if (result < 0) result = pos;
  });
  return result < 0 ? doc.content.size : result;
}

/** Position of each token, in the same order as doc-model's tokenize */
export function tokenPositions(doc: Parameters<typeof DecorationSet.create>[0]): number[] {
  const out: number[] = [];
  type N = Parameters<typeof DecorationSet.create>[0];
  const paragraph = (node: N, pos: number) => {
    if (node.attrs.locked) { out.push(pos); return; }
    let p = pos + 1;
    node.forEach((child) => {
      if (child.isText) for (let i = 0; i < child.text!.length; i++) out.push(p + i);
      else if (child.type.name === "image" || child.type.name === "hardBreak" || child.type.name === "pageBreak") out.push(p);
      p += child.nodeSize;
    });
    out.push(pos + node.nodeSize - 1); // the paragraph's end
  };
  const block = (node: N, pos: number) => {
    if (node.type.name === "columnSection") { node.forEach((child, offset) => block(child, pos + 1 + offset)); return; }
    if (node.type.name !== "table") { paragraph(node, pos); return; }
    out.push(pos); // table start
    node.forEach((row, rowOffset) => {
      const rowPos = pos + 1 + rowOffset;
      out.push(rowPos);
      row.forEach((cell, cellOffset) => {
        const cellPos = rowPos + 1 + cellOffset;
        out.push(cellPos);
        if (cell.childCount === 0) out.push(cellPos + 1);
        cell.forEach((p, pOffset) => paragraph(p, cellPos + 1 + pOffset));
        out.push(cellPos + cell.nodeSize - 1); // cell end
      });
      out.push(rowPos + row.nodeSize - 1); // row end
    });
    out.push(pos + node.nodeSize - 1); // table end
  };
  doc.forEach(block);
  return out;
}

function caretWidget() {
  const el = document.createElement("span");
  el.className = "ss-caret";
  return el;
}

export const ProgressMarks = Extension.create({
  name: "progressMarks",
  addProseMirrorPlugins() {
    return [
      new Plugin<Progress>({
        key: progressKey,
        state: {
          init: () => ({ typed: 0 }),
          apply: (tr, value) => (tr.getMeta(progressKey) as Progress | undefined) ?? value,
        },
        props: {
          decorations(state) {
            const progress = progressKey.getState(state) ?? { typed: 0 };
            const { doc } = state;
            if (!progress.ranges?.length) {
              // The whole document is the text being typed
              const pos = offsetToPos(doc, progress.typed);
              const end = doc.content.size - 1;
              if (pos >= end) return DecorationSet.empty;
              return DecorationSet.create(doc, [
                Decoration.inline(pos, doc.content.size, { class: "ss-untyped" }),
                Decoration.widget(pos, caretWidget, { side: -1, key: "caret" }),
              ]);
            }
            // Additions spread through the document: grey out what is still to come
            const positions = tokenPositions(doc);
            const decos: Decoration[] = [];
            const spans: [number, number][] = [];
            let left = progress.typed;
            let caretAt: number | null = null;
            for (const [ts, te] of progress.ranges) {
              const len = te - ts;
              const from = Math.max(0, Math.min(len, left));
              left -= len;
              if (from >= len) continue;
              if (caretAt == null && positions[ts + from] != null) caretAt = positions[ts + from];
              for (let q = ts + from; q < te; q++) {
                const p = positions[q];
                if (p == null) continue;
                const node = doc.nodeAt(p);
                if (!node || !(node.isText || node.isInline)) continue;
                const last = spans[spans.length - 1];
                if (last && last[1] === p) last[1] = p + 1;
                else spans.push([p, p + 1]);
              }
            }
            for (const [from, to] of spans) decos.push(Decoration.inline(from, to, { class: "ss-untyped" }));
            if (caretAt != null) decos.push(Decoration.widget(caretAt, caretWidget, { side: -1, key: "caret" }));
            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});
