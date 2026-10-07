import { getTableName, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { aiJobs, chatSessions, workerProfiles } from "./schema";

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

/**
 * #2075 — the persisted answer map of the chat session that PRODUCED a `worker_profiles` row, as a
 * correlated scalar subquery over the outer `worker_profiles` row. Select it beside the profile's
 * other signals; it yields a jsonb object or SQL NULL.
 *
 * THE CHAIN, ALL ALREADY PERSISTED (no migration): `worker_profiles.ai_job_id` → the
 * `profile_extraction` job (`ai_jobs` PK) → its `input_ref ->> 'session_id'` → `chat_sessions`
 * (filtered by the profile's own `worker_id`, served by `chat_sessions_worker_id_idx`). The
 * session id is compared as TEXT, never cast to uuid, so a malformed `input_ref` matches nothing
 * instead of failing the query.
 *
 * ONLY FOUR KEYS, not the whole envelope: `pack_id`, `answer_map` and the #2021 provenance stamps
 * `llm_led_turns` / `llm_draft_settled`. A missing key is JSON null, which the worker-only gate
 * (`isWorkerOnlyAnswerMap`, @badabhai/taxonomy) reads as "not worker-only": fail closed.
 *
 * WHY THE PROFILE'S OWN SESSION and not the worker's latest one: the match skills it feeds
 * (`genericPackChatMatchSkills`) must describe the SAME interview as the profile's `skills`
 * column, which #2021 wrote from this session. A newer interview that has not produced a profile
 * yet does not change the worker's derived set until it does.
 *
 * ONE DEFINITION for both writers of `worker_skill` (`WorkerSkillsRepository` and
 * `db:backfill:worker-skills`), like {@link CURRENT_PROFILE_ORDER}, so they cannot read different
 * evidence. Reads no name or phone: pack ids, answer values and two integers/booleans.
 */
export const PROFILE_SOURCE_SESSION_ANSWERS: SQL<unknown> = (() => {
  // EVERY COLUMN IS QUALIFIED BY HAND. Drizzle renders a column object interpolated into a
  // select-list `sql` fragment UNQUALIFIED when the outer query reads a single table, which turned
  // the correlation into `"worker_id" = "worker_id"` and `"id" = "ai_job_id"` (ambiguous / wrongly
  // correlated). So the subquery's tables get aliases, and the OUTER row is named by its table.
  const aj = sql.identifier("src_aj");
  const cs = sql.identifier("src_cs");
  const outer = sql.identifier(getTableName(workerProfiles));
  const col = (alias: ReturnType<typeof sql.identifier>, column: AnyPgColumn): SQL =>
    sql`${alias}.${sql.identifier(column.name)}`;
  const state = col(cs, chatSessions.conversationState);
  return sql<unknown>`(
  select jsonb_build_object(
    'pack_id', ${state} -> 'pack_id',
    'answer_map', ${state} -> 'answer_map',
    'llm_led_turns', ${state} -> 'llm_led_turns',
    'llm_draft_settled', ${state} -> 'llm_draft_settled'
  )
  from ${sql.identifier(getTableName(aiJobs))} as ${aj}
  inner join ${sql.identifier(getTableName(chatSessions))} as ${cs}
    on ${col(cs, chatSessions.workerId)} = ${col(outer, workerProfiles.workerId)}
   and ${col(cs, chatSessions.id)}::text = ${col(aj, aiJobs.inputRef)} ->> 'session_id'
  where ${col(aj, aiJobs.id)} = ${col(outer, workerProfiles.aiJobId)}
    and ${col(aj, aiJobs.jobType)} = 'profile_extraction'
  limit 1
)`;
})();
