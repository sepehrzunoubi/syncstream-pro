import type { DocListState } from "./rich-text";
import type { SpotState } from "./sync-store";

export interface SpotInput {
  at: number;
  mode: "inline" | "before";
  text: string;
}

const CTX_CHARS = 40;

/**
 * Starting state for each segment of a sync into an existing document.
 * Segments are typed top to bottom, so each one's context is the document
 * text before it as it will be once the earlier segments are typed, and its
 * expected index moves down by what they add.
 */
export function planSpots(chars: string, segments: SpotInput[], listAt: (at: number, mode: SpotInput["mode"]) => DocListState = () => null): SpotState[] {
  const spots: SpotState[] = [];
  let before = "";
  let prev = 0;
  let shift = 0;
  for (const seg of segments) {
    before = (before + chars.slice(prev, seg.at)).slice(-CTX_CHARS * 4);
    const list = listAt(seg.at, seg.mode);
    spots.push({ ctx: before.slice(-CTX_CHARS), cursor: seg.at + shift, opened: false, ...(list ? { docList: list } : {}) });
    const typed = seg.text + (seg.mode === "before" ? "\n" : "");
    before = (before + typed).slice(-CTX_CHARS * 4);
    shift += typed.length;
    prev = seg.at;
  }
  return spots;
}
