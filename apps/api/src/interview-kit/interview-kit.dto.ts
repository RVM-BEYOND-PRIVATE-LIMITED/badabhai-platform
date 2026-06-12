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
