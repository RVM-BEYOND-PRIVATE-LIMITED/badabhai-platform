/**
 * The credit packs e2e suites BUY to give a fresh payer credits (#2749).
 *
 * A purchase (including the ops `POST /payers/:payerId/credits` route the suites seed through)
 * accepts only a pack the ACTIVE pricing catalogue lists and has on sale. The e2e stack publishes no
 * catalogue row, so it serves `DEFAULT_CATALOG` (packages/pricing/src/defaults.ts), whose packs are
 * `pack_50`, `pack_200` and `pack_1000`. The constant-only `pack_10` / `pack_25` in
 * packages/db/src/credit-packs.ts can no longer be bought: they answer `404` and seed nothing.
 *
 * ⚠️ The #2749 go-live PR that replaces DEFAULT_CATALOG's packs must update both entries here
 * (docs/runbooks/2749-publish-brief-credit-packs.md).
 */
export interface SeedPack {
  /** The pack code to buy. */
  readonly code: string;
  /** The credits it adds to an empty wallet. */
  readonly credits: number;
}

/** The pack a suite buys when it just needs some credits. */
export const SEED_PACK: SeedPack = { code: "pack_50", credits: 50 };

/** A pack of a DIFFERENT size, for a suite that must never mistake one wallet for another. */
export const OTHER_SEED_PACK: SeedPack = { code: "pack_200", credits: 200 };
