/**
 * Credits / capacity purchase copy catalogue (#2688).
 *
 * Prices, in-flight duplicates and verification outcomes each have one calm line; an unknown
 * server response becomes the generic fallback rather than leaked text.
 */
import {
  messageFor,
  withCommon,
  type ErrorCatalogue,
} from "./api-error-messages";

export const CREDITS_FALLBACK =
  "We couldn't complete that purchase right now. Please try again.";

export const CREDITS_MESSAGES: ErrorCatalogue = withCommon(
  {
    price_mismatch: "The price changed. Review the new price and confirm again.",
    in_flight: "This purchase is still processing — check again in a moment.",
    purchase_forbidden: "Buying credits isn't available for this account.",
    payment_unconfirmed:
      "We couldn't confirm that payment yet. If money left your account, it will be credited automatically — contact support if it isn't.",
    verification_failed:
      "We couldn't confirm that payment. Please contact support if you were charged.",
    insufficient_credits: "You don't have enough credits for that yet.",
    pack_not_found: "That pack is no longer available.",
    tier_not_found: "That capacity tier is no longer available.",
  },
  {},
  CREDITS_FALLBACK,
);

/** Resolve a credits/capacity API failure to safe, human copy. */
export function creditsErrorMessage(input: unknown): string {
  return messageFor(input, CREDITS_MESSAGES);
}
