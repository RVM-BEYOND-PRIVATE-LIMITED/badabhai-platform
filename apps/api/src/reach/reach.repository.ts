import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Database, workerProfiles, jobs, type JobNeededBy } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { WorkerProfileSignalRow } from "./reach.mappers";

/**
 * The DEMAND-side signal columns the JobSource mapper reads from `jobs` — the
 * faceless projection (ADR-0011 D8, the swap-time PII boundary). It carries ONLY
 * the opaque `jobId` + ranking signals; it DELIBERATELY omits `title`, `area`,
 * `payer_id`, and `status` (free text / billing-linkage / lifecycle are never a
 * ranking input and never leave this boundary into a JobSpec / feed.shown event).
 */
export interface JobSignalRow {
  jobId: string;
  tradeKey: string;
  city: string;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
}

/**
 * Read-only Drizzle access to `worker_profiles` for the reach serving layer
 * (ADR-0011 §1, D8).
 *
 * PROJECTION DISCIPLINE (D8): this repository selects ONLY the signal columns the
 * mapper needs — the opaque `worker_id`, canonical role/trade, the
 * experience/salary/location/availability JSONB, `skills` (canonical closed-set
 * skill ids — a legitimate RANK input since ADR-0033; faceless taxonomy tokens, not
 * PII), and `updated_at`. It NEVER selects `embedding` or `raw_profile` (or any
 * PII/raw-profile column). The Phase-2 read-model must keep the identical projection.
 *
 * SORT-NEVER-BLOCK (D8): there is NO relevance `WHERE`. `listSignalRows()` reads the
 * full pool, full stop — so `count in == count out` is structural, not policed.
 */
@Injectable()
export class ReachRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Exactly the signal columns the mapper reads — never embedding/rawProfile.
   * `skills` joined the projection with ADR-0033 (same single query — no join, no
   * N+1): canonical closed-set skill ids for the deterministic overlap factor. */
  private static readonly SIGNAL_COLUMNS = {
    workerId: workerProfiles.workerId,
    canonicalRoleId: workerProfiles.canonicalRoleId,
    canonicalTradeId: workerProfiles.canonicalTradeId,
    skills: workerProfiles.skills,
    experience: workerProfiles.experience,
    salaryExpectation: workerProfiles.salaryExpectation,
    locationPreference: workerProfiles.locationPreference,
    availability: workerProfiles.availability,
    updatedAt: workerProfiles.updatedAt,
  } as const;

  /**
   * The FULL worker pool, signal columns only, NO relevance filter (View A).
   * Ordering is a stable display order only; it never changes membership.
   */
  async listSignalRows(): Promise<WorkerProfileSignalRow[]> {
    const rows = await this.db
      .select(ReachRepository.SIGNAL_COLUMNS)
      .from(workerProfiles);
    return rows;
  }

  /** One worker's signal row (View B), or `undefined` if it has no profile. */
  async findSignalRowByWorkerId(workerId: string): Promise<WorkerProfileSignalRow | undefined> {
    const rows = await this.db
      .select(ReachRepository.SIGNAL_COLUMNS)
      .from(workerProfiles)
      .where(eq(workerProfiles.workerId, workerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Demand-side projection of `jobs` — ONLY the ranking signals (the faceless
   * boundary). NEVER selects title / area / payer_id (free text / billing linkage).
   *
   * ADR-0033 NOTE (demand-side skills gap, stated honestly): the serving `jobs`
   * entity has NO skill-id column — the canonicalized `skill_ids` live on the
   * *separate* `job_postings` entity (TAX-6, migration 0038) and there is no join
   * path between the two (a known two-entity debt, TD37). So every jobs-table job
   * maps to a JobSpec WITHOUT `skillIds`, and the engine redistributes the skills
   * weight. That redistribution neutralizes the SKILLS FACTOR only — it does NOT
   * make scores match the pre-ADR-0033 ones: the same CEO ledger cut availability
   * .10→.05 and activity .10→0, so EVERY served job re-ranks at deploy (measured:
   * 5000/5000 scores changed, max |Δ| 0.109538, 8.3% pushEligible flips). That is the
   * owner-ruled intent, not a side effect. Bringing demand-side ids to this projection
   * is a separate ADDITIVE migration (or the postings→jobs bridge), deliberately NOT
   * smuggled into this diff.
   */
  private static readonly JOB_SIGNAL_COLUMNS = {
    jobId: jobs.id,
    tradeKey: jobs.tradeKey,
    city: jobs.city,
    payMin: jobs.payMin,
    payMax: jobs.payMax,
    minExperienceYears: jobs.minExperienceYears,
    maxExperienceYears: jobs.maxExperienceYears,
    neededBy: jobs.neededBy,
  } as const;

  /** All OPEN jobs as faceless signal rows (View B candidate set). */
  async listOpenJobSignalRows(): Promise<JobSignalRow[]> {
    return this.db
      .select(ReachRepository.JOB_SIGNAL_COLUMNS)
      .from(jobs)
      .where(eq(jobs.status, "open"));
  }

  /**
   * One job's faceless signal row by id (View A), or `undefined` if absent.
   * Not status-filtered: a payer may view the ranked list for a job they posted
   * even after it is retired (the row stays the same shape).
   */
  async findJobSignalRowById(jobId: string): Promise<JobSignalRow | undefined> {
    const rows = await this.db
      .select(ReachRepository.JOB_SIGNAL_COLUMNS)
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    return rows[0];
  }

  /**
   * PAYER-SCOPED ownership read (ADR-0019 R22 / PR2). Returns the FACELESS signal row
   * ONLY when the job exists AND `jobs.payer_id == payerId` — otherwise `undefined`.
   *
   * NO-ORACLE (F-3): a not-found job and an other-payer's job both resolve to
   * `undefined`, so the caller maps both to the SAME neutral response (a payer cannot
   * tell whether a job UUID exists or merely belongs to someone else).
   *
   * PII BOUNDARY (CLAUDE.md inv #2): `payer_id` is consumed ONLY in the WHERE predicate
   * (the ownership filter); the SELECT is the same faceless `JOB_SIGNAL_COLUMNS`
   * projection — `payer_id` (and title/area) NEVER enter the returned row, a `JobSpec`,
   * a `feed.shown` payload, or a log.
   */
  async findOwnedJobSignalRowById(
    jobId: string,
    payerId: string,
  ): Promise<JobSignalRow | undefined> {
    const rows = await this.db
      .select(ReachRepository.JOB_SIGNAL_COLUMNS)
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, payerId)))
      .limit(1);
    return rows[0];
  }
}
