import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import type { Database, WorkerSkillSource } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One `worker_skill` row as the Engine view shows it. No identity, no free text. */
export interface EngineSkillRow {
  skillId: string;
  wants: boolean;
  monthsBucketed: number;
  source: WorkerSkillSource;
}

/**
 * The four numbers of the reach funnel for ONE worker, read in ONE statement so they come
 * from one MVCC snapshot and therefore always add up (`hidden` is derived from them). The
 * snapshot covers the COUNTS only: the cards are a separate read, so on a live screen the two
 * can disagree for one 3-second tick.
 */
export interface EngineFunnelCounts {
  openPostings: number;
  reachedDirect: number;
  reachedRelated: number;
  /** Reached OPEN postings he already applied to or skipped — the feed excludes these. */
  alreadyActioned: number;
}

/** The posting-side facts a feed card needs that the feed row does not project. */
export interface EngineCardPostingMeta {
  roleKind: string | null;
  matchSkillIds: string[];
}

export interface EngineRecentWorkerRow {
  workerId: string;
  createdAt: Date;
  /** The skill he wants with the most months — the picker's "trade" hint. */
  topSkillId: string | null;
}

export interface EnginePostingHeader {
  id: string;
  roleTitle: string;
  roleKind: string | null;
  status: string;
  city: string | null;
  matchSkillIds: string[];
  reachSkillIds: string[];
}

/**
 * READ-ONLY queries behind the admin Engine view (`AdminMatchEngineService`).
 *
 * It does NOT read the feed or the candidate list: those are served by the match module's
 * own read paths (`MatchFeedService.composePage`, `MatchCandidatesService.listForPosting`),
 * so the ORDER BY that decides what a worker sees exists in one place. Everything here is
 * the context AROUND those reads — the worker's skill rows, the funnel counts, posting
 * headers — and every statement is an indexed read:
 *
 *   - worker / posting lookups — primary keys;
 *   - skills — `worker_skill_worker_skill_uq (worker_id, skill_id)` prefix;
 *   - funnel — `job_reach_worker_idx (worker_id)` ⋈ `job_postings` pkey, the same join the
 *     feed runs; the open-posting total is an index-only count on `job_postings_feed_idx`
 *     (leading `status`); the actioned probe is `applications_applied_posting_idx` / the
 *     `(worker_id, job_posting_id)` lookups the feed's NOT EXISTS already uses;
 *   - recent workers — a primary-key seek for the demo worker ids (≤ ~1,000), an EXISTS probe
 *     on the `worker_skill` unique index, sorted, LIMIT ≤ 50.
 *
 * DEMO WORKERS ONLY (owner ruling 2026-10-06): every worker-returning read here — and every
 * per-posting reach count — takes the demo worker ids from `AdminEngineDemoGate` and filters on
 * them, so nothing derived from a real worker reaches the screen.
 *
 * PRIVACY: never selects `full_name`, `phone_*`, `whatsapp_enc`, `org_label` or any
 * encrypted column. Ids, closed-vocabulary skill ids, enums, integers, timestamps.
 */
@Injectable()
export class AdminMatchEngineRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The worker, if he exists, is not pending deletion, AND is a DEMO worker (owner ruling
   * 2026-10-06 — `AdminEngineDemoGate`). A worker inside the deletion grace window has asked to
   * leave (ADR-0031 (b)), and a real worker is out of the demo's purpose; both are a neutral 404
   * here, exactly as an unknown id is, so the surface is not an existence oracle for any of them.
   *
   * `demoWorkerIds` comes from `AdminEngineDemoGate` (resolved by phone hash in the workers
   * domain); this file never names a phone column.
   */
  async findLiveDemoWorker(
    workerId: string,
    demoWorkerIds: readonly string[],
  ): Promise<{ id: string } | undefined> {
    const rows = (await this.db.execute(dsql`
      SELECT w.id
      FROM workers w
      WHERE w.id = ${workerId}::uuid
        AND w.deletion_scheduled_at IS NULL
        AND w.id = ANY(${dsql.param([...demoWorkerIds])}::uuid[])
      LIMIT 1
    `)) as unknown as { id: string }[];
    return rows[0];
  }

  async listWorkerSkills(workerId: string): Promise<EngineSkillRow[]> {
    const rows = (await this.db.execute(dsql`
      SELECT ws.skill_id, ws.wants, ws.months_bucketed, ws.source
      FROM worker_skill ws
      WHERE ws.worker_id = ${workerId}::uuid
      ORDER BY ws.wants DESC, ws.months_bucketed DESC, ws.skill_id ASC
    `)) as unknown as {
      skill_id: string;
      wants: boolean;
      months_bucketed: number;
      source: WorkerSkillSource;
    }[];
    return rows.map((r) => ({
      skillId: r.skill_id,
      wants: Boolean(r.wants),
      monthsBucketed: Number(r.months_bucketed),
      source: r.source,
    }));
  }

  /**
   * ONE statement, ONE snapshot. The reached counts use the feed's own predicate
   * (`job_reach ⋈ job_postings WHERE worker_id AND status = 'open'`), so "reached" here
   * means exactly "eligible for his feed before the applied/skipped exclusion".
   */
  async countFunnel(workerId: string): Promise<EngineFunnelCounts> {
    const rows = (await this.db.execute(dsql`
      SELECT
        (SELECT count(*)::int FROM job_postings WHERE status = 'open') AS open_postings,
        count(*) FILTER (WHERE jr.match_tier = 1)::int                 AS reached_direct,
        count(*) FILTER (WHERE jr.match_tier = 2)::int                 AS reached_related,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM applications a
          WHERE a.worker_id = ${workerId}::uuid
            AND a.job_posting_id = jp.id
        ))::int                                                        AS already_actioned
      FROM job_reach jr
      JOIN job_postings jp ON jp.id = jr.job_posting_id AND jp.status = 'open'
      WHERE jr.worker_id = ${workerId}::uuid
    `)) as unknown as {
      open_postings: number;
      reached_direct: number;
      reached_related: number;
      already_actioned: number;
    }[];
    const r = rows[0];
    return {
      openPostings: Number(r?.open_postings ?? 0),
      reachedDirect: Number(r?.reached_direct ?? 0),
      reachedRelated: Number(r?.reached_related ?? 0),
      alreadyActioned: Number(r?.already_actioned ?? 0),
    };
  }

  /** `role_kind` + posted skills for the cards on screen. Primary-key lookups, ≤ 50 ids. */
  async findCardPostingMeta(
    jobPostingIds: readonly string[],
  ): Promise<Map<string, EngineCardPostingMeta>> {
    const out = new Map<string, EngineCardPostingMeta>();
    if (jobPostingIds.length === 0) return out;
    // Arrays go through `dsql.param()` — a bare JS array expands to a RECORD (see
    // `materialize-job-reach.ts`).
    const rows = (await this.db.execute(dsql`
      SELECT jp.id, jp.role_kind, jp.match_skill_ids
      FROM job_postings jp
      WHERE jp.id = ANY(${dsql.param([...jobPostingIds])}::uuid[])
    `)) as unknown as { id: string; role_kind: string | null; match_skill_ids: unknown }[];
    for (const r of rows) {
      out.set(r.id, { roleKind: r.role_kind, matchSkillIds: stringArray(r.match_skill_ids) });
    }
    return out;
  }

  /**
   * One posting's reach, counted over DEMO workers only (owner ruling 2026-10-06): an aggregate
   * over real workers is still output derived from their data. The `job_reach` primary key
   * `(job_posting_id, worker_id)` serves it.
   */
  async countDemoReachForPosting(
    jobPostingId: string,
    demoWorkerIds: readonly string[],
  ): Promise<{ total: number; tier1: number }> {
    const rows = (await this.db.execute(dsql`
      SELECT count(*)::int                                AS total,
             count(*) FILTER (WHERE jr.match_tier = 1)::int AS tier1
      FROM job_reach jr
      WHERE jr.job_posting_id = ${jobPostingId}::uuid
        AND jr.worker_id = ANY(${dsql.param([...demoWorkerIds])}::uuid[])
    `)) as unknown as { total: number; tier1: number }[];
    return { total: Number(rows[0]?.total ?? 0), tier1: Number(rows[0]?.tier1 ?? 0) };
  }

  /** The picker: newest live DEMO workers that have at least one `worker_skill` row. */
  async listRecentDemoWorkers(
    limit: number,
    demoWorkerIds: readonly string[],
  ): Promise<EngineRecentWorkerRow[]> {
    const rows = (await this.db.execute(dsql`
      SELECT w.id, w.created_at,
             (SELECT ws.skill_id FROM worker_skill ws
               WHERE ws.worker_id = w.id
               ORDER BY ws.wants DESC, ws.months_bucketed DESC, ws.skill_id ASC
               LIMIT 1) AS top_skill_id
      FROM workers w
      WHERE w.deletion_scheduled_at IS NULL
        AND w.id = ANY(${dsql.param([...demoWorkerIds])}::uuid[])
        AND EXISTS (SELECT 1 FROM worker_skill ws WHERE ws.worker_id = w.id)
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT ${limit}
    `)) as unknown as { id: string; created_at: Date | string; top_skill_id: string | null }[];
    return rows.map((r) => ({
      workerId: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
      topSkillId: r.top_skill_id,
    }));
  }

  /** One posting's header + STORED skill sets (never re-derived — the D5 contract). */
  async findPostingHeader(jobPostingId: string): Promise<EnginePostingHeader | undefined> {
    const rows = (await this.db.execute(dsql`
      SELECT jp.id, jp.role_title, jp.role_kind, jp.status, jp.city,
             jp.match_skill_ids, jp.reach_skill_ids
      FROM job_postings jp
      WHERE jp.id = ${jobPostingId}::uuid
      LIMIT 1
    `)) as unknown as {
      id: string;
      role_title: string;
      role_kind: string | null;
      status: string;
      city: string | null;
      match_skill_ids: unknown;
      reach_skill_ids: unknown;
    }[];
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      roleTitle: r.role_title,
      roleKind: r.role_kind,
      status: r.status,
      city: r.city,
      matchSkillIds: stringArray(r.match_skill_ids),
      reachSkillIds: stringArray(r.reach_skill_ids),
    };
  }
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
