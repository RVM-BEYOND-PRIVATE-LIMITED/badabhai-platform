import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * DTOs for the reach serving layer (ADR-0011). All responses are FACELESS — opaque
 * `workerId`/`jobId`, ranking signals, and the engine's explainable `components[]`
 * only. No name / phone / address / employer name / contact anywhere.
 */

/** Route param: `:jobId` (View A) — must be a UUID (the JobSource contract). */
export const JobIdParamSchema = z.object({ jobId: uuidSchema });
export type JobIdParam = z.infer<typeof JobIdParamSchema>;

/** Route param: `:workerId` (View B) — must be a UUID. */
export const WorkerIdParamSchema = z.object({ workerId: uuidSchema });
export type WorkerIdParam = z.infer<typeof WorkerIdParamSchema>;

/** One explainable signal contribution — mirrors the engine's `ScoreComponent`. */
export interface ScoreComponentDto {
  signal: string;
  raw: number;
  weight: number;
  reason: string;
}

/**
 * View A row — one ranked applicant for a job. View A keeps the core's `hot` /
 * `pushEligible` as-is (it is exactly the worker-set the core was built for).
 */
export interface ApplicantRowDto {
  workerId: string;
  rank: number;
  score: number;
  hot: boolean;
  pushEligible: boolean;
  components: ScoreComponentDto[];
  /**
   * FACELESS banded taxonomy chips (PII-free): coarse experience band, canonical
   * trade/role label, coarse city. `null` when the signal is unknown. Response-only —
   * these never enter a `feed.shown` payload (the event keeps the same PII-free shape).
   * See {@link workerProfileRowToBands}.
   */
  experienceBand: string | null;
  tradeLabel: string | null;
  cityLabel: string | null;
  /**
   * #2736 — non-contact profile facts for the payer-app Applicants card. Every field is
   * a label, a band, a count or an id from a closed vocabulary — nothing that names,
   * contacts or locates a person. Optional ONLY so the pure rank core
   * (`rankAppliers`/`toApplicantRows`) stays fact-free: every served row carries them,
   * grafted by the service after the rank (`withProfileFacts`). Sparseness renders as
   * `null` (or `[]`), never as a dropped row.
   */
  /** Skill labels, taxonomy-resolved, capped — for the card's skill chips. */
  skills?: string[] | null;
  /** Industry-experience band over the worker's max industry months ("1-2 yrs" …). */
  industryExperienceBand?: string | null;
  /** Highest closed education credential ("ITI", "Graduate", …). */
  educationLabel?: string | null;
  /** How many certificates are on record — a count, never names or issuers. */
  certificationCount?: number | null;
  /** Availability in words ("Within a week"), or null when unstated. */
  availabilityLabel?: string | null;
  /** Coarse recency bucket ("today" | "this week" | "this month" | "earlier"). */
  lastActiveBand?: string | null;
  /** Stated rungs with both labels resolved, for the level badge. */
  tradeLevels?: ApplicantTradeLevelBadge[];
}

/** One rung on the candidate's card — closed vocabularies, both labels resolved server-side. */
export interface ApplicantTradeLevelBadge {
  /** The trade skill the rung sits on (an `mskill_*` id). */
  skillId: string;
  /** The trade's display label, when the taxonomy knows it. */
  skillLabel: string | null;
  /** The stored rung key. */
  tradeLevel: string;
  /** The printed rung, or the raw key when the taxonomy does not know it. */
  tradeLevelLabel: string;
  /** True once the separating question was answered (Setter and above only). */
  levelConfirmed: boolean;
}

export interface ApplicantListResponseDto {
  jobId: string;
  applicants: ApplicantRowDto[];
}

/**
 * View B row — one ranked job in a worker's feed. D4: `hot` is NOT surfaced as a
 * per-job tag and `pushEligible` is OMITTED entirely (no cross-job meaning, no alpha
 * push surface). `score` + `components[]` carry all the View-B signal.
 */
export interface FeedJobRowDto {
  jobId: string;
  rank: number;
  score: number;
  components: ScoreComponentDto[];
}

export interface WorkerFeedResponseDto {
  workerId: string;
  feed: FeedJobRowDto[];
}
