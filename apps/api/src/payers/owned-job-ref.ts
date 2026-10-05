import { and, eq } from "drizzle-orm";
import { type Database, jobs, jobPostings } from "@badabhai/db";

/**
 * #1899 — the job reference a payer-session write may carry, once ownership is proven.
 *
 * A payer refers to "the job" by one of two ids, and the payer surfaces accept either: an
 * agency's legacy `jobs` row or a company `job_postings` row (the same split
 * `PayerApplicantsService.listForOwned` resolves for the applicants list). `kind` says which
 * table matched; each write then keeps only the kind its own FK can hold.
 */
export interface OwnedJobRef {
  readonly kind: "job" | "posting";
  readonly id: string;
}

/**
 * Resolve `refId` to a `jobs` or `job_postings` row whose `payer_id` is exactly `payerId`, or
 * `null` when neither table has one. Unknown and another payer's id are deliberately the SAME
 * `null` — the caller cannot tell them apart, so neither can its client (no id oracle).
 *
 * DB access only, shared by the repositories that need it (unlocks, resume disclosures) so the
 * ownership query is spelled once. Both lookups are primary-key reads projecting the id only,
 * run concurrently on the global pool so the answer's latency does not depend on which table
 * matched. Ownership, not status: a closed job or posting is still the payer's own context.
 * A read error propagates (fail closed — the caller writes nothing).
 */
export async function findOwnedJobRef(
  db: Database,
  refId: string,
  payerId: string,
): Promise<OwnedJobRef | null> {
  const [jobRows, postingRows] = await Promise.all([
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, refId), eq(jobs.payerId, payerId)))
      .limit(1),
    db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, refId), eq(jobPostings.payerId, payerId)))
      .limit(1),
  ]);
  if (jobRows.length > 0) return { kind: "job", id: refId };
  if (postingRows.length > 0) return { kind: "posting", id: refId };
  return null;
}

/**
 * How a write treats its caller-supplied job reference (#1899).
 *
 *  - `"normalise"` — the ops routes (InternalServiceGuard, `payer_id` from the body). The #1903 /
 *    #1898 behaviour, unchanged: an id the row's FK cannot hold is stored and evented as null.
 *  - `"payer_owned"` — the payer-session routes. The reference must be null or a job / posting
 *    the SESSION payer owns; anything else is refused with the surface's neutral body before
 *    anything is emitted or written.
 */
export type JobRefPolicy = "normalise" | "payer_owned";
