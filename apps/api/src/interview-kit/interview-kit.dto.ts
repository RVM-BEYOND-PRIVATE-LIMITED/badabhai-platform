import { z } from "zod";

/** Trade slug path param — lowercase letters/digits/underscores only (no path injection). */
export const TradeKeyParamSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "tradeKey must be a lowercase slug ([a-z0-9_])");

/** Optional `source` query — where the download came from (PII-free). */
export const KitSourceSchema = z.enum(["worker_app", "web", "ops", "other"]).default("worker_app");
export type KitSourceDto = z.infer<typeof KitSourceSchema>;

/**
 * One entry of GET /interview-kits (TD54) — deliberately just the stable trade key +
 * display label; the full kit is fetched per trade. PII-FREE by construction (kits
 * are per-trade, never per-worker).
 */
export interface InterviewKitListItem {
  trade_key: string;
  display_name: string;
}

/** Response of GET /interview-kits — the WIRED (serveable) kits only. */
export interface InterviewKitListResponse {
  kits: InterviewKitListItem[];
}

/**
 * Response of GET /interview-kits/:tradeKey — the full static kit. The wire shape IS
 * the content shape (deterministic, reviewed, PII-free copy), re-exported here so the
 * client contract lives with the other DTOs.
 */
export type { InterviewKitContent } from "./interview-kit-content";
