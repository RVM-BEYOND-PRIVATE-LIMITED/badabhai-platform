/**
 * Postings copy catalogue (#2688) — the ONE place a posting API failure becomes words.
 *
 * Server actions already speak in neutral sentences; this catalogue additionally understands the
 * API's machine reasons and statuses, and masks any raw payload that reaches a screen.
 */
import {
  messageFor,
  withCommon,
  type ErrorCatalogue,
} from "./api-error-messages";

export const POSTINGS_FALLBACK =
  "We couldn't complete that posting change right now. Please try again.";

/** A dropped connection mid-action — the row says so and keeps the payer's key for a retry. */
export const POSTINGS_UNREACHABLE_MESSAGE = "Could not reach the server. Please retry.";

export const POSTINGS_MESSAGES: ErrorCatalogue = withCommon(
  {
    posting_trade_required:
      "Pick one of the 16 trades before you continue with this posting.",
    price_mismatch: "The price changed. Review the new price and confirm again.",
    in_flight: "This purchase is still processing — check again in a moment.",
    no_active_plan: "Buy a plan before adding more applicant slots.",
    no_changes: "No changes to save.",
    posting_not_found: "That posting could not be found.",
    posting_locked: "This posting can no longer be edited.",
    validation_failed: "Check the highlighted fields and try again.",
    server_unreachable: POSTINGS_UNREACHABLE_MESSAGE,
  },
  {},
  POSTINGS_FALLBACK,
);

/** Resolve a postings API failure to safe, human copy. */
export function postingsErrorMessage(input: unknown): string {
  return messageFor(input, POSTINGS_MESSAGES);
}
