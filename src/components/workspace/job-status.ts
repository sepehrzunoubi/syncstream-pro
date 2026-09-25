import type { PublicJob } from "@/lib/sync-store";
import { formatClock } from "@/lib/format";

export const ACTIVE_STATUSES = new Set<PublicJob["status"]>(["scheduled", "pending", "running", "paused"]);
export const isActive = (j: PublicJob) => ACTIVE_STATUSES.has(j.status);
export const isFinished = (j: PublicJob) => !isActive(j);

export function progressOf(job: PublicJob): number {
  return job.totalChars > 0 ? Math.min(100, (job.charsSent / job.totalChars) * 100) : 0;
}

export function onBreak(job: PublicJob): boolean {
  return job.status === "running" && /^(On a break|Away)/.test(job.activity);
}

/** One short line describing where a sync is, in plain words. */
export function statusLine(job: PublicJob): string {
  const pct = Math.round(progressOf(job));
  switch (job.status) {
    case "scheduled":
      return `Starts at ${formatClock(job.startAt)}`;
    case "pending":
      return "Starting";
    case "running":
      return onBreak(job) ? `On a break, ${pct}% typed` : `Typing, ${pct}%`;
    case "paused":
      return `Paused at ${pct}%`;
    case "done":
      return job.finishedAt ? `Finished at ${formatClock(job.finishedAt)}` : "Finished";
    case "error":
      return "Stopped by an error";
    case "cancelled":
      return "Cancelled";
  }
}

/** Heading for the job panel */
export function statusTitle(job: PublicJob): string {
  switch (job.status) {
    case "scheduled": return "Scheduled";
    case "pending": return "Starting";
    case "running": return onBreak(job) ? "On a break" : "Typing";
    case "paused": return "Paused";
    case "done": return "Finished";
    case "error": return "Stopped";
    case "cancelled": return "Cancelled";
  }
}
