import { sql, type SQL } from "drizzle-orm";

import { workerProfiles } from "./schema";

/**
 * The ONE definition of "which `worker_profiles` row is this worker's profile".
 *
 * WHY A WORKER HAS MORE THAN ONE ROW AT ALL. `ProfilesRepository.create` is insert-only —
 * `ON CONFLICT (ai_job_id) DO NOTHING` — and `worker_profiles_worker_id_idx` is a plain,
 * non-unique index, so nothing in the database limits a worker to one row. One row is written
 * per extraction job, and `ProfilesService.extract` dedupes only within a single
 * `(worker_id, session_id)` pair, so every NEW interview adds a row unconditionally. That is
 * deliberate: the history is what the OIE Phase 9 distribution gate is measured from, and an
 * upsert would let a degraded extraction OVERWRITE a good profile rather than merely sit
 * beside it.
 *
 * THE DEFECT THIS CLOSES. Seven readers resolved "the" profile independently, and none of
 * them agreed:
 *
 *   - five ordered by `created_at DESC` alone,
 *   - `ReachRepository.findSignalRowByWorkerId` used `LIMIT 1` with NO `ORDER BY` at all —
 *     whichever row the planner happened to emit first,
 *   - `ReachRepository.listSignalRows` had neither ordering NOR per-worker dedup, so a worker
 *     with two rows entered the payer applicant pool TWICE and was counted twice in PACE
 *     supply.
 *
 * And not one of them looked at whether the newest row contained anything. When the ai-service
 * is unreachable, `AiService.extractProfile` returns `DraftProfileSchema.parse({})` — an empty
 * profile — which is persisted as a real row. Recency alone therefore hands every reader that
 * placeholder, and a worker who was fully profiled last week reads as unprofiled today because
 * one later extraction ran during an outage.
 *
 * WHY `profile_status <> 'draft'` AND NOT A SQL MIRROR OF `hasExtractedContent`.
 * `profile_status` IS that predicate, already evaluated and already persisted:
 * `ProfileExtractionProcessor.decideProfileStatus` assembles the row exactly as `create()` will
 * write it, runs `hasExtractedContent` over it, and stores `"extracted"` or `"draft"`
 * accordingly (with the fail-closed `blocked` leg also landing on `"draft"`). Re-deriving
 * content in SQL would create a SECOND definition that can drift from the TypeScript one — the
 * exact duplication CLAUDE.md §8 forbids — for no gain, since the answer is already a column.
 * `confirmed` is reachable only from `ProfilesRepository.confirm`, which runs on a profile the
 * worker has already been shown, so it too is non-draft.
 *
 * WHY CONTENT OUTRANKS RECENCY BUT `confirmed` DOES NOT OUTRANK EITHER. A placeholder is not a
 * profile, so it must never win: that is the defect. Beyond that this deliberately preserves
 * today's semantics — among rows that DID extract something, newest still wins. Promoting
 * `confirmed` above recency would be a different, product-visible change (it would pin a worker
 * to an older confirmed profile after a richer re-interview) and it is not this fix's to make.
 *
 * THE ORDER IS TOTAL. `created_at DESC` alone is not: two rows can share a millisecond, and two
 * readers resolving the same worker differently is precisely what this module exists to stop.
 * `id DESC` breaks the tie the same way `WorkerSkillsRepository` and the D2 backfill already
 * did, so the live path and the batch path cannot disagree.
 *
 * USE IT WITH `LIMIT 1` for a single worker, or as the tail of a `DISTINCT ON (worker_id)`
 * ordering for a pool read. Both are in the repository layer; nothing here computes policy.
 */
export const CURRENT_PROFILE_ORDER: readonly SQL[] = [
  // NOT NULL with a `'draft'` default, so there is no NULL leg to reason about. In Postgres
  // `true > false`, and DESC puts a row that extracted something ahead of one that did not.
  sql`(${workerProfiles.profileStatus} <> 'draft') desc`,
  sql`${workerProfiles.createdAt} desc`,
  sql`${workerProfiles.id} desc`,
];
