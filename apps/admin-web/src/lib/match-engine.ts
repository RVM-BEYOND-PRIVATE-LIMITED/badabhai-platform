import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import type {
  EngineCandidate,
  EngineCard,
  EnginePosting,
  EngineRecentWorker,
  EngineSkill,
  EngineWorker,
} from "./match-engine-view";

/**
 * The ENGINE VIEW data layer — the three reads behind "how does Matching V1 decide what this
 * worker sees" (`read_entities`, every route; `AdminMatchEngineController`).
 *
 *   GET /admin/match/engine/workers?recent=N        the picker: recent workers, short refs only
 *   GET /admin/match/engine/workers/:workerId       skills, the reach funnel, the feed in order
 *   GET /admin/match/engine/postings/:postingId     a posting's skills, reach, ranked candidates
 *
 * Built exactly like `journey.ts`: `server-only`, `adminFetch`, every response Zod-parsed so a
 * shape change surfaces as an honest error state instead of `undefined` on a projector. Each
 * schema `satisfies` the client-safe shape in `match-engine-view.ts` that the live components
 * render, so the two cannot drift.
 *
 * ══ NO IDENTITY ON THIS SURFACE, BY DESIGN ═════════════════════════════════════════════════
 * A worker is an 8-hex `short_ref`; a posting is its role title and city. No name, phone or
 * company name is served, and nothing in this module asks for one. If one ever appears in a
 * payload, that is a backend defect to hand back — not a field to add here.
 *
 * ══ OPEN vs CLOSED SETS ════════════════════════════════════════════════════════════════════
 * Skill `source`, posting `status` and the tiers are `z.string()` / `z.number()`, not enums:
 * the API may extend them, and rejecting the whole response over one new member would blank a
 * live demo that could simply have shown the value. Each has a presenter with an unknown branch.
 */

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/** The API's own bounds on `recent` (1..50). */
export const ENGINE_RECENT_MAX = 50;
export const ENGINE_RECENT_DEFAULT = 20;

export const engineRecentWorkerSchema = z.object({
  worker_id: z.string(),
  short_ref: z.string(),
  created_at: z.string(),
  trade_label: z.string().nullable(),
}) satisfies z.ZodType<EngineRecentWorker, z.ZodTypeDef, unknown>;

export const engineRecentWorkersSchema = z.object({
  workers: z.array(engineRecentWorkerSchema),
});
export type EngineRecentWorkers = z.infer<typeof engineRecentWorkersSchema>;

export function listEngineWorkers(recent: number = ENGINE_RECENT_DEFAULT) {
  // Clamped to the API's own 1..50 so a stray caller cannot 400 the picker.
  const n = Math.min(ENGINE_RECENT_MAX, Math.max(1, Math.trunc(recent)));
  return adminFetch(`/admin/match/engine/workers?recent=${n}`, {
    schema: engineRecentWorkersSchema,
  });
}

// ---------------------------------------------------------------------------
// One worker: skills → funnel → feed
// ---------------------------------------------------------------------------

export const engineSkillSchema = z.object({
  skill_id: z.string(),
  label: z.string(),
  wants: z.boolean(),
  months_bucketed: z.number(),
  source: z.string(),
}) satisfies z.ZodType<EngineSkill, z.ZodTypeDef, unknown>;

export const engineFunnelSchema = z.object({
  open_postings: z.number(),
  reached_direct: z.number(),
  reached_related: z.number(),
  hidden: z.number(),
  already_actioned: z.number(),
});

export const engineCardSchema = z.object({
  rank: z.number(),
  job_posting_id: z.string(),
  role_title: z.string(),
  role_kind: z.string().nullable(),
  city: z.string().nullable(),
  match_tier: z.number(),
  matched_skill_id: z.string(),
  matched_skill_label: z.string().nullable(),
  boosted: z.boolean(),
  published_at: z.string().nullable(),
  why: z.string(),
}) satisfies z.ZodType<EngineCard, z.ZodTypeDef, unknown>;

export const engineWorkerSchema = z.object({
  worker_id: z.string(),
  short_ref: z.string(),
  skills: z.array(engineSkillSchema),
  funnel: engineFunnelSchema,
  cards: z.array(engineCardSchema),
  card_cap: z.number(),
  generated_at: z.string(),
}) satisfies z.ZodType<EngineWorker, z.ZodTypeDef, unknown>;

export function getEngineWorker(workerId: string) {
  return adminFetch(`/admin/match/engine/workers/${encodeURIComponent(workerId)}`, {
    schema: engineWorkerSchema,
  });
}

// ---------------------------------------------------------------------------
// One posting: its skills, its reach, its ranked candidates
// ---------------------------------------------------------------------------

const engineSkillRefSchema = z.object({ skill_id: z.string(), label: z.string() });

export const engineCandidateSchema = z.object({
  rank: z.number(),
  worker_id: z.string(),
  short_ref: z.string(),
  application_id: z.string(),
  match_tier: z.number().nullable(),
  effective_tier: z.number().nullable(),
  skill_months: z.number().nullable(),
  industry_months: z.number().nullable(),
  last_worked_at: z.string().nullable(),
  matched_skill_label: z.string().nullable(),
}) satisfies z.ZodType<EngineCandidate, z.ZodTypeDef, unknown>;

export const enginePostingSchema = z.object({
  job_posting_id: z.string(),
  role_title: z.string(),
  role_kind: z.string().nullable(),
  status: z.string(),
  city: z.string().nullable(),
  /** `match_skill_ids` — tier 1. */
  posted_skills: z.array(engineSkillRefSchema),
  /** `reach_skill_ids` minus the posted ones — tier 2. */
  related_skills: z.array(engineSkillRefSchema),
  reach: z.object({ total: z.number(), tier1: z.number(), tier2: z.number() }),
  /** The existing ranked applicant list, in the API's order. */
  candidates: z.array(engineCandidateSchema),
  tier_floor_months: z.number(),
  generated_at: z.string(),
}) satisfies z.ZodType<EnginePosting, z.ZodTypeDef, unknown>;

export function getEnginePosting(postingId: string) {
  return adminFetch(`/admin/match/engine/postings/${encodeURIComponent(postingId)}`, {
    schema: enginePostingSchema,
  });
}
