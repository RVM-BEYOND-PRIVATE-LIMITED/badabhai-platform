import { z } from "zod";

/**
 * Zod DTOs for the alpha swipe-to-apply surface (ADR-0009). All boundaries are
 * validated here. NOTE: `worker_id` is NEVER accepted from a client — it always
 * comes from the authenticated session (`@CurrentWorker`), so it is absent from
 * every request schema below.
 */

/** GET /feed query — a bounded page (R-A: limit ≤ 50, default 20). */
export const FeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FeedQueryDto = z.infer<typeof FeedQuerySchema>;

/**
 * POST /applications/:jobId/apply body. `rank` is the seed display position the
 * apply was taken from (nullable); `source_surface` mirrors the
 * `application.submitted` event enum.
 */
export const ApplyJobSchema = z.object({
  rank: z.number().int().positive().nullable().default(null),
  source_surface: z.enum(["feed", "search", "share", "other"]).default("feed"),
});
export type ApplyJobDto = z.infer<typeof ApplyJobSchema>;

/**
 * POST /applications/:jobId/skip body. `reason` is the coarse, non-PII skip
 * reason (no free text); mirrors the `application.skipped` event enum.
 */
export const SkipJobSchema = z.object({
  reason: z.enum(["not_interested", "too_far", "low_pay", "wrong_trade", "other"]).default("other"),
});
export type SkipJobDto = z.infer<typeof SkipJobSchema>;
