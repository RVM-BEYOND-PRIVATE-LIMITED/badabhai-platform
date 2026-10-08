import { and, eq } from "drizzle-orm";
import { type Database, jobs, jobPostings } from "@badabhai/db";
import type { TenantKey } from "./payer-tenant-scope";

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
 * Resolve `refId` to a `jobs` or `job_postings` row whose `payer_id` is exactly the TENANT key
 * `tenant` (ADR-0053: the acting org's anchor; the caller itself in mode `off`), or `null` when
 * neither table has one. Unknown and another tenant's id are deliberately the SAME `null` — the
 * caller cannot tell them apart, so neither can its client (no id oracle).
 *
 * DB access only, shared by the repositories that need it (unlocks, resume disclosures, applicant
 * stages) so the ownership query is spelled once. Each caller passes the `TenantKey` its service
 * resolved — never a raw id. Both lookups are primary-key reads projecting the id only,
 * run concurrently on the global pool so the answer's latency does not depend on which table
 * matched. Ownership, not status: a closed job or posting is still the payer's own context.
 * A read error propagates (fail closed — the caller writes nothing).
 */
export async function findOwnedJobRef(
  db: Database,
  refId: string,
  tenant: TenantKey,
): Promise<OwnedJobRef | null> {
  const [jobRows, postingRows] = await Promise.all([
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, refId), eq(jobs.payerId, tenant)))
      .limit(1),
    db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, refId), eq(jobPostings.payerId, tenant)))
      .limit(1),
  ]);
  // Ids are random v4 uuids minted per table, so at most one table matches; were both ever to
  // match, `jobs` wins (a disclosure would then store null, never a foreign or wrong id).
  if (jobRows.length > 0) return { kind: "job", id: refId };
  if (postingRows.length > 0) return { kind: "posting", id: refId };
  return null;
}

