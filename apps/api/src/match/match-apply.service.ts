import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql as dsql } from "drizzle-orm";
import { skillMonthsFor, type WorkerSkillRow } from "@badabhai/match-engine";
import { isMatchSkillId, matchSkillIndustry } from "@badabhai/taxonomy";
import { applications, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { MatchConfigService } from "./match-config.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/** The frozen rank inputs written onto an application at decision time. */
export interface RankSnapshot {
  matchTier: 1 | 2;
  skillMonths: number;
  industryMonths: number;
  /** ISO date, or null. Null at launch — coarse history has no stint dates (E4). */
  lastWorkedAt: string | null;
  engineVersion: string;
}

/** The result of a V1 apply/skip upsert. */
export interface MatchDecisionResult {
  applicationId: string;
  /** True only when this call created a NEW row. */
  inserted: boolean;
  /** True when an existing `skipped` row flipped to `applied` on this call. */
  flippedToApplied: boolean;
  /** The snapshot as it now stands on the row (existing one on a re-apply). */
  snapshot: RankSnapshot | null;
}

/**
 * MOMENT ⑤ — "Worker swipes apply. Snapshot the rank inputs onto the application row
 * and freeze them with `engine_version`."
 *
 * WHY THE SNAPSHOT IS THE POINT (ADR-0036 §5, spec Part 6): "you can replay every
 * historical list under any future rule and check whether it would have ranked the Kept
 * candidates higher. This is the only irreversible decision in the document — history
 * not captured on day one is gone permanently."
 *
 * AND WHY IT IS WRITTEN ONCE (E16): "Worker updates his profile after applying → the
 * company's list does not move." A re-apply (a double tap, a client retry) must NOT
 * recompute the numbers, or a worker editing his profile silently reorders a list a
 * company already paid to see. So the snapshot is written on INSERT and on a
 * skip→apply FLIP — the two moments where a NEW decision is being taken — and never on
 * a repeat of a decision already recorded.
 *
 * THE REACH ROW IS THE GATE. He can only apply to what the gate showed him: no
 * `job_reach` row means the posting never reached him, and the apply 404s with the same
 * neutral body as an unknown posting (no existence oracle).
 */
@Injectable()
export class MatchApplyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly skills: WorkerSkillsRepository,
    private readonly config: MatchConfigService,
  ) {}

  /**
   * Compute the frozen rank inputs for (worker, posting), or throw 404 when the worker
   * has no reach row for it.
   *
   * `skillMonthsFor` decides WHICH skill's months count:
   *  - E5 tier 1, multi-skill posting → the MAX across the posted skills he holds;
   *  - E6 tier 2 → the months on the RELATED skill he actually matched, which for a
   *    worker who holds both is deliberately the smaller number: counting the related
   *    months on a tier-1 match would sell the payer time on another machine.
   * The engine owns that rule; this method only supplies its inputs.
   */
  async buildSnapshot(workerId: string, jobPostingId: string): Promise<RankSnapshot> {
    const reach = await this.skills.findReachRow(workerId, jobPostingId);
    // NO ORACLE: identical to the "posting does not exist" 404. A worker must not be
    // able to enumerate postings by watching which ids answer differently.
    if (!reach) throw new NotFoundException("Job not found");

    const posting = await this.skills.findPostingSkillSets(jobPostingId);
    if (!posting) throw new NotFoundException("Job not found");

    const cfg = await this.config.get();
    const rows = await this.skills.listSkillRows(workerId);
    const workerRows: WorkerSkillRow[] = rows.map((r) => ({
      skillId: r.skillId as WorkerSkillRow["skillId"],
      industryId: r.industryId as WorkerSkillRow["industryId"],
      monthsBucketed: r.monthsBucketed,
      wants: r.wants,
      // Coarse history: no stint dates at launch. The columns exist so a later
      // fine-grained interview writer needs no migration, not so we can invent one.
      startedAt: null,
      endedAt: null,
    }));

    const skillMonths = skillMonthsFor({
      workerRows,
      postedSkillIds: posting.matchSkillIds,
      matchedTier: reach.matchTier,
    });

    // The industry is the MATCHED SKILL's industry, not the posting's `industry_id`
    // column: the matched skill is what he was actually reached through, and V1
    // matching never crosses industries, so they agree whenever both are populated —
    // but only one of them is guaranteed non-null on a legacy-converted posting.
    const industryId = isMatchSkillId(reach.matchedSkillId)
      ? matchSkillIndustry(reach.matchedSkillId)
      : undefined;
    const industryMonths =
      industryId === undefined ? 0 : await this.skills.findIndustryMonths(workerId, industryId);

    return {
      matchTier: reach.matchTier,
      skillMonths,
      // E8, belt-and-braces: tenure is already clamped on write, but a clamp that is
      // only enforced in one place is a clamp that breaks when a second writer appears.
      industryMonths: Math.max(industryMonths, skillMonths),
      // E4 — "duration unknown". Null at launch for every worker: coarse history has no
      // last-worked date. It sorts NULLS LAST in both the SQL and `rankKeyCompare`.
      lastWorkedAt: null,
      engineVersion: cfg.engineVersion,
    };
  }

  /**
   * Upsert the (worker, posting) decision, writing the snapshot ONLY on a genuinely new
   * decision (insert, or a skip→apply flip).
   *
   * ONE STATEMENT, NO READ-THEN-WRITE. The insert's `ON CONFLICT DO UPDATE` decides in
   * SQL whether this is a flip (`applications.action <> 'applied' AND EXCLUDED.action =
   * 'applied'`) and only then overwrites the five snapshot columns; otherwise it keeps
   * the stored ones. Doing that in application code would race two concurrent applies
   * and could rewrite a snapshot between the read and the write — which is exactly the
   * failure E16 forbids.
   *
   * `(xmax = 0)` distinguishes a fresh INSERT from a conflict UPDATE, the same trick
   * `ApplicationsRepository.upsertDecision` has used since ADR-0009.
   */
  async upsertDecision(input: {
    workerId: string;
    jobPostingId: string;
    action: "applied" | "skipped";
    reason: string | null;
    sourceSurface: string;
    rank: number | null;
    snapshot: RankSnapshot | null;
    /** The action already on the row, from the caller's pre-read. Null when none. */
    previousAction: string | null;
  }): Promise<MatchDecisionResult> {
    const s = input.snapshot;
    const rows = await this.db.execute<{
      id: string;
      inserted: boolean;
      flipped: boolean;
      match_tier: number | null;
      skill_months: number | null;
      industry_months: number | null;
      last_worked_at: string | null;
      engine_version: string | null;
    }>(dsql`
      INSERT INTO applications
        (worker_id, job_posting_id, action, reason, source_surface, rank,
         match_tier, skill_months, industry_months, last_worked_at, engine_version)
      VALUES
        (${input.workerId}::uuid, ${input.jobPostingId}::uuid, ${input.action},
         ${input.reason}, ${input.sourceSurface}, ${input.rank},
         ${s?.matchTier ?? null}, ${s?.skillMonths ?? null}, ${s?.industryMonths ?? null},
         ${s?.lastWorkedAt ?? null}::date, ${s?.engineVersion ?? null})
      ON CONFLICT (worker_id, job_posting_id) WHERE job_posting_id IS NOT NULL
      DO UPDATE SET
        action         = EXCLUDED.action,
        reason         = EXCLUDED.reason,
        source_surface = EXCLUDED.source_surface,
        rank           = EXCLUDED.rank,
        updated_at     = now(),
        -- E16: the snapshot is frozen. It is overwritten ONLY on a skip→apply flip —
        -- a new decision — and never on a repeat of one already recorded, so a worker
        -- editing his profile can never move a list the company already paid to see.
        match_tier      = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'
                               THEN EXCLUDED.match_tier ELSE applications.match_tier END,
        skill_months    = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'
                               THEN EXCLUDED.skill_months ELSE applications.skill_months END,
        industry_months = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'
                               THEN EXCLUDED.industry_months ELSE applications.industry_months END,
        last_worked_at  = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'
                               THEN EXCLUDED.last_worked_at ELSE applications.last_worked_at END,
        engine_version  = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'
                               THEN EXCLUDED.engine_version ELSE applications.engine_version END
      RETURNING id,
                (xmax = 0) AS inserted,
                match_tier, skill_months, industry_months, last_worked_at, engine_version
    `);

    const list = rows as unknown as {
      id: string;
      inserted: boolean;
      match_tier: number | null;
      skill_months: number | null;
      industry_months: number | null;
      last_worked_at: string | null;
      engine_version: string | null;
    }[];
    const row = list[0];
    if (!row) throw new Error("Failed to upsert V1 application");

    return {
      applicationId: row.id,
      inserted: Boolean(row.inserted),
      // The PREVIOUS action is not visible in RETURNING (it sees the post-update row),
      // so the flip is reported from the caller's pre-read — the same best-effort signal
      // the legacy path has used since TD38, and used for the same non-critical purpose
      // (a counter / an emit decision). CORRECTNESS OF THE SNAPSHOT does not depend on
      // it: the `CASE` above resolves the flip atomically inside the statement, so a
      // race that misreports this boolean can never rewrite a frozen snapshot.
      flippedToApplied: input.previousAction != null && input.previousAction !== "applied",
      snapshot:
        row.match_tier === null || row.engine_version === null
          ? null
          : {
              matchTier: row.match_tier === 1 ? 1 : 2,
              skillMonths: row.skill_months ?? 0,
              industryMonths: row.industry_months ?? 0,
              lastWorkedAt: row.last_worked_at,
              engineVersion: row.engine_version,
            },
    };
  }

  /** The worker's existing decision on a posting, or undefined. */
  async findDecision(
    workerId: string,
    jobPostingId: string,
  ): Promise<{ id: string; action: string } | undefined> {
    const rows = await this.db
      .select({ id: applications.id, action: applications.action })
      .from(applications)
      .where(
        and(
          eq(applications.workerId, workerId),
          eq(applications.jobPostingId, jobPostingId),
        ),
      )
      .limit(1);
    return rows[0];
  }
}
