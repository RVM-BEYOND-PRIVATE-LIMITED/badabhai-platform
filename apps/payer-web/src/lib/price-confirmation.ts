import { z } from "zod";

/**
 * PRICE CONFIRMATION (#2085) — the client half of "shown == charged".
 *
 * Every purchase sends back `expected_price_inr`: the exact ₹ the payer saw on the confirm (or
 * on the trigger, where there is no confirm). The server never charges it — it resolves the
 * charge itself (XT5) — but refuses with a 409 `price_mismatch`, BEFORE any write or event,
 * when the price changed since the payer saw it. The payer is then told the new price and must
 * confirm again; nothing retries on its own. Shared by every purchase Server Action so the guard is
 * the same everywhere. SERVER-SIDE ONLY in practice (it carries a zod schema): the copy the panels
 * render lives in the schema-free `purchase-messages.ts`, so zod never rides in for a message.
 */

/** Mirrors the API's `expectedPriceInrSchema` (apps/api/src/pricing/charge-price.ts). */
export const expectedPriceInrSchema = z.number().int().min(0).max(10_000_000);

/**
 * Read the optional confirmed price at a Server Action boundary (invariant #7).
 *
 * ABSENT ⇒ `undefined`: the field is optional on the API, and a call without it behaves
 * exactly as before #2085. PRESENT BUT MALFORMED ⇒ refused: unlike a junk idempotency key,
 * this is never dropped, because dropping it would quietly remove the guard the caller asked for.
 */
export function readExpectedPrice(
  value: unknown,
): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = expectedPriceInrSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** What an action returns when the API refused the confirmed price. Nothing was bought. */
export interface PriceChangedResult {
  ok: false;
  priceChanged: true;
  /** The API's current price, or null when its refusal carried none. */
  currentPriceInr: number | null;
}

/** Copy for a refused confirmed price that was malformed before it was ever sent. */
export const PRICE_UNREADABLE_MESSAGE = "We couldn't read the price you confirmed. Review it and confirm again.";
