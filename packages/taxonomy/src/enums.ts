/**
 * @badabhai/taxonomy/enums — shared type-safe enums for the CNC/VMC taxonomy.
 *
 * This is the SINGLE SOURCE OF TRUTH for:
 * - TradeKey: the 15 Phase-1 alpha trades (mirrors REQUIRED_TRADE_KEYS)
 * - SkipReason: application skip reasons
 * - SourceSurface: where an action originated
 *
 * Both `@badabhai/db` and `apps/api` consume this package to avoid drift.
 * Keep in sync with apps/api/src/resume/trade-content.ts REQUIRED_TRADE_KEYS.
 */

// ---- TradeKey (15 alpha trades) ----
// Mirrors REQUIRED_TRADE_KEYS in apps/api/src/resume/trade-content.ts
// Order is authoritative; append only, never reorder existing.
export const TRADE_KEYS = [
  "cnc_operator",
  "vmc_operator",
  "cnc_vmc_setter",
  "cnc_programmer",
  "vmc_programmer",
  "cad_designer",
  "solidworks_designer",
  "autocad_draftsman",
  "quality_inspector",
  "production_engineer",
  "maintenance_technician",
  "tool_room_technician",
  "machine_operator",
  "assembly_technician",
  "fitter",
] as const;

export type TradeKey = (typeof TRADE_KEYS)[number];

export function isTradeKey(value: unknown): value is TradeKey {
  return typeof value === "string" && TRADE_KEYS.includes(value as TradeKey);
}

export function assertTradeKey(value: unknown, fieldName = "tradeKey"): asserts value is TradeKey {
  if (!isTradeKey(value)) {
    throw new Error(`${fieldName} must be one of: ${TRADE_KEYS.join(", ")}`);
  }
}

// ---- SkipReason ----
export const SKIP_REASONS = [
  "not_interested",
  "too_far",
  "low_pay",
  "wrong_trade",
  "other",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === "string" && SKIP_REASONS.includes(value as SkipReason);
}

// ---- SourceSurface ----
export const SOURCE_SURFACES = ["feed", "search", "share", "other"] as const;

export type SourceSurface = (typeof SOURCE_SURFACES)[number];

export function isSourceSurface(value: unknown): value is SourceSurface {
  return typeof value === "string" && SOURCE_SURFACES.includes(value as SourceSurface);
}

// ---- Zod schemas (for boundary validation) ----
import { z } from "zod";

export const TradeKeySchema = z.enum(TRADE_KEYS);
export const SkipReasonSchema = z.enum(SKIP_REASONS);
export const SourceSurfaceSchema = z.enum(SOURCE_SURFACES);

export type TradeKeyInput = z.input<typeof TradeKeySchema>;
export type SkipReasonInput = z.input<typeof SkipReasonSchema>;
export type SourceSurfaceInput = z.input<typeof SourceSurfaceSchema>;