import { z } from "zod";
import type { WorkerSkillSource } from "@badabhai/db";

/**
 * The admin ENGINE VIEW contract — how Matching V1 decides what one worker sees, and who
 * one posting reaches. Read-only, `read_entities`, faceless (see the controller header).
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Cards shown — the first page and a half of a real feed; the funnel carries the totals. */
export const ENGINE_CARD_CAP = 50;
export const ENGINE_RECENT_WORKERS_MAX = 50;
export const ENGINE_RECENT_WORKERS_DEFAULT = 20;
/** Opaque short ref length: the first 8 hex chars of the uuid — a handle, not an identity. */
export const ENGINE_SHORT_REF_LENGTH = 8;

// ---------------------------------------------------------------------------
// Params / query
// ---------------------------------------------------------------------------

export const EngineWorkerParamsSchema = z.object({ workerId: z.string().uuid() }).strict();
export type EngineWorkerParamsDto = z.infer<typeof EngineWorkerParamsSchema>;

export const EnginePostingParamsSchema = z.object({ postingId: z.string().uuid() }).strict();
export type EnginePostingParamsDto = z.infer<typeof EnginePostingParamsSchema>;

export const EngineRecentWorkersQuerySchema = z
  .object({
    recent: z.coerce
      .number()
      .int()
      .min(1)
      .max(ENGINE_RECENT_WORKERS_MAX)
      .default(ENGINE_RECENT_WORKERS_DEFAULT),
  })
  .strict();
export type EngineRecentWorkersQueryDto = z.infer<typeof EngineRecentWorkersQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface EngineRecentWorkerDto {
  worker_id: string;
  short_ref: string;
  created_at: string;
  /** Label of the skill he wants with the most months; null when the id has no label. */
  trade_label: string | null;
}

export interface EngineRecentWorkersResponseDto {
  workers: EngineRecentWorkerDto[];
}

export interface EngineSkillDto {
  skill_id: string;
  label: string;
  wants: boolean;
  months_bucketed: number;
  source: WorkerSkillSource;
}

/**
 * `open_postings === reached_direct + reached_related + hidden`, always — the three
 * counts are read in one snapshot and `hidden` is the remainder.
 */
export interface EngineFunnelDto {
  open_postings: number;
  reached_direct: number;
  reached_related: number;
  hidden: number;
  /** Of the reached postings, those he already applied to or skipped (not on the feed). */
  already_actioned: number;
}

export interface EngineCardDto {
  rank: number;
  job_posting_id: string;
  role_title: string;
  role_kind: string | null;
  city: string | null;
  match_tier: 1 | 2;
  matched_skill_id: string;
  matched_skill_label: string | null;
  boosted: boolean;
  published_at: string | null;
  /** `direct: <skill>` | `related: <skill> → <posted skill>`. */
  why: string;
}

export interface EngineWorkerViewDto {
  worker_id: string;
  short_ref: string;
  skills: EngineSkillDto[];
  funnel: EngineFunnelDto;
  /** The worker's V1 feed, in the EXACT order the feed serves it, at most {@link ENGINE_CARD_CAP}. */
  cards: EngineCardDto[];
  card_cap: number;
  generated_at: string;
}

export interface EngineSkillRefDto {
  skill_id: string;
  label: string;
}

export interface EngineCandidateDto {
  rank: number;
  worker_id: string;
  short_ref: string;
  application_id: string;
  match_tier: number | null;
  effective_tier: number | null;
  skill_months: number | null;
  industry_months: number | null;
  last_worked_at: string | null;
  matched_skill_label: string | null;
}

export interface EnginePostingViewDto {
  job_posting_id: string;
  role_title: string;
  role_kind: string | null;
  status: string;
  city: string | null;
  /** Tier 1 — the skills the poster asked for (`match_skill_ids`). */
  posted_skills: EngineSkillRefDto[];
  /** Tier 2 — the STORED reach set minus the posted skills. */
  related_skills: EngineSkillRefDto[];
  /** Workers this posting reaches, counted over DEMO workers only (owner ruling 2026-10-06). */
  reach: { total: number; tier1: number; tier2: number };
  /**
   * The payer's ranked applicant list, in the payer's order, DEMO applicants only, `rank`
   * renumbered 1..n among them (a payer rank's gaps would count the real applicants above).
   */
  candidates: EngineCandidateDto[];
  tier_floor_months: number;
  generated_at: string;
}
