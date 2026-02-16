import { NextRequest, NextResponse } from "next/server";
import { getJob, deleteJob, jobToEvent } from "@/lib/sync-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const job = await getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";

  // Auto-cleanup: delete finished jobs from Redis to recycle free-tier storage
  if (isTerminal) {
    deleteJob(jobId).catch(() => {});
  }

  return NextResponse.json({
    jobId: job.id,
    jobStatus: job.status,
    event: jobToEvent(job),
  });
}
