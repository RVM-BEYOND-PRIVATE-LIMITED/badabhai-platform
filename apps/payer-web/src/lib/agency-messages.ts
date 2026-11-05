/**
 * Agency copy catalogue (#2688) — invite minting and agency job refusals.
 *
 * A cap-reached mint and a transient failure stay deliberately indistinguishable (no-oracle),
 * and a raw API payload never reaches the screen.
 */
import {
  messageFor,
  withCommon,
  type ErrorCatalogue,
} from "./api-error-messages";

export const AGENCY_FALLBACK =
  "Could not complete that request right now. Please try again shortly.";

export const AGENCY_MESSAGES: ErrorCatalogue = withCommon(
  {
    invite_cap_reached:
      "You've created the most invite links you can right now. Try again a little later.",
    agency_cap_reached:
      "You've created the most invite links you can right now. Try again a little later.",
    invite_not_available:
      "Could not create an invite right now. Please try again shortly.",
    job_not_found: "That agency job could not be found.",
    job_locked: "This agency job can no longer be edited.",
    validation_failed: "Check the highlighted fields and try again.",
  },
  {},
  AGENCY_FALLBACK,
);

/** Resolve an agency API failure to safe, human copy. */
export function agencyErrorMessage(input: unknown): string {
  return messageFor(input, AGENCY_MESSAGES);
}
