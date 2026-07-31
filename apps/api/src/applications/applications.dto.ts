import { z } from "zod";

/**
 * Zod DTOs for the alpha swipe-to-apply surface (ADR-0009). All boundaries are
 * validated here. NOTE: `worker_id` is NEVER accepted from a client — it always
 * comes from the authenticated session (`@CurrentWorker`), so it is absent from
 * every request schema below.
 */

/**
 * GET /feed query — a bounded page. The feed is LIBERAL for the alpha (every
 * open job, no location/trade filter), so the default is generous (50) — early
 * on, with few seeded jobs, a no-`limit` request returns them ALL. Still bounded
 * (`max 50`) so the page can never be unbounded; a client may request a smaller
 * page. Raise the cap alongside the default if job volume outgrows 50.
 */
export const FeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  // TD66: Server-side feed filtering
  trade_key: z.string().optional(),
  city: z.string().optional(),
  // ── ADR-0036 / spec Part 3 — "Filters belong to the worker" ────────────────
  // ADDITIVE and OPTIONAL, which is the whole point: "Every default is wide or off.
  // A ₹22,000 expectation captured at registration must never silently become a
  // filter that hides ₹20,000 jobs. Defaults that narrow are a volume leak."
  //
  // So there is deliberately NO default here and NO server-side seeding of `pay_min`
  // from the worker's profile. If it is absent from the query string the pay filter
  // does not exist for that request. `shift` is the same.
  shift: z.enum(["day", "night", "rotational"]).optional(),
  pay_min: z.coerce.number().int().nonnegative().optional(),
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
