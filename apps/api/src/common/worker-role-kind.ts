import { isTradeFormKindName, type TradeFormKindName } from "@badabhai/types";

/**
 * THE ONE OUTBOUND GATE for a posting's `role_kind` on a worker read (owner ruling 2026-10-05,
 * ADR-0024 addendum of that date): `GET /feed` (both card shapes) and `GET /jobs/:jobId`.
 *
 * FAIL CLOSED TO NULL. Only one of the 21 declared kinds (`TRADE_FORM_KINDS_ALL`) or `null` ever
 * leaves the API. The DB CHECK (`job_postings_role_kind_chk` / `jobs_role_kind_chk`) already
 * holds the column to that set, so anything else here means the check and the vocabulary have
 * drifted; the worker app then draws the generic card instead of art keyed on an unknown value.
 *
 * DISPLAY ONLY — the worker app keys a role ILLUSTRATION on it, not a text line. It is never a
 * match, rank, filter or visibility input (ADR-0036 addendum 2026-09-29), and it is not on
 * `feed.shown` / `feed.shown_v2` (no event schema change).
 */
export function toWorkerRoleKind(value: unknown): TradeFormKindName | null {
  return isTradeFormKindName(value) ? value : null;
}
