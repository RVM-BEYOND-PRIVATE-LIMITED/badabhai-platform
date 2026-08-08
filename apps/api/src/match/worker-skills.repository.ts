import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  type Database,
  jobPostings,
  workerIndustryTenure,
  workerProfiles,
  workerSkills,
} from "@badabhai/db";
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
      experience && typeof experience.total_years === "number" &&
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
      await tx.delete(workerSkills).where(
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
    const rows = await this.db
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
   * `reach_skill_ids ?| $skills` is the jsonb key-existence operator and is exactly what
   * `job_postings_reach_gin` (jsonb_path_ops) indexes — one GIN probe, not a scan over
   * every open posting.
   *
   * ⚠️ ARRAYS GO THROUGH `dsql.param()`. Drizzle's `sql` template expands a bare JS array
   * into a comma-separated placeholder list (a RECORD), so `${skills}::text[]` fails at
   * runtime with `42846: cannot cast type record to text[]`. Verified in
   * `materialize-job-reach.ts` against a live Postgres; do not "simplify" it back.
   */
  async reconcileReachForWorker(workerId: string, wantedSkillIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
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
    });
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
    await this.db.transaction(async (tx) => {
      if (reachSkillIds.length === 0) {
        // No skills → reaches nobody. Still clear stale rows so a posting that LOST its
        // skills stops serving workers it no longer matches.
        await tx.execute(dsql`DELETE FROM job_reach WHERE job_posting_id = ${jobPostingId}::uuid`);
        return;
      }
      const posted = dsql.param([...postedSkillIds]);
      const reach = dsql.param([...reachSkillIds]);

      await tx.execute(dsql`
        INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
        SELECT ${jobPostingId}::uuid,
               ws.worker_id,
               MIN(CASE WHEN ws.skill_id = ANY(${posted}::text[]) THEN 1 ELSE 2 END),
               (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY(${posted}::text[])) DESC,
                                               ws.months_bucketed DESC))[1]
        FROM worker_skill ws
        WHERE ws.skill_id = ANY(${reach}::text[]) AND ws.wants
        GROUP BY ws.worker_id
        ON CONFLICT (job_posting_id, worker_id) DO UPDATE
          SET match_tier       = EXCLUDED.match_tier,
              matched_skill_id = EXCLUDED.matched_skill_id,
              computed_at      = now()
      `);

      await tx.execute(dsql`
        DELETE FROM job_reach jr
        WHERE jr.job_posting_id = ${jobPostingId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM worker_skill ws
            WHERE ws.worker_id = jr.worker_id
              AND ws.skill_id = ANY(${reach}::text[])
              AND ws.wants
          )
      `);
    });
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
   * The worker's reach row for one posting — the APPLY GATE (moment ⑤). Absent means he
   * was never shown the job, and the apply 404s with no oracle.
   */
  async findReachRow(
    workerId: string,
    jobPostingId: string,
  ): Promise<{ matchTier: 1 | 2; matchedSkillId: string } | undefined> {
    const rows = await this.db.execute<{ match_tier: number; matched_skill_id: string }>(dsql`
      SELECT match_tier, matched_skill_id
      FROM job_reach
      WHERE worker_id = ${workerId}::uuid AND job_posting_id = ${jobPostingId}::uuid
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
  async listSkillRows(workerId: string): Promise<
    { skillId: string; industryId: string; monthsBucketed: number; wants: boolean }[]
  > {
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
