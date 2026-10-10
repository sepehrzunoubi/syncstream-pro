/**
 * Time for the live test.
 *
 * The runner takes `now` and `sleep` as dependencies, so a plan's pauses
 * (keystroke gaps, thinking pauses, breaks) run on a virtual clock that
 * jumps forward instead of waiting: production code is untouched and every
 * delay is still computed and honoured, just instantly. Real time is only
 * spent on Google calls, which a pacer keeps a minimum distance apart so the
 * run stays inside the Docs API's per-minute write quota.
 */

export class FastClock {
  private offset = 0;
  constructor(private readonly real: () => number = Date.now) {}
  /** Real time plus everything slept or advanced so far */
  now = (): number => this.real() + this.offset;
  /** Returns at once; the clock moves instead */
  sleep = async (ms: number): Promise<void> => {
    this.offset += Math.max(0, ms);
  };
  advance(ms: number): void {
    this.offset += Math.max(0, ms);
  }
  get skippedMs(): number {
    return this.offset;
  }
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Awaits so that successive calls are at least `minGapMs` apart in real time */
export function pacer(minGapMs: number, sleep: (ms: number) => Promise<void> = realSleep, now: () => number = Date.now): () => Promise<void> {
  let last = -Infinity;
  return async () => {
    const wait = last + minGapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };
}
