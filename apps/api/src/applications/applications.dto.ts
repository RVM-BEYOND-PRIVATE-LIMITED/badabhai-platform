import { z } from "zod";
import { decodeFeedCursor, FEED_CURSOR_MAX_LENGTH } from "./feed-cursor";

/**
 * The largest `pay_min` the feed accepts: Postgres `int4` max, the type of `pay_max` on both
 * `jobs` and `job_postings`. A larger floor is a 400 at the boundary instead of a 500 from
 * an out-of-range bind (#1905 review). A technical bound, not a business cap: every real
 * band sits far below it, so it never changes which jobs a valid floor keeps.
 */
export const FEED_PAY_MIN_MAX = 2_147_483_647;

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
  //
  // `trade_key` is deliberately NOT `z.enum(TRADE_KEYS)` here (#1905, owner ruling): an
  // unknown value must be IGNORED, not rejected with a 400. The worker app has sent a chip
  // LABEL (`'CNC'`) where the slug belongs, and a 400 would turn "the trade filter does
  // nothing" into "the Jobs tab is broken". The legacy-arm service resolves it against
  // `TRADE_KEYS` and drops (and logs) anything else. Single-valued: a repeated param is a 400.
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
  pay_min: z.coerce.number().int().nonnegative().max(FEED_PAY_MIN_MAX).optional(),
  // #1961 / ADR-0052 — the next page. ADDITIVE and OPTIONAL: absent (or empty, `?cursor=`)
  // is the first page, byte-identical to the pre-cursor feed. The value is the `next_cursor`
  // of the previous response, passed back untouched. Decoded and Zod-validated HERE, so any
  // value the server did not mint (not base64url, not JSON, wrong version/shape) is a 400 at
  // the boundary and never reaches a query. A repeated param is an array and also a 400.
  cursor: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .max(FEED_CURSOR_MAX_LENGTH)
      .transform((raw, ctx) => {
        const cursor = decodeFeedCursor(raw);
        if (cursor === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cursor is malformed" });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
  ),
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
