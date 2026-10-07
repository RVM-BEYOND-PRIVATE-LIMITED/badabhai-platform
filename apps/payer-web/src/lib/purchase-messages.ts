import { formatInr } from "./format";

/**
 * The payer-facing copy for a purchase that did NOT go through as confirmed (#2085). Client-safe
 * and schema-free on purpose: the purchase panels import it, so it must not pull the boundary's
 * zod schema (`price-confirmation.ts`, Server Actions only) into a client bundle. One module, so
 * every surface says the same thing.
 */

/** The API refused the confirmed price (409 `price_mismatch`): the new price, and a fresh confirm. */
export function priceChangedMessage(currentPriceInr: number | null): string {
  return currentPriceInr === null
    ? "The price changed. Review the new price and confirm again."
    : `The price changed to ${formatInr(currentPriceInr)}. Review and confirm again.`;
}

/**
 * A purchase key is still live from an attempt confirmed at `earlierPriceInr`, and the payer has
 * now confirmed a different price. Nothing is sent (see the panels' key notes): the earlier
 * attempt's outcome is unknown, and its key must neither be reused for a different price nor
 * replaced by a new one.
 */
export function earlierPurchaseMessage(earlierPriceInr: number): string {
  return `An earlier purchase at ${formatInr(earlierPriceInr)} may still be processing — check back in a moment.`;
}

/** The option the payer confirmed is no longer on offer as described — nothing was bought. */
export const OPTION_CHANGED_MESSAGE = "This option changed — review and confirm again.";
