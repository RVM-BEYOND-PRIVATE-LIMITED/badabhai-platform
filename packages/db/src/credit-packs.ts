/**
 * Contact Unlock credit packs (ADR-0010 §Sign-off resolutions — authoritative).
 *
 * The payer side (employer OR agent) is charged via CONFIG-DRIVEN credit packs;
 * workers are NEVER charged. One credit = one profile-unlock = one candidate's
 * profile + resume + routed contact (per-profile granularity), valid for a 14-day
 * window. Packs are constants (NOT a DB table) so pricing can be tuned without a
 * migration — exactly as the ADR mandates.
 *
 * UNIT: `priceInr` is whole INDIAN RUPEES (₹), an integer — NOT paise. ₹1000 is
 * stored as `1000`, not `100000`. The credit-pack purchase flow is mock-only in
 * alpha (no real money); a real payment gateway is a separate human-gated
 * escalation (ADR-0010 §D5, CLAUDE.md §7).
 *
 * Caps (reveals/day, payers/week, attempts/unlock) are DELIBERATELY NOT here —
 * those are separate, build-time worker-protection config (ADR-0010 §D4) and must
 * not be hard-coded against pricing.
 */

/** A credit pack a payer can buy (mock in alpha). */
export interface CreditPack {
  /** Stable pack code, also stored on `credit_ledger.pack_code`. */
  readonly code: string;
  /** Price in WHOLE Indian Rupees (₹), integer — not paise. */
  readonly priceInr: number;
  /** Profile-unlock credits granted by buying this pack. */
  readonly credits: number;
}

/** ₹1000 → 10 profile-unlocks. */
export const PACK_10: CreditPack = {
  code: "pack_10",
  priceInr: 1000,
  credits: 10,
} as const;

/** ₹2000 → 25 profile-unlocks. */
export const PACK_25: CreditPack = {
  code: "pack_25",
  priceInr: 2000,
  credits: 25,
} as const;

/** All available credit packs, keyed by code (for lookup at purchase time). */
export const CREDIT_PACKS: Readonly<Record<string, CreditPack>> = {
  [PACK_10.code]: PACK_10,
  [PACK_25.code]: PACK_25,
} as const;

/** The access window (days) an unlock grant is valid for (§Sign-off resolutions). */
export const UNLOCK_WINDOW_DAYS = 14;
