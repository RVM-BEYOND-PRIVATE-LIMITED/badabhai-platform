/**
 * ADR-0042 D9 / Layer A (g) — the verification tier the résumé sheet prints.
 *
 * ═══ FIVE IN THE SCHEMA, TWO IN THE UI (ASSUMPTIONS A1) ═══
 *
 * `workers.verification_state` reserves Resume Engine Part 10's five-value vocabulary; the
 * rendered sheet shows exactly two states: no badge at all, or `BadaBhai Verified`. This module
 * is the ONE place that turns a stored state into the printed string, so the two-slots contract
 * (`{{trust_badge}}` in the masthead + the footer segment) cannot drift between the render worker
 * and the payer disclosure — both call {@link verificationBadgeFor}.
 *
 * ═══ WHAT PRINTS, AND WHY NOTHING ELSE DOES ═══
 *
 * The states that mean BadaBhai has actually checked something print the badge:
 * `RVM-attested` (an RVM person attested it), `document-verified` and `EPFO-verified` (a document
 * or an EPFO record backs it). The two that are NOT verification print nothing:
 *
 *   - `self-declared` — the worker's own claim. Printing "BadaBhai Verified" for it would be a
 *     false claim by the platform, which is the same fabrication line every printed atom obeys.
 *     The claim itself still exists on the profile; it is simply not a trust badge.
 *   - `employer-rated` — a rating, not a verification, and A1 ships two tiers in the UI.
 *
 * Absence must read NEUTRAL, never as doubt (Part 10.2): the unverified state collapses the slot
 * and never prints "Unverified". An unknown or retired state maps to null for the same reason —
 * fail closed to silence, never to a guess.
 *
 * NOTHING HERE TOUCHES A MODEL OR A DATABASE. A pure function over a stored string.
 */

/** Part 10's five-value vocabulary — mirrors `workers_verification_state_chk` (migration 0115). */
export const VERIFICATION_STATES = [
  "self-declared",
  "RVM-attested",
  "document-verified",
  "EPFO-verified",
  "employer-rated",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** The ONE string the sheet prints when a worker is verified (A1's two-tier UI). */
export const VERIFICATION_BADGE_LABEL = "BadaBhai Verified";

/** The states that are BadaBhai verification rather than a self-claim or a rating. */
const VERIFIED_STATES: ReadonlySet<string> = new Set<VerificationState>([
  "RVM-attested",
  "document-verified",
  "EPFO-verified",
]);

/** True for a stored state from the closed vocabulary. */
export function isVerificationState(value: unknown): value is VerificationState {
  return typeof value === "string" && (VERIFICATION_STATES as readonly string[]).includes(value);
}

/**
 * The masthead/footer badge for a stored state: `BadaBhai Verified` for the states that are
 * verification, `null` for everything else — unverified, self-declared, employer-rated, unknown.
 */
export function verificationBadgeFor(state: string | null | undefined): string | null {
  return typeof state === "string" && VERIFIED_STATES.has(state) ? VERIFICATION_BADGE_LABEL : null;
}
