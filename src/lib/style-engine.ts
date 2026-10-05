/**
 * Shared limits and types of the Style engine's user-facing side.
 *
 * The style itself (fingerprint, rules, exemplars, winning prompt) is
 * compiled from the developer's dataset by the style lab and shipped in
 * style-data/<name>/compiled.json; see style-spec.ts. Users only send text.
 */

import { summarizeEdits, textMetrics } from "./style-metrics";

export const MAX_TEXT_CHARS = 60_000;

/** What the workspace shows next to a finished transformation */
export function transformationSummary(input: string, output: string) {
  const edits = summarizeEdits(input, output);
  return { input: textMetrics(input), output: textMetrics(output), edits };
}
