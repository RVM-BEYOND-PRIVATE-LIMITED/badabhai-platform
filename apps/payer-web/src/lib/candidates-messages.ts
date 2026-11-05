/**
 * Candidates copy catalogue (#2688) — unlock, reveal and masked-résumé failures.
 *
 * Unlock refusals are intentionally neutral (no cause, no balance oracle); an unknown code or a
 * raw exception is replaced with the generic retryable line.
 */
import {
  messageFor,
  withCommon,
  type ErrorCatalogue,
} from "./api-error-messages";

export const CANDIDATES_FALLBACK = "Couldn't reach BadaBhai. Please retry.";

export const CANDIDATES_MESSAGES: ErrorCatalogue = withCommon(
  {
    unlock_failed: "Couldn't unlock this candidate. Please retry.",
    reveal_failed: "Couldn't reveal the contact details. Please retry.",
    resume_failed: "Couldn't load the résumé. Please retry.",
    insufficient_credits: "You need a credit to unlock this candidate.",
    candidate_not_found: "We couldn't find that candidate. Refresh and try again.",
    unlock_not_found: "That unlock is no longer available. Refresh and try again.",
  },
  {},
  CANDIDATES_FALLBACK,
);

/** Resolve a candidates API failure to safe, human copy. */
export function candidatesErrorMessage(input: unknown): string {
  return messageFor(input, CANDIDATES_MESSAGES);
}
