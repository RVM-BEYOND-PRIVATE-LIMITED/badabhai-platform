import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { jobPostings, type JobPostingAudience } from "./schema";

/**
 * #2746 — WHICH POSTINGS A BADABHAI WORKER MAY EVER SEE, by `job_postings.audience`.
 *
 * POSITIVE MEMBERSHIP, NOT `<> 'rvm_students'`. A fourth audience added to the CHECK later is
 * invisible to every BadaBhai worker until someone lists it here — a new audience fails closed,
 * never open. `badabhai_workers` is every posting that existed before migration 0162 and every
 * agency twin (`job_postings_twin_audience_chk`), so this predicate is TRUE for all of them and
 * no existing posting changes who sees it.
 */
export const BADABHAI_WORKER_AUDIENCES = [
  "badabhai_workers",
  "both",
] as const satisfies readonly JobPostingAudience[];

/**
 * The members as SQL literals. Literal rather than bound: the set is a closed, compile-time
 * vocabulary (the `satisfies` above pins every member to the CHECK's set), so the statement text
 * — and the parameter list every statement test pins — is the same wherever the fragment lands.
 */
const AUDIENCE_LITERALS = BADABHAI_WORKER_AUDIENCES.map((audience) => `'${audience}'`).join(", ");

/**
 * THE ONE SQL SPELLING of "a BadaBhai worker may see this posting": `<audience> IN
 * ('badabhai_workers', 'both')`. Every worker read that tests `hidden_at` / `status = 'open'`
 * puts this beside them, and the reach materialization (`materializeJobReachWithin`, the worker
 * reconcile) writes no `job_reach` row where it is false. No other file may spell an audience
 * literal (`job-visibility.static.test.ts`).
 *
 * The default renders `"job_postings"."audience"` and serves a drizzle `.where(and(...))` over
 * the unaliased table. A raw statement that aliases the table passes its own column:
 * ``reachesBadaBhaiWorkers(sql`jp.audience`)``.
 */
export function reachesBadaBhaiWorkers(audience: SQLWrapper = jobPostings.audience): SQL {
  return sql`${audience} IN (${sql.raw(AUDIENCE_LITERALS)})`;
}
