import type { Database } from "./client";
import { jobPostingWorkerVisibility, type JobWorkerVisibilityOrigin } from "./schema";

/**
 * #2891 — HOLD A CAMPUS-ORIGIN POSTING FROM BADABHAI WORKERS until an admin opens it.
 *
 * Writes the posting's `job_posting_worker_visibility` row as `off`. Call it BEFORE the posting can
 * be seen: in the transaction that inserts it, or while it is still a draft. Idempotent: a posting
 * that already has a row keeps it, so a re-run never turns an admin's `on` back to `off`.
 *
 * Every writer of a Campus-origin posting goes through this (the Campus post-for-company route,
 * the import of live Campus jobs), never a hand insert.
 */
export async function holdPostingFromWorkers(
  tx: Database,
  jobPostingId: string,
  origin: JobWorkerVisibilityOrigin,
): Promise<void> {
  await tx
    .insert(jobPostingWorkerVisibility)
    .values({ jobPostingId, origin, state: "off" })
    .onConflictDoNothing({ target: jobPostingWorkerVisibility.jobPostingId });
}
