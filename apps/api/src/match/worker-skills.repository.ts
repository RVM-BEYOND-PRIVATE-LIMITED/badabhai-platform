import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  type Database,
  jobPostings,
  materializeJobReachWithin,
  workerAttributes,
  workerIndustryTenure,
  workerOccupations,
  workerProfiles,
  workerSkills,
} from "@badabhai/db";
import { packAnswerFromStoredRow, type PackAnswer } from "@badabhai/taxonomy";
import { DATABASE } from "../database/database.module";

/** The faceless signal columns the coarse derivation reads off the latest profile. */
export interface WorkerProfileSignals {
  canonicalRoleId: string | null;
  /** Canonical corpus (`skill_*`) ATTRIBUTE ids — never free text (ADR-0030 SG-3). */
  profileSkills: string[];
  /** `experience.total_years`, or null when the extraction never resolved one. */
  totalYears: number | null;
}

/** One `worker_skill` row to upsert. `wants`/dates are set by the writer, not here. */
export interface DerivedWorkerSkillRow {
  skillId: string;
  industryId: string;
  monthsBucketed: number;
}

/** One `worker_industry_tenure` row to upsert. */
export interface WorkerTenureRow {
  industryId: string;
  calendarMonths: number;
}

/**
 * A transaction executor. Typed as `Database` and cast at the `transaction` seam, matching
 * `ChatRepository` / `AdminActionsRepository`: Drizzle's real `PgTransaction` is structurally
 * compatible for every query builder used here but lacks `$client`, so the narrower true type
 * would fight the `Database`-typed helpers this class already passes around.
 */
export type Tx = Database;

/**
 * Drizzle data access for the Matching V1 SUPPLY side (migration 0053) plus the
 * per-worker `job_reach` reconciliation (migration 0055).
 *
 * Pure data access. Every decision about WHAT to write — which skills a worker has,
 * how many months, whether he wants them — is made by `@badabhai/match-engine` and
 * {@link ../match/worker-skills.service.ts WorkerSkillsService}. Nothing here computes
 * a tier, a month count, or a rank.
 *
 * PRIVACY: reads only faceless signal columns (opaque worker id, `canonical_role_id`,
 * the `skills` id array, `experience.total_years`). It never touches phone/name, and
 * every value it writes is an id, an enum or an integer.
 */
@Injectable()
export class WorkerSkillsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The worker's CURRENT profile signals, or undefined when he has no profile yet.
   * `CURRENT_PROFILE_ORDER` is the same total order the D2 backfill uses, so the live path and
   * the batch path can never disagree about which row is the profile.
   *
   * This already had a TOTAL order (`created_at DESC, id DESC`) — it was the only reader that
   * did — but ordering by recency alone still handed it the empty row an AI-down extraction
   * leaves behind, which here means the worker's derived skills get rebuilt from nothing.
   */
  async findLatestProfileSignals(workerId: string): Promise<WorkerProfileSignals | undefined> {
    const rows = await this.db
      .select({
        canonicalRoleId: workerProfiles.canonicalRoleId,
        skills: workerProfiles.skills,
        experience: workerProfiles.experience,
      })
      .from(workerProfiles)
      .where(eq(workerProfiles.workerId, workerId))
      .orderBy(...CURRENT_PROFILE_ORDER)
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;

    const experience = asRecord(row.experience);
    const totalYears =
      experience &&
      typeof experience.total_years === "number" &&
      Number.isFinite(experience.total_years)
        ? experience.total_years
        : null;

    return {
      canonicalRoleId: row.canonicalRoleId,
      profileSkills: Array.isArray(row.skills) ? row.skills.filter(isString) : [],
      totalYears,
    };
  }

  /**
   * This worker's DECLARED SECONDARY occupation role ids (migration 0114, Layer A (f)), in the
   * worker's own order.
   *
   * It returns CLOSED `role_*` ids and decides nothing: `deriveWorkerSkills` applies the same
   * `ROLE_TO_MATCH_SKILL` bridge the primary role gets, and an id the bridge does not cover
   * contributes no skill row. That split is why this is a query here and a rule in the engine.
   *
   * A missing table (migration not applied) throws — the rebuild callers treat it exactly like
   * any other rebuild failure (`rebuildQuietly` logs and moves on), and the migration's
   * schema-contract entry names the surfaces. See `0114_worker_occupation.sql`.
   */
  async findSecondaryRoleIds(workerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ roleId: workerOccupations.roleId })
      .from(workerOccupations)
      .where(eq(workerOccupations.workerId, workerId))
      .orderBy(asc(workerOccupations.sortOrder));
    return rows.map((row) => row.roleId);
  }

  /**
   * This worker's closed-set role-pack answers, each carrying the pack it was answered under.
   *
   * CARRIES `pack_id` PER ROW (R12 §2.1). It used to return `attribute_key → [option_key]` and
   * throw the provenance away, so `corpusSkillsForPackAttributes` had no way to tell a turner's
   * `measuring_tools` from a machinist's and applied one dictionary to both. The column has been
   * on `worker_attributes` all along; nothing here was reading it.
   *
   * PER ROW, NOT PER WORKER, because a worker's bag genuinely mixes provenances — `qp_universal`'s
   * tail and a role pack are both in there, and a single "his pack" would be wrong for one of them.
   *
   * PURE DATA ACCESS, like everything else here. It returns the option keys the worker tapped and
   * decides nothing about what they mean — that is `pack-attribute-skills.ts`, and keeping the
   * two apart is why a taxonomy retag is a one-file change rather than a query rewrite.
   *
   * Reads BOTH value columns because the pack mixes answer types: a `multi_select` lands in
   * `value_text_list` and a `single_select` in `value_text`, and reading only the first silently
   * drops `programming_level` and `drawing_reading` — the two questions that carry the only chips
   * able to reach a vacancy other than a turner's.
   *
   * PRIVACY: option keys are closed-set enum values authored in the pack JSON. No free text, and
   * nothing a worker typed, ever reaches this path.
   */
  async findPackAttributeOptions(workerId: string): Promise<PackAnswer[]> {
    const rows = await this.db
      .select({
        attributeKey: workerAttributes.attributeKey,
        valueText: workerAttributes.valueText,
        valueTextList: workerAttributes.valueTextList,
        packId: workerAttributes.packId,
      })
      .from(workerAttributes)
      .where(eq(workerAttributes.workerId, workerId));

    return rows.flatMap((row) => {
      const answer = packAnswerFromStoredRow(row);
      return answer === null ? [] : [answer];
    });
  }

  /**
   * Replace this worker's `derived_coarse` skill rows with `rows`, and rebuild his
   * industry tenure — ONE transaction, so a reader never sees half a rebuild.
   *
   * THE OWNERSHIP RULE, enforced at the DB in three places:
   *  - the upsert's `setWhere source='derived_coarse'` means a conflicting row a HUMAN
   *    authored (`interview` / `ops`) is left byte-identical;
   *  - the prune's `WHERE source='derived_coarse'` means only rows this writer owns are
   *    ever deleted;
   *  - neither statement can reach an `interview`/`ops` row even if the caller passes a
   *    skill set that no longer contains it.
   * That asymmetry is the whole reason the future wants-toggle and a per-stint
   * interview writer are safe to add later without re-auditing this path.
   *
   * Returns the ids written, so the caller can reconcile reach against exactly them.
   */
  async replaceDerivedSkillsAndTenure(
    workerId: string,
    rows: readonly DerivedWorkerSkillRow[],
    tenure: readonly WorkerTenureRow[],
    now: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        await tx
          .insert(workerSkills)
          .values({
            workerId,
            skillId: row.skillId,
            industryId: row.industryId,
            monthsBucketed: row.monthsBucketed,
            wants: true,
            source: "derived_coarse",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [workerSkills.workerId, workerSkills.skillId],
            set: {
              industryId: row.industryId,
              monthsBucketed: row.monthsBucketed,
              updatedAt: now,
            },
            // NEVER overwrite what a worker or an ops human actually said.
            setWhere: eq(workerSkills.source, "derived_coarse"),
          });
      }

      // Prune the derived rows whose skill left the set. Scoped to this worker AND to
      // `derived_coarse` — an `interview`/`ops` row survives a re-derivation forever.
      const keep = rows.map((r) => r.skillId);
      await tx
        .delete(workerSkills)
        .where(
          and(
            eq(workerSkills.workerId, workerId),
            eq(workerSkills.source, "derived_coarse"),
            keep.length > 0 ? notInArray(workerSkills.skillId, keep) : undefined,
          ),
        );

      // Rebuild tenure. Delete-then-insert rather than upsert-then-prune: the row count
      // is at most a handful per worker and the PK is (worker_id, industry_id), so this
      // is one index scan either way and it cannot leave a stale industry behind.
      await tx.delete(workerIndustryTenure).where(eq(workerIndustryTenure.workerId, workerId));
      if (tenure.length > 0) {
        await tx.insert(workerIndustryTenure).values(
          tenure.map((t) => ({
            workerId,
            industryId: t.industryId,
            calendarMonths: t.calendarMonths,
            computedAt: now,
          })),
        );
      }
    });
  }

  /** The skill ids this worker currently WANTS — the reach driver's input set. */
  async listWantedSkillIds(workerId: string): Promise<string[]> {
    return this.listWantedSkillIdsWithin(this.db, workerId);
  }

  /**
   * The same read on a caller's executor, so a `wants` flip can READ ITS OWN WRITE BACK
   * inside the transaction that made it. That read-back is not ceremony: the flip touches one
   * row, and the reach set must be reconciled against the whole set as the database now holds
   * it, not against whatever the caller believes the set to be.
   */
  private async listWantedSkillIdsWithin(executor: Tx, workerId: string): Promise<string[]> {
    const rows = await executor
      .select({ skillId: workerSkills.skillId })
      .from(workerSkills)
      .where(and(eq(workerSkills.workerId, workerId), eq(workerSkills.wants, true)));
    return rows.map((r) => r.skillId);
  }

  /**
   * MOMENT ①/② TAIL — reconcile THIS WORKER's rows in `job_reach`.
   *
   * Without it a newly-profiled worker never appears in the reach set of a posting that
   * was materialized before he existed, and the feed silently rots: postings keep
   * serving the workers they saw at publish time and nobody else, forever.
   *
   * ONE TRANSACTION, delete-then-insert, scoped to `worker_id`:
   *  1. drop his rows for every open/paused posting (a closed posting's history is left
   *     alone — it serves nobody and deleting it would churn the widest table for no
   *     reader);
   *  2. re-insert from the postings whose `reach_skill_ids` OVERLAP his wanted skills,
   *     using the SAME `MIN(CASE ...)` / `ARRAY_AGG(...)[1]` shape as
   *     `packages/db/src/materialize-job-reach.ts`, so tier + matched skill can never
   *     disagree between the publish path and the profile path.
   *
   * `reach_skill_ids ?| $skills` is the jsonb key-existence operator, served by
   * `job_postings_reach_ops_gin` (default `jsonb_ops`, migration 0127, TD141). The older
   * `job_postings_reach_gin` is `jsonb_path_ops`, which serves only `@>`, `@?` and `@@` — it
   * backs the `@> to_jsonb(skill)` containment join below, never `?|`.
   *
   * ⚠️ ARRAYS GO THROUGH `dsql.param()`. Drizzle's `sql` template expands a bare JS array
   * into a comma-separated placeholder list (a RECORD), so `${skills}::text[]` fails at
   * runtime with `42846: cannot cast type record to text[]`. Verified in
   * `materialize-job-reach.ts` against a live Postgres; do not "simplify" it back.
   */
  async reconcileReachForWorker(
    workerId: string,
    wantedSkillIds: readonly string[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.reconcileReachWithin(tx as unknown as Tx, workerId, wantedSkillIds);
    });
  }

  /**
   * THE WANTS FLIP — the worker says yes/no to ONE skill, and `job_reach` moves with it.
   *
   * ONE TRANSACTION, and that is the invariant this phase exists to make true: flipping
   * `wants` and reconciling `job_reach` commit together. A crash between the two would leave
   * the worker reachable through a skill he had just declined (or invisible through one he had
   * just re-enabled), and no reader could tell the state was half-applied.
   *
   * THE WANTED SET IS READ BACK INSIDE THE TRANSACTION, never computed from the flip. A worker
   * has many rows; this write touches one, and the reach set must be reconciled against the
   * whole set as the database now holds it — the same reason `rebuildForWorker` reads the set
   * back before reconciling.
   *
   * `source = 'interview'` because a worker answering "do you want this work?" IS the interview
   * speaking. It is the one source the coarse re-derivation may not rewrite
   * (`packages/db/src/schema/match.ts:26-30`), and it is what makes the opt-out durable:
   * `wants` alone would not be enough, because a re-derivation that no longer derives the skill
   * would PRUNE the row and a later one would re-propose it with `wants: true`.
   *
   * Returns `false` when the worker holds no such row — the caller 404s, nothing moved, and
   * no event is emitted.
   */
  async setWantsAndReconcile(
    workerId: string,
    skillId: string,
    wants: boolean,
    now: Date,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as Tx;
      const updated = await executor
        .update(workerSkills)
        .set({ wants, source: "interview", updatedAt: now })
        .where(and(eq(workerSkills.workerId, workerId), eq(workerSkills.skillId, skillId)))
        .returning({ skillId: workerSkills.skillId });
      if (updated.length === 0) return false;

      await this.reconcileReachWithin(
        executor,
        workerId,
        await this.listWantedSkillIdsWithin(executor, workerId),
      );
      return true;
    });
  }

  /**
   * THE CLEAR-ALL EXIT — every `worker_skill` row the worker holds is declined in ONE
   * transaction, and `job_reach` is reconciled once against the resulting (empty) wanted set.
   * The pre-read, the UPDATE and the reconcile all ride that one transaction.
   *
   * UPDATE, NOT DELETE, and the difference is the whole point. Deleting the rows would let the
   * next profile-write rebuild recreate them `wants: true`, so the exit would silently undo
   * itself on the next extraction. Stamping every row `wants: false, source='interview'` is
   * exactly the state the coarse re-derivation is forbidden to overwrite — the worker's exit
   * is as durable as the per-skill one, and his rows (with their months) survive to be turned
   * back on.
   *
   * EVERY ROW IS RE-STAMPED, ON OR OFF. The UPDATE's only predicate is the worker: an
   * already-declined `derived_coarse` row must still become `interview`, or the next
   * re-derivation could flip it back on. So the UPDATE matches every row he holds on every call,
   * and its row count says nothing about what this call changed (#1850).
   *
   * RETURNS THE SKILL IDS THIS CALL SWITCHED FROM ON TO OFF — the rows that were `wants = true`
   * when the transaction locked them. Every row is `wants = false` afterwards, so "wanted
   * before" IS "switched off by this call". A repeat call returns `[]` and still reconciles
   * (nothing is wanted, so his stale live reach rows go). Ids, not a count: which of them are
   * match skills is the closed-vocabulary rule, and that is the service's, not a query's.
   *
   * THE PRE-READ LOCKS EVERY ROW (`FOR UPDATE`), not just the wanted ones. It is the same lock
   * set the UPDATE takes anyway, one statement earlier — and it is what stops a concurrent
   * per-skill toggle landing between the read and the UPDATE: an OFF row turned ON in that gap
   * would be switched off by this call but missing from what it returns.
   *
   * ONE GAP IS LEFT, AND IT ONLY UNDERCOUNTS. A row a concurrent rebuild INSERTS between the
   * pre-read and the UPDATE was never locked, so it is switched off but not returned. The worker
   * never saw it in GET, so the count is never higher than what he switched off.
   */
  async clearAllWantsAndReconcile(workerId: string, now: Date): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as Tx;
      const before = await executor
        .select({ skillId: workerSkills.skillId, wants: workerSkills.wants })
        .from(workerSkills)
        .where(eq(workerSkills.workerId, workerId))
        .for("update");

      await executor
        .update(workerSkills)
        .set({ wants: false, source: "interview", updatedAt: now })
        .where(eq(workerSkills.workerId, workerId));

      await this.reconcileReachWithin(
        executor,
        workerId,
        await this.listWantedSkillIdsWithin(executor, workerId),
      );
      return before.filter((row) => row.wants).map((row) => row.skillId);
    });
  }

  /**
   * The reconcile body, on a caller's executor so it can ride an ALREADY-OPEN transaction
   * (`setWantsAndReconcile`, `clearAllWantsAndReconcile`) or open its own
   * (`reconcileReachForWorker`). Nested `db.transaction` calls would be a second, independent
   * transaction — not atomic with the flip — so the flip paths must run this one, not the
   * wrapper.
   */
  private async reconcileReachWithin(
    tx: Tx,
    workerId: string,
    wantedSkillIds: readonly string[],
  ): Promise<void> {
    // 1. Clear his rows on every LIVE posting. `paused` is included because a pause is
    //    reversible (B1) and a resumed posting must not carry a stale reach set.
    await tx.execute(dsql`
      DELETE FROM job_reach jr
      USING job_postings jp
      WHERE jr.worker_id = ${workerId}::uuid
        AND jp.id = jr.job_posting_id
        AND jp.status IN ('open', 'paused')
    `);

    if (wantedSkillIds.length === 0) return; // he supplies nothing: reaches nobody.

    const skills = dsql.param([...wantedSkillIds]);
    // 2. Re-insert. The GROUP BY is per posting (the materializer groups per worker for
    //    one posting; here it is one worker across postings) — same MIN/ARRAY_AGG rule.
    await tx.execute(dsql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      SELECT jp.id,
             ${workerId}::uuid,
             MIN(CASE WHEN jp.match_skill_ids @> to_jsonb(ws.skill_id) THEN 1 ELSE 2 END),
             (ARRAY_AGG(ws.skill_id ORDER BY (jp.match_skill_ids @> to_jsonb(ws.skill_id)) DESC,
                                             ws.months_bucketed DESC))[1]
      FROM job_postings jp
      JOIN worker_skill ws
        ON ws.worker_id = ${workerId}::uuid
       AND ws.wants
       AND jp.reach_skill_ids @> to_jsonb(ws.skill_id)
      WHERE jp.status IN ('open', 'paused')
        AND jp.reach_skill_ids ?| ${skills}::text[]
      GROUP BY jp.id
      ON CONFLICT (job_posting_id, worker_id) DO UPDATE
        SET match_tier       = EXCLUDED.match_tier,
            matched_skill_id = EXCLUDED.matched_skill_id,
            computed_at      = now()
    `);
  }

  /**
   * How many workers a set of skills currently reaches — the live counter behind the
   * posting form's "reaches 61 workers" and the E13 zero-reach warning.
   *
   * `WHERE skill_id = ANY($ids) AND wants` is EXACTLY the shape of
   * `worker_skill_reach_idx (skill_id) INCLUDE (worker_id, months_bucketed) WHERE wants`,
   * so this is an index-only scan that never touches the heap. PII-free: one integer.
   */
  async countWorkersReachedBy(skillIds: readonly string[]): Promise<number> {
    if (skillIds.length === 0) return 0;
    const ids = dsql.param([...skillIds]);
    const rows = await this.db.execute<{ n: number }>(dsql`
      SELECT count(DISTINCT ws.worker_id)::int AS n
      FROM worker_skill ws
      WHERE ws.skill_id = ANY(${ids}::text[]) AND ws.wants
    `);
    const list = rows as unknown as { n: number }[];
    return list[0]?.n ?? 0;
  }

  /** Reach-set size for one posting — the E13/E12 and boost supply-gate input. */
  async countReachForPosting(jobPostingId: string): Promise<{ total: number; tier1: number }> {
    const rows = await this.db.execute<{ total: number; tier1: number }>(dsql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE match_tier = 1)::int AS tier1
      FROM job_reach
      WHERE job_posting_id = ${jobPostingId}::uuid
    `);
    const list = rows as unknown as { total: number; tier1: number }[];
    return { total: list[0]?.total ?? 0, tier1: list[0]?.tier1 ?? 0 };
  }

  /**
   * MOMENT ③ — materialize one posting's ENTIRE reach set.
   *
   * The statement is the one proven against a live cluster in
   * `packages/db/src/materialize-job-reach.ts` (the D5 runner), reused shape-for-shape:
   * `MIN(CASE ...)` is best-tier-wins (E6) and `ARRAY_AGG(... ORDER BY direct DESC,
   * months DESC)[1]` names the skill that ACHIEVED the tier, so tier and matched skill
   * can never contradict each other. Stale rows are deleted in the SAME transaction, so
   * the set never over-claims after an edit that narrowed the skills.
   */
  async materializeReachForPosting(
    jobPostingId: string,
    postedSkillIds: readonly string[],
    reachSkillIds: readonly string[],
  ): Promise<void> {
    // THE STATEMENT LIVES IN `@badabhai/db` (`materializeJobReachWithin`) since ADR-0050: the
    // agency-twin sync must run the SAME materialization inside ITS transaction, and one SQL text
    // cannot drift from itself. This method keeps its own transaction, exactly as before.
    await this.db.transaction(async (tx) =>
      materializeJobReachWithin(tx as unknown as Tx, jobPostingId, postedSkillIds, reachSkillIds),
    );
  }

  /** Persist a posting's resolved reach set (match ∪ related ⊖ honoured unticks). */
  async setPostingSkillSets(
    jobPostingId: string,
    matchSkillIds: readonly string[],
    reachSkillIds: readonly string[],
    publishedAt: Date | null,
  ): Promise<void> {
    await this.db
      .update(jobPostings)
      .set({
        matchSkillIds: [...matchSkillIds],
        reachSkillIds: [...reachSkillIds],
        // FIRST OPEN ONLY: a re-publish (unpause) must not restamp `published_at`, or a
        // posting could pause/resume its way back to the top of a newest-first feed.
        ...(publishedAt !== null ? { publishedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(jobPostings.id, jobPostingId));
  }

  /** The stored match/reach id arrays + publish state for one posting. */
  async findPostingSkillSets(jobPostingId: string): Promise<
    | {
        matchSkillIds: string[];
        reachSkillIds: string[];
        publishedAt: Date | null;
        payerId: string | null;
        createdBy: string;
      }
    | undefined
  > {
    const rows = await this.db
      .select({
        matchSkillIds: jobPostings.matchSkillIds,
        reachSkillIds: jobPostings.reachSkillIds,
        publishedAt: jobPostings.publishedAt,
        payerId: jobPostings.payerId,
        createdBy: jobPostings.createdBy,
      })
      .from(jobPostings)
      .where(eq(jobPostings.id, jobPostingId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      matchSkillIds: Array.isArray(row.matchSkillIds) ? row.matchSkillIds.filter(isString) : [],
      reachSkillIds: Array.isArray(row.reachSkillIds) ? row.reachSkillIds.filter(isString) : [],
      publishedAt: row.publishedAt,
      payerId: row.payerId,
      createdBy: row.createdBy,
    };
  }

  /**
   * The worker's reach row for one OPEN posting — the APPLY GATE (moment ⑤). Absent means
   * he was never shown the job OR the posting is no longer open, and the apply 404s with no
   * oracle (the worker cannot tell the two apart, by design).
   *
   * THE STATUS PREDICATE IS THE V1 FEED'S, VERBATIM — `jp.status = 'open'`
   * ({@link ./match-feed.repository.ts MatchFeedRepository.listFeed}). `job_reach` rows
   * survive a pause, a close and the suspension cascade, so the reach row alone let a worker
   * holding an id apply to a posting no feed would show him (#1904). `paused` is excluded
   * here even though the reconcile above keeps it in scope: that keeps the reach set warm for
   * a resume, but a paused posting is on no feed. A resume restores apply with no write.
   * `worker-skills.repository.test.ts` pins this predicate to the feed's.
   *
   * A predicate, not a decision: what an absent row MEANS (the neutral 404, no event) is
   * decided in `MatchApplyService.buildSnapshot`.
   */
  async findReachRow(
    workerId: string,
    jobPostingId: string,
  ): Promise<{ matchTier: 1 | 2; matchedSkillId: string } | undefined> {
    const rows = await this.db.execute<{ match_tier: number; matched_skill_id: string }>(dsql`
      SELECT jr.match_tier, jr.matched_skill_id
      FROM job_reach jr
      JOIN job_postings jp ON jp.id = jr.job_posting_id
      WHERE jr.worker_id = ${workerId}::uuid
        AND jr.job_posting_id = ${jobPostingId}::uuid
        AND jp.status = 'open'
      LIMIT 1
    `);
    const list = rows as unknown as { match_tier: number; matched_skill_id: string }[];
    const row = list[0];
    if (!row) return undefined;
    return {
      matchTier: row.match_tier === 1 ? 1 : 2,
      matchedSkillId: row.matched_skill_id,
    };
  }

  /** Every skill row for a worker — the input to `skillMonthsFor` at apply time. */
  async listSkillRows(
    workerId: string,
  ): Promise<{ skillId: string; industryId: string; monthsBucketed: number; wants: boolean }[]> {
    return this.db
      .select({
        skillId: workerSkills.skillId,
        industryId: workerSkills.industryId,
        monthsBucketed: workerSkills.monthsBucketed,
        wants: workerSkills.wants,
      })
      .from(workerSkills)
      .where(eq(workerSkills.workerId, workerId));
  }

  /** Calendar months this worker has in one industry, 0 when he has no history there. */
  async findIndustryMonths(workerId: string, industryId: string): Promise<number> {
    const rows = await this.db
      .select({ calendarMonths: workerIndustryTenure.calendarMonths })
      .from(workerIndustryTenure)
      .where(
        and(
          eq(workerIndustryTenure.workerId, workerId),
          eq(workerIndustryTenure.industryId, industryId),
        ),
      )
      .limit(1);
    return rows[0]?.calendarMonths ?? 0;
  }

  /** Open postings whose reach set contains any of `skillIds` (ops/verification aid). */
  async listPostingIdsReaching(skillIds: readonly string[]): Promise<string[]> {
    if (skillIds.length === 0) return [];
    const rows = await this.db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(
        and(
          inArray(jobPostings.status, ["open", "paused"]),
          dsql`${jobPostings.reachSkillIds} ?| ${dsql.param([...skillIds])}::text[]`,
        ),
      );
    return rows.map((r) => r.id);
  }
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
