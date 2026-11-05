import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The EMPTY-FEED data layer — `GET /admin/workers/empty-feed` (B15, #2569): workers
 * whose active feed would serve them nothing, with per-trade and per-city counts.
 *
 * Its own module rather than a block inside `entities.ts`, for the same reason
 * `funnel.ts` is its own: one module per admin API surface, so a controller's contract
 * has exactly one mirror on this side. Everything else here follows `funnel.ts`
 * verbatim — `server-only`, `adminFetch`, and every response parsed rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-empty-feed.dto.ts` ─────────────────────
 * Compared, never assumed — the same rule `ai-cost.ts` states for the dashboard codes:
 * the server owns the contract, this file re-states it in zod, and a field the server
 * adds must appear here the day it ships. Screens arrive with this file (#2580); the
 * typed fetch + the pure copy helpers below are what they read.
 *
 * ── OPEN SETS STAY OPEN ─────────────────────────────────────────────────────────────
 * Trade ids, city labels and profile statuses are `z.string()` / nullable, never enums —
 * the API DTO is explicit that all three are read out of stored rows. An enum here would
 * reject the whole response the first time a new trade ships, blanking the page over a
 * value the UI could simply have displayed.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

const emptyFeedWorkerSchema = z.object({
  worker_id: z.string(),
  trade_id: z.string().nullable(),
  trade_name: z.string().nullable(),
  city: z.string().nullable(),
  profile_status: z.string().nullable(),
  days_since_signup: z.number(),
});
export type AdminEmptyFeedWorker = z.infer<typeof emptyFeedWorkerSchema>;

const emptyFeedTradeCountSchema = z.object({
  trade_id: z.string().nullable(),
  trade_name: z.string().nullable(),
  count: z.number(),
});
export type AdminEmptyFeedTradeCount = z.infer<typeof emptyFeedTradeCountSchema>;

const emptyFeedCityCountSchema = z.object({ city: z.string().nullable(), count: z.number() });
export type AdminEmptyFeedCityCount = z.infer<typeof emptyFeedCityCountSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const emptyFeedPageSchema = z.object({
  workers: z.array(emptyFeedWorkerSchema),
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  total_pages: z.number(),
  feed_mode: z.string(),
  counts: z.object({
    by_trade: z.array(emptyFeedTradeCountSchema),
    by_city: z.array(emptyFeedCityCountSchema),
  }),
});
export type AdminEmptyFeedPage = z.infer<typeof emptyFeedPageSchema>;

/**
 * Workers whose feed is empty. Requires `read_entities`.
 *
 * `page`/`pageSize` page the list (`page_size` ≤ 100); `includeTestAccounts` defaults
 * to false (test traffic excluded). The response echoes the active feed mode — the UI
 * renders the echoed value, never the argument passed here.
 */
export function getEmptyFeed(opts?: {
  page?: number;
  pageSize?: number;
  includeTestAccounts?: boolean;
}) {
  const q = new URLSearchParams();
  if (opts?.page !== undefined) q.set("page", String(opts.page));
  if (opts?.pageSize !== undefined) q.set("page_size", String(opts.pageSize));
  if (opts?.includeTestAccounts !== undefined)
    q.set("include_test_accounts", opts.includeTestAccounts ? "true" : "false");
  const qs = q.toString();
  return adminFetch(`/admin/workers/empty-feed${qs ? `?${qs}` : ""}`, {
    schema: emptyFeedPageSchema,
  });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `funnel.ts`)
// ---------------------------------------------------------------------------

/**
 * Why a worker is on this list, as one sentence. The feed mode is the echoed value —
 * the operator can tell why the list changed after a flag flip without guessing.
 */
export function describeEmptyFeedWorker(
  worker: Pick<AdminEmptyFeedWorker, "trade_name" | "city" | "days_since_signup">,
  feedMode: string,
): string {
  const trade = worker.trade_name ?? "no trade yet";
  const city = worker.city ?? "no city stated";
  const days =
    worker.days_since_signup === 0
      ? "signed up today"
      : worker.days_since_signup === 1
        ? "signed up 1 day ago"
        : `signed up ${worker.days_since_signup} days ago`;
  return `${trade} · ${city} · ${days} (feed: ${feedMode}).`;
}

/**
 * Why a count bucket may carry a null label. Null trade/city is unstated data, not a
 * zero — rendering it as a blank row would read as a rendering bug, and dropping it
 * would undercount the headline.
 */
export function describeEmptyFeedBucket(bucket: { count: number }, label: string | null): string {
  if (label === null) return `Not stated: ${bucket.count} workers.`;
  return `${label}: ${bucket.count} workers.`;
}
