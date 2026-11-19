/**
 * #2746 / #2813 — the words for a campus-drive refusal. The API sends a closed `reason` (and, for
 * `company_not_verified`, the missing steps); this maps those tokens to the company's copy. The
 * server's own message is never rendered, and no contact or roles note is ever echoed.
 */

export const CAMPUS_DRIVE_FALLBACK =
  "We couldn't complete that request right now. Please try again.";

/** The missing verification steps a `company_not_verified` 403 names, in the API's order. */
export function missingStepLabel(step: string): string {
  if (step === "admin_approval") return "Admin verification of your company";
  if (step === "gst_number") return "Your GSTIN on file";
  return step;
}

export interface CampusDriveErrorInput {
  reason: string | null;
  missing?: readonly string[];
  limit?: number;
  open?: number;
}

/** The company-facing sentence for a refused campus-drive request. */
export function campusDriveErrorCopy(input: CampusDriveErrorInput): string {
  switch (input.reason) {
    case "company_not_verified": {
      const steps = (input.missing ?? []).map(missingStepLabel);
      const list = steps.length > 0 ? steps.join(" and ") : "Admin verification and a GSTIN";
      return `Your company cannot request a campus drive yet. Missing: ${list}.`;
    }
    case "company_not_active":
      return "Your company account is not active, so it cannot request a campus drive.";
    case "roles_note_has_identifier":
      return "The roles note contains a phone number, email or other ID. Write numbers in words (for example “15,000 to 18,000”) or remove contact details — put the contact person in the contact fields.";
    case "preferred_dates_in_past":
      return "Pick a start date from today (India) onwards.";
    case "preferred_dates_too_far":
      return "Pick dates within one year from today (India).";
    case "contact_name_required":
      return "Add the name of the person the placement team should call.";
    case "targeting_option_not_offered":
      return "One of the selected branches is no longer offered. Remove it and try again.";
    case "idempotency_key_reused":
      return "This request was already sent with different details. Change nothing and retry the original, or start a new request.";
    case "in_flight":
      return "This request is still being sent. Check the list in a moment instead of sending it again.";
    case "drive_request_limit_reached":
      return `You already have ${input.open ?? input.limit ?? "too many"} open campus-drive requests. Cancel one before asking for another.`;
    case "drive_request_not_cancellable":
      return "This request can no longer be cancelled.";
    case "unavailable":
      return "Campus-drive requests are not available for your company right now.";
    default:
      return CAMPUS_DRIVE_FALLBACK;
  }
}
