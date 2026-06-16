/**
 * The typed DEFAULT catalog (ADR-0013 §A.5 / §SIGN-OFF) — the known-good seed and
 * the fail-closed fallback. When the DB catalog fails to load/validate, the engine
 * serves THIS (never an unvalidated row). It also seeds the DB catalog on first run.
 *
 * Values mirror the maintainer-ratified spec (2026-06-16):
 *  - job_posting: standard ₹1000 / 14d / 10 applicants; pro ₹2500 / 30d / 30 views
 *  - job_boost:   all_candidates ₹1200 / 2d
 *  - contact_unlock: pack_10 ₹1000/10, pack_25 ₹2000/25, 14-day window
 *    (absorbed EXACTLY from packages/db/src/credit-packs.ts — same codes/values, so
 *    existing credit_ledger.pack_code references stay valid; invariant 8).
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
      kind: "boost",
      code: "job_boost",
      tiers: [{ code: "all_candidates", priceInr: 1200, boostDays: 2 }],
    },
    {
      kind: "credit_pack",
      code: "contact_unlock",
      tiers: [
        { code: "pack_10", priceInr: 1000, credits: 10, windowDays: 14 },
        { code: "pack_25", priceInr: 2000, credits: 25, windowDays: 14 },
      ],
    },
  ],
  offers: [],
  coupons: [],
});
