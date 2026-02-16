import { NextRequest, NextResponse } from "next/server";
import { getJob, getPayload, setJob, type SyncJobPayload } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { jobId } = await req.json();

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== "paused") {
    return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
  }

  // Get the saved payload with the original plan + current position
  const savedPayload = await getPayload(jobId);
  if (!savedPayload) {
    return NextResponse.json({ error: "Job payload not found — cannot resume" }, { status: 404 });
  }

  // Refresh tokens from cookies (they may have been refreshed since pause)
  const token = req.cookies.get("google_access_token")?.value;
  const refreshToken = req.cookies.get("google_refresh_token")?.value;

  const payload: SyncJobPayload = {
    ...savedPayload,
    accessToken: token || savedPayload.accessToken,
    refreshToken: refreshToken || savedPayload.refreshToken,
  };

  // Mark job as running again
  await setJob({ ...job, status: "running", activity: "Resuming…", lastUpdate: Date.now() });

  // Fire-and-forget: kick off background processing from saved position
  const origin = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
  fetch(`${origin}/api/sync/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error("Failed to resume sync/process:", err);
  });

  return NextResponse.json({ jobId, resumed: true });
}
