import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  applications,
  chatSessions,
  generatedResumes,
  questionPackItems,
  workerDevices,
  workerOccupations,
  workerPackAnswers,
  workerProfiles,
  workers,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AdminFunnelTestAccounts } from "./admin-funnel.dto";

/** The cohort bound — the funnel's single source of cohort truth (see listCohort). */
export interface FunnelCohortFilter {
  signupFrom?: Date;
  signupTo?: Date;
  testAccounts: AdminFunnelTestAccounts;
}

/** One cohort member, reduced to what the funnel needs (faceless — labels only). */
export interface FunnelCohortWorker {
  id: string;
  city: string | null;
  language: string | null;
  hasPhoto: boolean;
}

/** One stamped (pack_id, pack_version) pair from a worker's own answer rows. */
export interface FunnelStampedPair {
  packId: string;
  packVersion: number;
}

/**
 * SELECT-ONLY data access for the ONBOARDING FUNNEL (B14, #2568) — every table the
 * funnel reads EXCEPT the event spine.
 *
 * The funnel's two `events` reads (search counts, kit downloads) deliberately do NOT
 * live here. They are bulk methods on `AdminEventsRepository`, because `events` has
 * exactly ONE admin reader by design (build-blocked in `admin-static-guards.test.ts`)
 * — `AdminFunnelService` composes the two repositories, the same split the per-worker
 * journey (`AdminWorkerJourneyService` + `AdminEventsRepository`) already makes.
 *
 * ── ONE COHORT DEFINITION, USED ONE WAY ─────────────────────────────────────────────
 * `listCohort` is the single source of who is in the base. Every per-worker read below
 * takes the cohort's ids and matches them with `inArray`, chunked into bounded batches
 * — never a 50K-element `IN (...)` in one statement (driver parameter ceiling), and
 * never an `= ANY($array)` (drizzle renders an interpolated array as a parenthesised
 * scalar list, which Postgres cannot cast to `uuid[]`).
 *
 * NO WRITES, EVER. There is no insert/update/delete in this file and there must never
 * be one. No PII is projected: ids, labels, counts and booleans only — the photo key,
 * answer values and conversation state never leave Postgres (reductions happen in SQL
 * where a reduction is needed at all).
 */
@Injectable()
export class AdminFunnelRepository {
  /**
   * Largest single `IN (...)` id list. 2000 keeps every statement far under the
   * driver's parameter ceiling (65535) while keeping the batch count — and therefore
   * the round trips — small: a 50K cohort is 25 indexed probes per signal, not 50K of
   * them.
   */
  private static readonly ID_BATCH_MAX = 2000;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The signup-range / test-account predicate — the ONE cohort definition. */
  private cohortClauses(filter: FunnelCohortFilter): SQL[] {
    const clauses: SQL[] = [];
    if (filter.signupFrom !== undefined) clauses.push(gte(workers.createdAt, filter.signupFrom));
    if (filter.signupTo !== undefined) clauses.push(lt(workers.createdAt, filter.signupTo));
    if (filter.testAccounts === "exclude") clauses.push(eq(workers.isTestAccount, false));
    if (filter.testAccounts === "only") clauses.push(eq(workers.isTestAccount, true));
    return clauses;
  }

  /**
   * The cohort: workers whose sign-up falls in the window, with the test-account policy
   * applied.
   *
   * INDEX: `workers_admin_keyset_idx` on `(created_at DESC, id DESC)` serves the range.
   */
  async listCohort(filter: FunnelCohortFilter): Promise<FunnelCohortWorker[]> {
    const clauses = this.cohortClauses(filter);
    const rows = await this.db
      .select({
        id: workers.id,
        city: workers.currentCity,
        language: workers.preferredLanguage,
        // Reduced to a boolean IN POSTGRES — the storage key addresses a face photo
        // and is never fetched (the per-worker journey's `findWorkerCore` rule).
        hasPhoto: sql<boolean>`${workers.photoStorageKey} IS NOT NULL`,
      })
      .from(workers)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(workers.id);
    return rows.map((r) => ({
      id: r.id,
      city: r.city,
      language: r.language,
      hasPhoto: r.hasPhoto,
    }));
  }

  /** Run `work` over `ids` in bounded batches, merging the per-batch maps. */
  private async batched<K, V>(
    ids: readonly string[],
    work: (batch: string[]) => Promise<Map<K, V>>,
  ): Promise<Map<K, V>> {
    const out = new Map<K, V>();
    for (let i = 0; i < ids.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = ids.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      for (const [k, v] of await work(batch)) out.set(k, v);
    }
    return out;
  }

  /**
   * Each worker's primary trade: the lowest `sort_order` — the worker's own ordering,
   * first position. Workers with no occupation row are absent from the map (the service
   * buckets them as unknown, never drops them).
   *
   * INDEX: `wo_worker_role_uq` on `(worker_id, role_id)` leads on the worker.
   */
  async primaryTradeByWorker(workerIds: readonly string[]): Promise<Map<string, string>> {
    return this.batched(workerIds, async (batch) => {
      const rows = await this.db
        .selectDistinctOn([workerOccupations.workerId], {
          workerId: workerOccupations.workerId,
          roleId: workerOccupations.roleId,
        })
        .from(workerOccupations)
        .where(inArray(workerOccupations.workerId, [...batch]))
        .orderBy(workerOccupations.workerId, workerOccupations.sortOrder);
      return new Map(rows.map((r) => [r.workerId, r.roleId]));
    });
  }

  /**
   * Each worker's latest NON-REVOKED device app version. A revoked device is stale by
   * definition (superseded registration), and a null version is an old build that never
   * sent one — both read as "unknown" downstream, never guessed at.
   *
   * INDEX: `worker_devices_worker_id_idx` on `(worker_id)`.
   */
  async appVersionByWorker(workerIds: readonly string[]): Promise<Map<string, string | null>> {
    return this.batched(workerIds, async (batch) => {
      const rows = await this.db
        .selectDistinctOn([workerDevices.workerId], {
          workerId: workerDevices.workerId,
          appVersion: workerDevices.appVersion,
        })
        .from(workerDevices)
        .where(
          and(inArray(workerDevices.workerId, [...batch]), sql`${workerDevices.revokedAt} IS NULL`),
        )
        .orderBy(workerDevices.workerId, desc(workerDevices.lastSeenAt));
      return new Map(rows.map((r) => [r.workerId, r.appVersion]));
    });
  }

  /**
   * The `(pack_id, pack_version)` pairs each worker's OWN answer rows stamp — the
   * durable half of the profiling denominator (see the per-worker journey's
   * `answeredPackVersions`). Ordered + deterministic; the service adds the universal
   * tail under the same rule the per-worker page uses.
   *
   * INDEX: `wpa_worker_question_uq` on `(worker_id, pack_id, question_key)` leads on
   * the worker.
   */
  async stampedPairsByWorker(
    workerIds: readonly string[],
  ): Promise<Map<string, FunnelStampedPair[]>> {
    const out = new Map<string, FunnelStampedPair[]>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .selectDistinct({
          workerId: workerPackAnswers.workerId,
          packId: workerPackAnswers.packId,
          packVersion: workerPackAnswers.packVersion,
        })
        .from(workerPackAnswers)
        .where(inArray(workerPackAnswers.workerId, [...batch]))
        .orderBy(
          workerPackAnswers.workerId,
          workerPackAnswers.packId,
          workerPackAnswers.packVersion,
        );
      for (const r of rows) {
        const list = out.get(r.workerId) ?? [];
        list.push({ packId: r.packId, packVersion: r.packVersion });
        out.set(r.workerId, list);
      }
    }
    return out;
  }

  /**
   * The question keys each pack pair owns. Keyed `${packId}:${packVersion}` — the
   * denominator's unit (see the per-worker journey's `countPackItems`: a pair with no
   * items is MISSING, which the service reads as a retired version, not as zero).
   *
   * INDEX: `qpi_pack_idx` on `(pack_id, pack_version)`.
   */
  async itemKeysByPair(pairs: ReadonlyArray<FunnelStampedPair>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (pairs.length === 0) return out;
    const clauses = pairs.map((p) =>
      and(eq(questionPackItems.packId, p.packId), eq(questionPackItems.packVersion, p.packVersion)),
    );
    const rows = await this.db
      .select({
        packId: questionPackItems.packId,
        packVersion: questionPackItems.packVersion,
        questionKey: questionPackItems.questionKey,
      })
      .from(questionPackItems)
      .where(clauses.length === 1 ? clauses[0] : or(...clauses));
    for (const r of rows) {
      const key = `${r.packId}:${r.packVersion}`;
      const list = out.get(key) ?? [];
      list.push(r.questionKey);
      out.set(key, list);
    }
    return out;
  }

  /**
   * DISTINCT settled question keys per worker — `answered` + `declined` ONLY
   * (`SETTLED_ANSWER_STATUSES`, the same closed set the per-worker journey derives its
   * numerator from). Rows, not progress: the service intersects these with the pairs'
   * keys, which is what makes the unit questions rather than rows.
   */
  async settledKeysByWorker(workerIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .selectDistinct({
          workerId: workerPackAnswers.workerId,
          questionKey: workerPackAnswers.questionKey,
        })
        .from(workerPackAnswers)
        .where(
          and(
            inArray(workerPackAnswers.workerId, [...batch]),
            sql`${workerPackAnswers.status} in ('answered', 'declined')`,
          ),
        );
      for (const r of rows) {
        const list = out.get(r.workerId) ?? [];
        list.push(r.questionKey);
        out.set(r.workerId, list);
      }
    }
    return out;
  }

  /**
   * Workers with a `current_city` in ANY session's `prefilled_keys` — #1504 item 5
   * (city-seed). Reads every session's persisted state, not only the latest, because a
   * re-interview carries the seed on each session's own row (the per-worker journey's
   * `workerPrefilledKeys` rule, including its `jsonb_typeof` guard and key allow-list).
   */
  async prefilledCityWorkers(workerIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .selectDistinct({ workerId: chatSessions.workerId })
        .from(chatSessions)
        .where(
          and(
            inArray(chatSessions.workerId, [...batch]),
            sql`jsonb_typeof(${chatSessions.conversationState} -> 'prefilled_keys') = 'array'`,
            sql`${chatSessions.conversationState} -> 'prefilled_keys' ? 'current_city'`,
          ),
        );
      for (const r of rows) out.add(r.workerId);
    }
    return out;
  }

  /**
   * Workers holding at least one resume. Same table + index as the per-worker journey
   * (`generated_resumes_worker_id_idx`) and the same `count > 0` rule, so the two
   * surfaces cannot disagree about whether a worker has a resume.
   */
  async resumeFlags(workerIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .select({ workerId: generatedResumes.workerId })
        .from(generatedResumes)
        .where(inArray(generatedResumes.workerId, [...batch]))
        .groupBy(generatedResumes.workerId);
      for (const r of rows) out.add(r.workerId);
    }
    return out;
  }

  /**
   * Each worker's CURRENT profile status — resolved with `CURRENT_PROFILE_ORDER`, the
   * ONE definition of "which row is this worker's profile", byte-identical to the
   * per-worker journey's `currentProfile`. Workers with no row are absent (null =
   * never profiled downstream).
   */
  async profileStatuses(workerIds: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .selectDistinctOn([workerProfiles.workerId], {
          workerId: workerProfiles.workerId,
          status: workerProfiles.profileStatus,
        })
        .from(workerProfiles)
        .where(inArray(workerProfiles.workerId, [...batch]))
        .orderBy(workerProfiles.workerId, ...CURRENT_PROFILE_ORDER);
      for (const r of rows) out.set(r.workerId, r.status);
    }
    return out;
  }

  /**
   * Application counts per worker per action.
   *
   * The table, not `application.submitted` — that event's subject is the JOB, so a
   * per-worker count off it is unindexed (the per-worker journey's DTO header states
   * the same rule).
   */
  async applicationFlags(
    workerIds: readonly string[],
  ): Promise<Map<string, { applied: number; skipped: number }>> {
    const out = new Map<string, { applied: number; skipped: number }>();
    for (let i = 0; i < workerIds.length; i += AdminFunnelRepository.ID_BATCH_MAX) {
      const batch = workerIds.slice(i, i + AdminFunnelRepository.ID_BATCH_MAX);
      if (batch.length === 0) continue;
      const rows = await this.db
        .select({
          workerId: applications.workerId,
          action: applications.action,
          n: count(),
        })
        .from(applications)
        .where(inArray(applications.workerId, [...batch]))
        .groupBy(applications.workerId, applications.action);
      for (const r of rows) {
        const entry = out.get(r.workerId) ?? { applied: 0, skipped: 0 };
        if (r.action === "applied") entry.applied = r.n;
        else if (r.action === "skipped") entry.skipped = r.n;
        out.set(r.workerId, entry);
      }
    }
    return out;
  }
}
