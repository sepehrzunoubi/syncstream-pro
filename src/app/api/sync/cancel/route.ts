import { NextRequest, NextResponse } from "next/server";
import { getJob, setJob, removeActiveJob } from "@/lib/sync-store";

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

  if (job.status === "done" || job.status === "error") {
    return NextResponse.json({ status: job.status, message: "Job already finished" });
  }

  await setJob({ ...job, status: "cancelled", activity: "Cancelled", lastUpdate: Date.now() });
  await removeActiveJob(jobId);

  return NextResponse.json({ status: "cancelled" });
}
