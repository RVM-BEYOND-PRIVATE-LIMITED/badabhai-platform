/**
 * The typed DEFAULT catalog (ADR-0013 §A.5 / §SIGN-OFF) — the known-good seed and
 * the fail-closed fallback. When the DB catalog fails to load/validate, the engine
 * serves THIS (never an unvalidated row). It also seeds the DB catalog on first run.
 *
 * Values mirror the maintainer-ratified spec (2026-06-16):
 *  - job_posting: standard ₹1000 / 14d / 10 applicants; pro ₹2500 / 30d / 30 views
 *    ⚠️ §3A says posting is "free-through-launch (verification-gated)". The catalog
 *    schema forbids a ₹0 price (priceInrSchema = min(1)), so "free posting" CANNOT be
 *    modelled as a price here — it needs a launch-phase waiver/verification mechanism
 *    (ESCALATED, ADR-0013). These paid tiers are left for post-launch; the portal
 *    treats base posting as free-through-launch at the surface.
 *  - job_boost (ADR-0036 §7): boost_7 ₹499 / 7d · boost_15 ₹999 / 15d ·
 *    boost_30 ₹1799 / 30d. The legacy `all_candidates` ₹1200 / 2d SKU is RETAINED as
 *    RESOLVABLE for `posting_boosts` history (invariant 8) but is no longer OFFERED —
 *    see OFFERED_BOOST_TIERS below.
 *  - contact_unlock (§3A 2026-06-19): offered packs pack_50 ₹2000/50, pack_200 ₹8000/200,
 *    pack_1000 ₹32000/1000 (per-unlock unit ₹40; the 1000-pack carries a REAL 20% volume
 *    discount → ₹32/credit, CEO-FINAL 2026-06-22). Legacy pack_10/pack_25 are retained as
 *    RESOLVABLE in credit-packs.ts for credit_ledger history (invariant 8) but no longer OFFERED.
 *  - hiring_capacity (ADR-0016): cap_5 ₹5000 / 5 active vacancies / 30d;
 *    cap_15 ₹12000 / 15 / 30d. Buying RAISES the payer's concurrent-active-vacancy
 *    allowance (over-cap plans are 'paused'). Ops-editable; the service logic reads
 *    the grant — it never hardcodes these numbers.
 *
 * Resume download is FREE → it has NO catalog entry (ADR-0013 §SIGN-OFF C).
 * No offers or coupons are seeded by default — ops add those via the config builder.
 */
import { catalogSchema, type Catalog } from "./types";

/** The frozen, validated default catalog. Parsed at module load so a bad edit here fails the build/tests. */
export const DEFAULT_CATALOG: Catalog = catalogSchema.parse({
  version: 1,
  floorPriceInr: 0,
  products: [
    {
      kind: "posting",
      code: "job_posting",
      tiers: [
        { code: "standard", priceInr: 1000, validityDays: 14, applicantVisibilityQuota: 10 },
        { code: "pro", priceInr: 2500, validityDays: 30, applicantVisibilityQuota: 30 },
      ],
    },
    {
      // ADR-0036 §7 — boost repriced for the Matching V1 economics. Boost now does
      // something (it lifts a card in the worker feed: `ORDER BY (boosted_until >
      // now()) DESC, published_at DESC`), where it has been ranking-INERT since it
      // shipped (TD42, retired here).
      //
      // OFFERED: boost_7 ₹499 / boost_15 ₹999 / boost_30 ₹1799.
      // RESOLVABLE-BUT-NOT-OFFERED: `all_candidates` (₹1200 / 2d) — the retired SKU.
      // It stays in the catalog because `posting_boosts.tier` rows already reference
      // it, and `resolvePrice` is what renders a historical receipt; dropping it would
      // make every past boost unpriceable (invariant #8). This is exactly the
      // OFFERED-vs-RESOLVABLE split `packages/db/src/credit-packs.ts` uses for
      // pack_10/pack_25 — see `OFFERED_BOOST_TIERS` below for the portal's list.
      kind: "boost",
      code: "job_boost",
      tiers: [
        { code: "boost_7", priceInr: 499, boostDays: 7 },
        { code: "boost_15", priceInr: 999, boostDays: 15 },
        { code: "boost_30", priceInr: 1799, boostDays: 30 },
        { code: "all_candidates", priceInr: 1200, boostDays: 2 },
      ],
    },
    {
      // §3A pricing locks (2026-06-19): per-unlock unit ₹40; offered packs 50/200/1000.
      // 50 & 200 are at the flat ₹40/credit anchor; the 1000-pack carries a REAL 20% volume
      // discount → ₹32,000 (₹32/credit), CEO-FINAL 2026-06-22 — see packages/db/src/credit-packs.ts.
      // Legacy pack_10/pack_25 are RETAINED (resolvable) for credit_ledger history but are
      // no longer OFFERED, so they are not listed in this catalog.
      kind: "credit_pack",
      code: "contact_unlock",
      tiers: [
        { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 },
        { code: "pack_200", priceInr: 8000, credits: 200, windowDays: 14 },
        { code: "pack_1000", priceInr: 32000, credits: 1000, windowDays: 14 },
      ],
    },
    {
      kind: "capacity",
      code: "hiring_capacity",
      tiers: [
        { code: "cap_5", priceInr: 5000, maxActiveVacancies: 5, validityDays: 30 },
        { code: "cap_15", priceInr: 12000, maxActiveVacancies: 15, validityDays: 30 },
      ],
    },
    {
      // quota_topup (B2): refill applicant-visibility views on an EXISTING active plan
      // ("view more → pay more"). Priced at the same per-view anchor as the posting tiers
      // (standard ₹1000/10 = ₹100/view; pro ₹2500/30 ≈ ₹83/view) so a top-up never
      // undercuts buying the plan. Ops-editable; the service reads the grant, never a
      // hardcoded number. Added views ride the plan's existing validity window.
      kind: "quota_topup",
      code: "quota_topup",
      tiers: [
        { code: "topup_10", priceInr: 1000, additionalVisibilityQuota: 10 },
        { code: "topup_30", priceInr: 2500, additionalVisibilityQuota: 30 },
      ],
    },
  ],
  offers: [],
  coupons: [],
});

/**
 * The boost tiers the payer portal OFFERS (ADR-0036 §7). The retired `all_candidates`
 * SKU is deliberately absent: it stays RESOLVABLE in `DEFAULT_CATALOG` above so a
 * historical `posting_boosts` receipt can still be priced (invariant #8), but it must
 * never appear on a buy screen again.
 *
 * Mirrors the `OFFERED_CREDIT_PACKS` precedent in `packages/db/src/credit-packs.ts`.
 */
export const OFFERED_BOOST_TIERS: readonly string[] = ["boost_7", "boost_15", "boost_30"];

/** The retired boost SKU — resolvable for history, never offered. */
export const RETIRED_BOOST_TIERS: readonly string[] = ["all_candidates"];
