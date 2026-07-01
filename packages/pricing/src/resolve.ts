/**
 * resolvePrice — the deterministic, PII-free, fail-closed pricing math
 * (ADR-0013 §A.4). Pure: same (catalog, request) → same quote, no I/O, no LLM,
 * no randomness, no clock unless the caller withholds `now`.
 *
 * Fail-closed guarantees:
 *  - Unknown product/tier → { ok:false, reason:"unavailable" } (never a 0 price).
 *  - Invalid/expired/over-cap/out-of-scope coupon → IGNORED (full price), never an
 *    error and never a discount. A bad coupon can NEVER block a purchase.
 *  - finalInr is clamped to ≥ catalog.floorPriceInr (≥ 0): never negative.
 *  - At most ONE offer + ONE coupon, applied offer-then-coupon (A-R2).
 */
import type { Catalog, Coupon, DiscountScope, Offer, Product } from "./types";

/** Per-product entitlement granted on purchase — discriminated by product kind. */
export type Grants =
  | { kind: "posting"; validityDays: number; applicantVisibilityQuota: number }
  | { kind: "boost"; boostDays: number }
  | { kind: "credit_pack"; credits: number; windowDays: number }
  | { kind: "capacity"; maxActiveVacancies: number; validityDays: number }
  | { kind: "quota_topup"; additionalVisibilityQuota: number };

/** A resolved, ready-to-charge price quote. PII-FREE (codes + integer ₹ only). */
export interface Quote {
  readonly productCode: string;
  readonly tierCode: string;
  readonly kind: Product["kind"];
  readonly basePriceInr: number;
  /** base − final (≥ 0). The total discount actually applied. */
  readonly discountInr: number;
  /** What the payer pays. Clamped ≥ floor; never negative. */
  readonly finalInr: number;
  /** The offer code applied, or null. */
  readonly offerApplied: string | null;
  /** The coupon code applied, or null (a supplied-but-rejected coupon → null). */
  readonly couponApplied: string | null;
  /** The entitlement to grant once payment captures. */
  readonly grants: Grants;
}

/** Current redemption counts for the supplied coupon (caller reads these from the ledger). */
export interface CouponUsage {
  /** Total redemptions of this coupon across all payers. */
  readonly total: number;
  /** Redemptions of this coupon by THIS payer. */
  readonly perPayer: number;
}

/** Input to resolvePrice. `now`/`couponUsage` default to clock-now / zero usage. */
export interface ResolveRequest {
  readonly productCode: string;
  readonly tierCode: string;
  readonly couponCode?: string;
  /** Evaluation time for offer/coupon windows. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Current redemption counts for `couponCode`. Defaults to { total: 0, perPayer: 0 }. */
  readonly couponUsage?: CouponUsage;
}

export type ResolveResult = { ok: true; quote: Quote } | { ok: false; reason: "unavailable" };

const scopeMatches = (scope: DiscountScope, productCode: string, tierCode: string): boolean =>
  scope.productCode === productCode && (scope.tierCode === undefined || scope.tierCode === tierCode);

const inWindow = (from: string, until: string, now: Date): boolean => {
  const t = now.getTime();
  return t >= Date.parse(from) && t <= Date.parse(until);
};

/** Discount amount for a percent/flat rule against a running amount (integer ₹). */
const discountAmount = (kind: "percent" | "flat", value: number, amount: number): number =>
  kind === "percent" ? Math.floor((amount * value) / 100) : value;

function findGrants(product: Product, tierCode: string): { basePriceInr: number; grants: Grants } | null {
  if (product.kind === "posting") {
    const tier = product.tiers.find((t) => t.code === tierCode);
    if (!tier) return null;
    return {
      basePriceInr: tier.priceInr,
      grants: { kind: "posting", validityDays: tier.validityDays, applicantVisibilityQuota: tier.applicantVisibilityQuota },
    };
  }
  if (product.kind === "boost") {
    const tier = product.tiers.find((t) => t.code === tierCode);
    if (!tier) return null;
    return { basePriceInr: tier.priceInr, grants: { kind: "boost", boostDays: tier.boostDays } };
  }
  if (product.kind === "capacity") {
    const tier = product.tiers.find((t) => t.code === tierCode);
    if (!tier) return null;
    return {
      basePriceInr: tier.priceInr,
      grants: { kind: "capacity", maxActiveVacancies: tier.maxActiveVacancies, validityDays: tier.validityDays },
    };
  }
  if (product.kind === "quota_topup") {
    const tier = product.tiers.find((t) => t.code === tierCode);
    if (!tier) return null;
    return {
      basePriceInr: tier.priceInr,
      grants: { kind: "quota_topup", additionalVisibilityQuota: tier.additionalVisibilityQuota },
    };
  }
  const tier = product.tiers.find((t) => t.code === tierCode);
  if (!tier) return null;
  return { basePriceInr: tier.priceInr, grants: { kind: "credit_pack", credits: tier.credits, windowDays: tier.windowDays } };
}

/** Pick the single best (largest-discount) active, in-scope offer. Ties broken by code asc (deterministic). */
function bestOffer(catalog: Catalog, productCode: string, tierCode: string, base: number, now: Date): Offer | null {
  const applicable = catalog.offers
    .filter((o) => scopeMatches(o.scope, productCode, tierCode) && inWindow(o.from, o.until, now))
    .sort((a, b) => a.code.localeCompare(b.code));
  let best: Offer | null = null;
  let bestDiscount = -1;
  for (const o of applicable) {
    const d = Math.min(discountAmount(o.kind, o.value, base), base);
    if (d > bestDiscount) {
      bestDiscount = d;
      best = o;
    }
  }
  return best;
}

/** Validate a supplied coupon fail-closed; returns the coupon iff it is fully valid, else null. */
function validCoupon(
  catalog: Catalog,
  couponCode: string | undefined,
  productCode: string,
  tierCode: string,
  now: Date,
  usage: CouponUsage,
): Coupon | null {
  if (!couponCode) return null;
  const c = catalog.coupons.find((x) => x.code === couponCode);
  if (!c) return null;
  if (!inWindow(c.from, c.until, now)) return null;
  if (!scopeMatches(c.scope, productCode, tierCode)) return null;
  if (usage.total >= c.totalUsageCap) return null;
  if (usage.perPayer >= c.perPayerLimit) return null;
  return c;
}

/**
 * Resolve the final price + grants for a product/tier, applying at most one offer
 * and one coupon, failing closed throughout.
 */
export function resolvePrice(catalog: Catalog, request: ResolveRequest): ResolveResult {
  const now = request.now ?? new Date();
  const usage = request.couponUsage ?? { total: 0, perPayer: 0 };

  const product = catalog.products.find((p) => p.code === request.productCode);
  if (!product) return { ok: false, reason: "unavailable" };
  const found = findGrants(product, request.tierCode);
  if (!found) return { ok: false, reason: "unavailable" };

  const { basePriceInr, grants } = found;
  const floor = catalog.floorPriceInr;

  let running = basePriceInr;
  let offerApplied: string | null = null;
  let couponApplied: string | null = null;

  // [2] best automatic offer (offer-then-coupon order, A-R2).
  const offer = bestOffer(catalog, request.productCode, request.tierCode, basePriceInr, now);
  if (offer) {
    running = Math.max(floor, running - discountAmount(offer.kind, offer.value, running));
    offerApplied = offer.code;
  }

  // [3] coupon, fail-closed (ignored if invalid).
  const coupon = validCoupon(catalog, request.couponCode, request.productCode, request.tierCode, now, usage);
  if (coupon) {
    running = Math.max(floor, running - discountAmount(coupon.kind, coupon.value, running));
    couponApplied = coupon.code;
  }

  const finalInr = Math.max(floor, running);
  return {
    ok: true,
    quote: {
      productCode: request.productCode,
      tierCode: request.tierCode,
      kind: product.kind,
      basePriceInr,
      discountInr: basePriceInr - finalInr,
      finalInr,
      offerApplied,
      couponApplied,
      grants,
    },
  };
}
