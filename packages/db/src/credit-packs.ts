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

// ---------------------------------------------------------------------------
// §3A pricing locks (2026-06-19): per-unlock UNIT price ₹40; offered packs are
// 50 / 200 / 1000 credits. Packs are priced at the ₹40/credit anchor EXCEPT the
// 1000-pack, which carries a volume DISCOUNT (see PACK_1000). These are the packs
// the company self-serve portal OFFERS.
// ---------------------------------------------------------------------------

/** The §3A per-unlock UNIT price (₹), the anchor every pack is priced from. */
export const UNLOCK_UNIT_PRICE_INR = 40;

/** ₹2,000 → 50 profile-unlocks (₹40/credit). §3A offered pack. */
export const PACK_50: CreditPack = {
  code: "pack_50",
  priceInr: 2000,
  credits: 50,
} as const;

/** ₹8,000 → 200 profile-unlocks (₹40/credit). §3A offered pack. */
export const PACK_200: CreditPack = {
  code: "pack_200",
  priceInr: 8000,
  credits: 200,
} as const;

/**
 * 1,000 profile-unlocks — the §3A "1,000-pack discount" tier.
 *
 * ⚠️ DISCOUNT FIGURE PENDING (escalation): §3A specifies a discount on this pack but
 * the exact figure is NOT in the repo (the 2026-06-19 Latest Context doc is not
 * checked in). Priced LINEARLY at the ₹40/credit anchor here (₹40,000) — NO invented
 * discount. UPDATE `priceInr` once product/RVM confirm the locked discount (ADR-0013).
 */
export const PACK_1000: CreditPack = {
  code: "pack_1000",
  priceInr: 40000, // TODO(§3A): apply the locked 1000-pack discount once provided.
  credits: 1000,
} as const;

/** ₹1000 → 10 profile-unlocks. RETAINED for `credit_ledger` history (invariant 8); not offered in the portal. */
export const PACK_10: CreditPack = {
  code: "pack_10",
  priceInr: 1000,
  credits: 10,
} as const;

/** ₹2000 → 25 profile-unlocks. RETAINED for `credit_ledger` history (invariant 8); not offered in the portal. */
export const PACK_25: CreditPack = {
  code: "pack_25",
  priceInr: 2000,
  credits: 25,
} as const;

/**
 * All resolvable credit packs, keyed by code (lookup at purchase time). Includes the
 * §3A offered packs (50/200/1000) AND the retained legacy packs (10/25) so historical
 * `credit_ledger.pack_code` references stay valid (invariant 8). The OFFERED set
 * (what the portal sells) is {@link OFFERED_CREDIT_PACKS}.
 */
export const CREDIT_PACKS: Readonly<Record<string, CreditPack>> = {
  [PACK_50.code]: PACK_50,
  [PACK_200.code]: PACK_200,
  [PACK_1000.code]: PACK_1000,
  [PACK_10.code]: PACK_10,
  [PACK_25.code]: PACK_25,
} as const;

/** The §3A packs the company portal OFFERS for purchase (legacy 10/25 excluded). */
export const OFFERED_CREDIT_PACKS: readonly CreditPack[] = [PACK_50, PACK_200, PACK_1000];

/** The access window (days) an unlock grant is valid for (§Sign-off resolutions). */
export const UNLOCK_WINDOW_DAYS = 14;
