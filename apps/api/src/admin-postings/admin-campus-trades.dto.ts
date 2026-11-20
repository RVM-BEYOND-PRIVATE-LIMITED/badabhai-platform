import { z } from "zod";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { ADMIN_POSTING_REASON_CODES, AdminPostingReasonText } from "./admin-postings.dto";

/**
 * #2957 — THE TRADES RVM TRAINS: only a job in one of these may be sent to Campus by an admin
 * (#2956, ADR-0068). The whole list is replaced in one call, with a written reason (the #2566
 * reason: closed code + 15–500 chars, no hard identifiers), and audited.
 *
 * Keys are trade kinds (`role_kind` values). An empty list is allowed: it means no company job
 * can be sent to Campus (Campus-origin jobs are exempt).
 */
export const CAMPUS_TRADES_MAX = TRADE_FORM_KINDS_ALL.length;

export const CampusTradesPutSchema = z
  .object({
    trade_keys: z
      .array(z.enum(TRADE_FORM_KINDS_ALL as unknown as [string, ...string[]]))
      .max(CAMPUS_TRADES_MAX)
      .refine((keys) => new Set(keys).size === keys.length, "trade_keys must not repeat"),
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type CampusTradesPutDto = z.infer<typeof CampusTradesPutSchema>;

/** One trade kind as the screen lists it: every kind, with whether RVM trains it now. */
export interface CampusTradeItem {
  trade_key: string;
  taught_at_campus: boolean;
  added_by_admin_id: string | null;
  added_at: string | null;
  removed_at: string | null;
}

export interface CampusTradesView {
  trades: CampusTradeItem[];
}

export interface CampusTradesPutResult extends CampusTradesView {
  added: string[];
  removed: string[];
}
