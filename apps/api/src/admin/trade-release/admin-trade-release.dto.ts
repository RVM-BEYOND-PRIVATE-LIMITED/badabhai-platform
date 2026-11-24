import { z } from "zod";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";

/**
 * #3002 — the admin contract for the per-trade release switch.
 *
 * `PUT /admin/trade-release` sets ONE trade's flags (`role_kind` + the two booleans). The admin
 * is the session's (`@CurrentAdmin().id`); no body field names one. A set that changes nothing
 * writes nothing and emits nothing.
 */
export const AdminSetTradeReleaseSchema = z
  .object({
    role_kind: z.enum(TRADE_FORM_KINDS_ALL as unknown as [string, ...string[]]),
    posting_enabled: z.boolean(),
    form_enabled: z.boolean(),
  })
  .strict();
export type AdminSetTradeReleaseDto = z.infer<typeof AdminSetTradeReleaseSchema>;

/** One trade's flags as the screen reads them. */
export interface AdminTradeReleaseItem {
  readonly role_kind: string;
  readonly posting_enabled: boolean;
  readonly form_enabled: boolean;
  readonly updated_by: string | null;
  readonly updated_at: string | null;
}

/** `GET /admin/trade-release`: every trade kind, with its flags. */
export interface AdminTradeReleaseListResponse {
  readonly releases: readonly AdminTradeReleaseItem[];
}

/** `PUT /admin/trade-release`: the trade's flags after the call. */
export interface AdminSetTradeReleaseResponse {
  readonly changed: boolean;
  readonly release: AdminTradeReleaseItem;
}
