/**
 * How the blocks of a column section flow over pages, the way Google Docs
 * lays them out: down column 1 to the bottom of the page, then column 2, …,
 * then on to the next page's column 1 again. Only the section's last page
 * is balanced, and the browser does that part.
 *
 * Pure arithmetic over measured block heights, so the pagination plugin can
 * decide a layout in one pass and the decision can be tested without a DOM.
 */

/** A block (paragraph or table) of the section, in CSS px at the column's width */
export interface FlowBlock {
  /** The border box */
  height: number;
  marginTop: number;
  marginBottom: number;
}

/** One page's worth of the section */
export interface FlowPart {
  /** First block of the part */
  start: number;
  /** One past the last block */
  end: number;
  /** Blocks that start columns 2…N; empty for the last part, which is balanced */
  columnStarts: number[];
  /** The tallest column's stacked height: how much of the page the part takes */
  height: number;
}

/** Fudge for sub-pixel measurements */
const EPS = 0.5;

/** The height of blocks[from…to) stacked, with adjoining margins collapsed as CSS does between siblings */
export function stackHeight(blocks: readonly FlowBlock[], from: number, to: number): number {
  if (to <= from) return 0;
  let h = blocks[from].marginTop;
  for (let i = from; i < to; i++) {
    h += blocks[i].height;
    if (i + 1 < to) h += Math.max(blocks[i].marginBottom, blocks[i + 1].marginTop);
  }
  return h + blocks[to - 1].marginBottom;
}

/**
 * Distributes the blocks over pages and columns. `capacity(k)` is the height
 * available to the section's k-th part: what is left of the current page for
 * the first, a full page (less footnotes) for the others.
 *
 * Returns [] when the first block does not fit the first part at all, so the
 * caller can start the section on a fresh page; with `placeFirst` a block
 * taller than its page is placed anyway, alone in its column, rather than
 * being pushed down forever.
 */
export function flowColumns(blocks: readonly FlowBlock[], columns: number, capacity: (part: number) => number, placeFirst = false): FlowPart[] {
  const n = blocks.length;
  const cols = Math.max(1, Math.floor(columns));
  const parts: FlowPart[] = [];
  let i = 0;
  while (i < n) {
    const part = parts.length;
    const cap = capacity(part);
    const columnStarts: number[] = [];
    let height = 0;
    const start = i;
    for (let c = 0; c < cols && i < n; c++) {
      const colStart = i;
      // A block that fits nowhere still goes somewhere: alone at the top of a page's first column
      const lone = c === 0 && (part > 0 || placeFirst);
      while (i < n) {
        const h = stackHeight(blocks, colStart, i + 1);
        if (h <= cap + EPS || (i === colStart && lone)) i++;
        else break;
      }
      if (i === colStart) break; // nothing fits this column: the rest goes to the next page
      if (c > 0) columnStarts.push(colStart);
      height = Math.max(height, stackHeight(blocks, colStart, i));
    }
    if (i === start) return parts; // nothing fits the first part
    // The last part is balanced by the browser, so its column starts are not forced
    parts.push({ start, end: i, columnStarts: i < n ? columnStarts : [], height });
  }
  return parts;
}
