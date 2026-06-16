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
