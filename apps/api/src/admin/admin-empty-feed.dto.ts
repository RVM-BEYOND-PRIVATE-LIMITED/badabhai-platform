import { z } from "zod";
import type { ProfileStatus } from "@badabhai/types";

/**
 * #2569 (B15) — the EMPTY-FEED worker list.
 *
 * A worker is on this list when the SAME feed the worker app reads would serve them no job:
 * the active mode is resolved from the SAME flags `GET /feed` reads (`MATCH_V1_ENABLED`, then
 * `FEED_POSTINGS_UNION_ENABLED`, else the legacy `jobs` arm), and each mode's eligibility rule
 * is the one in `ApplicationsRepository` / `MatchFeedRepository` — open inventory only, with
 * the worker's own applications removed. There is no separate notion of "matching" here.
 *
 * FACELESS: worker id, trade id + label, city, profile status and an age in whole days. No
 * name, phone, email or ciphertext. `read_entities` is the read floor for all four roles.
 */

/** Hard upper bound on one page; the same ceiling the other admin entity reads use. */
export const ADMIN_EMPTY_FEED_PAGE_MAX = 100;
export const ADMIN_EMPTY_FEED_PAGE_DEFAULT = 50;

export const AdminEmptyFeedQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_EMPTY_FEED_PAGE_MAX)
      .default(ADMIN_EMPTY_FEED_PAGE_DEFAULT),
    /**
     * Test accounts are EXCLUDED by default (acceptance criterion). The value is a closed
     * string pair, not `z.coerce.boolean()`: that helper treats the string "false" as true.
     */
    include_test_accounts: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict();
export type AdminEmptyFeedQueryDto = z.infer<typeof AdminEmptyFeedQuerySchema>;

/** Which feed implementation the answer reflects. */
export type AdminEmptyFeedMode = "v1" | "union" | "jobs";

/** One worker with no job in the active feed. */
export interface AdminEmptyFeedWorker {
  worker_id: string;
  /** Latest profile's canonical trade id, or null when the worker has no profile yet. */
  trade_id: string | null;
  /** Human label for `trade_id` (taxonomy), or null. */
  trade_name: string | null;
  /** `workers.current_city`, exactly as stored; null means not stated. */
  city: string | null;
  /** Latest profile's status; null means never profiled. */
  profile_status: ProfileStatus | null;
  /** Whole days since the worker row was created; 0 for today. */
  days_since_signup: number;
}

export interface AdminEmptyFeedTradeCount {
  trade_id: string | null;
  trade_name: string | null;
  count: number;
}

export interface AdminEmptyFeedCityCount {
  city: string | null;
  count: number;
}

export interface AdminEmptyFeedPage {
  workers: AdminEmptyFeedWorker[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  /**
   * The exact feed rules used. Exposed so an operator can tell why the list changed after a
   * flag flip, without the portal guessing from environment variables.
   */
  feed_mode: AdminEmptyFeedMode;
  counts: {
    by_trade: AdminEmptyFeedTradeCount[];
    by_city: AdminEmptyFeedCityCount[];
  };
}
