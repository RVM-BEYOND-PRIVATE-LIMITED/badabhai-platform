import type { UnlockQuotes } from "./contracts";

/**
 * #2750 — the pure quote layer shared by both web lists.
 *
 * The quote API answers for up to 50 distinct worker ids. It is an ENHANCEMENT only:
 * when it is off (404), unread or failed, the caller keeps today's button and today's
 * 1-credit behaviour. Nothing here reads a worker fact from a quote — the number is the
 * price of opening the card, nothing else.
 */

/** The ids one quote request may carry: distinct, in page order, at most 50. */
export function quoteWorkerIds(workerIds: readonly string[]): string[] {
  return Array.from(new Set(workerIds)).slice(0, 50);
}

/** A worker's quoted price, or null when there is no quote for him. */
export function quotedCredits(
  quotes: UnlockQuotes | null | undefined,
  workerId: string,
): number | null {
  const credits = quotes?.quotes[workerId];
  return typeof credits === "number" ? credits : null;
}

/** #2750 part C — is this open free because RVM's placement team waived it? */
export function quotedWaived(
  quotes: UnlockQuotes | null | undefined,
  workerId: string,
): boolean {
  return quotes?.waived?.[workerId] === true;
}

/** True only when a quote and the balance are both known and the price is beyond it. */
export function unaffordable(
  credits: number | null,
  creditsAvailable: number | null | undefined,
): boolean {
  return credits !== null && creditsAvailable !== null && creditsAvailable !== undefined
    ? credits > creditsAvailable
    : false;
}

/** "1 credit" / "N credits" — the one pluralisation the open copy uses. */
export function creditsLabel(credits: number): string {
  return `${credits} ${credits === 1 ? "credit" : "credits"}`;
}

/**
 * The open button's copy. Without a quote it is EXACTLY today's button; with one, the
 * brief's wording ("Open for 1 credit" / "Open for 2 credits"), and free at 0.
 */
export function openButtonLabel(credits: number | null, waived = false): string {
  if (waived) return "Free: RVM placement team";
  if (credits === null) return "Unlock contact (1 credit)";
  if (credits === 0) return "Open (free)";
  return `Open for ${creditsLabel(credits)}`;
}

/** A failed attempt keeps its retry affordance, at the price the server will charge. */
export function retryOpenButtonLabel(credits: number | null, waived = false): string {
  if (waived) return "Free: RVM placement team — retry";
  if (credits === null) return "Retry unlock (1 credit)";
  if (credits === 0) return "Retry — open (free)";
  return `Retry — open for ${creditsLabel(credits)}`;
}

/** The honest refusal copy: about the payer's own balance, never about the worker. */
export function insufficientCreditsMessage(needed: number, available: number): string {
  return `You need ${creditsLabel(needed)}, you have ${available}.`;
}

/** The offer shown beside an unaffordable open (a link to the credits page). */
export const STARTER_PACK_LABEL = "Starter pack";
