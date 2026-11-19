/**
 * @badabhai/pricing — the TYPED CATALOG CONTRACT (ADR-0013 Decision A).
 *
 * This file owns the *shape* of the pricing catalog: the Zod schemas that every
 * ops-edited catalog value is validated against before it is ever served. The
 * *values* (prices, tiers, quotas, windows, discounts, offers, coupons) live as
 * ops-editable DB rows; this is the gate that makes those untyped rows safe.
 *
 * INVARIANTS (ADR-0013 §A.3):
 *  - PII-FREE: codes, ids, integer ₹ amounts, percentages, ISO timestamps ONLY.
 *    Never a payer name, a worker identity, or any free text beyond stable codes.
 *  - Money is WHOLE INDIAN RUPEES (₹), integer — never paise, never float. (The GST line in
 *    gst.ts is integer paise, DERIVED from these rupees; it is never stored in the catalog.)
 *  - Deterministic: the catalog is data; resolvePrice() (resolve.ts) is pure math.
 *  - Fail-closed: a row that would yield a zero/negative/garbage price fails Zod
 *    here and is rejected by safeParseCatalog() (catalog.ts) — never served.
 *
 * Resume download is NOT in this catalog — it is FREE (ADR-0013 §SIGN-OFF C); it
 * carries no price. Only the four PAID surfaces are priced: job-posting plans, the
 * booster, and the contact-unlock credit packs (absorbed from credit-packs.ts).
 */
import { z } from "zod";
import { istDayStartMs } from "./on-sale";

/** A stable, machine code (product/tier/offer/coupon id). No spaces, lowercase. */
export const codeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_]*$/, "code must be lowercase alphanumeric/underscore");

/** Whole Indian Rupees (₹), integer, ≥ 1. Never paise, never 0, never negative. */
export const priceInrSchema = z.number().int().min(1);

/** A positive integer count (credits, quota, days). */
const positiveIntSchema = z.number().int().min(1);

/** ISO-8601 timestamp string (validity windows). */
const isoTimestampSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Products & tiers — a discriminated union on `kind` so each product type
// carries exactly the grant fields it needs (no optional-soup).
// ---------------------------------------------------------------------------

/**
 * A paid job-posting plan tier (e.g. standard / pro).
 *
 * ⚠️ PAYER-VISIBLE (D-6): every field here SHIPS to the payer portal via
 * `GET /payer/pricing/catalog` (PayerPricingController), which projects whole PRODUCTS —
 * so a new field added below is exposed by default. That endpoint's test pins the
 * catalog-LEVEL shape (products only, no offers/coupons) and the tier KEYS, but treat any
 * new tier field as payer-visible unless you deliberately strip it in the projection.
 * Keep it PII-free + non-secret (codes, integer ₹, counts/days — ADR-0013 §A.3).
 */
export const postingTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** Days the posting plan stays active after purchase (e.g. 14 / 30). */
  validityDays: positiveIntSchema,
  /** How many applicant profiles this plan may disclose ("view more → pay more"). */
  applicantVisibilityQuota: positiveIntSchema,
});
export type PostingTier = z.infer<typeof postingTierSchema>;

/** A booster tier (e.g. all_candidates / 2 days). */
export const boostTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** Days the boost broadcasts the (faceless) job to all candidates. */
  boostDays: positiveIntSchema,
});
export type BoostTier = z.infer<typeof boostTierSchema>;

/** The longest a credit pack's credits may last, in days: ten years (#2749). */
export const MAX_CREDIT_VALIDITY_DAYS = 3660;

/**
 * A calendar date `YYYY-MM-DD`, read as that day in India (IST). The date must exist:
 * `2027-02-30` and `2027-13-01` fail.
 */
export const istCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((date) => istDayStartMs(date) !== null, "date must be a real calendar date");

/**
 * A credit pack tier (contact-unlock packs, absorbed from credit-packs.ts).
 *
 * CHARGE SOURCE (D-6, #2749): `PaymentGateway.resolvePack` charges `priceInr` and grants
 * `credits` from this tier, and ONLY for a tier that is on sale ({@link isCreditPackOnSale}).
 * There is no constant fallback any more, so editing a value here changes what a payer is
 * CHARGED.
 *
 * PAYER PROJECTION (#2749): `GET /payer/pricing/catalog` no longer ships these tiers whole. It
 * builds each one from a whitelist (`PricingService.getPayerCatalog`), shows only tiers on sale,
 * and never ships `onSaleFrom` or `offered`. A field added here is therefore NOT payer-visible
 * until that whitelist names it. PII-free, non-secret values only.
 *
 * Every field after `windowDays` is OPTIONAL: a stored catalogue written before it must still
 * validate, because a row that fails validation is not served at all (the engine falls back to
 * DEFAULT_CATALOG).
 */
export const creditPackTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** Credits granted by buying this pack. */
  credits: positiveIntSchema,
  /**
   * The OLD 14-day contact-access window a granted unlock is valid for. Kept because older
   * readers require it; it is NOT how long the credits last (that is `validityDays`).
   */
  windowDays: positiveIntSchema,
  /**
   * How long the credits from this pack last, in days (#2749). Absent or null = not set. Null is
   * accepted because the payer catalogue ships `validityDays: null` for an unset pack and the
   * portal parses that response with this same schema.
   */
  validityDays: z.number().int().min(1).max(MAX_CREDIT_VALIDITY_DAYS).nullish(),
  /** The pack is hidden and cannot be ordered before 00:00 IST on this date (#2749). */
  onSaleFrom: istCalendarDateSchema.optional(),
  /** `false` takes the pack off sale; absent means offered (#2749). */
  offered: z.boolean().optional(),
});
export type CreditPackTier = z.infer<typeof creditPackTierSchema>;

/**
 * A per-payer hiring-capacity tier (ADR-0016). Buying it RAISES how many posting
 * plans a payer may hold in status='active' concurrently (the rest are 'paused'
 * until capacity frees up). PII-FREE: a stable code + integer ₹ + counts/days only.
 */
export const capacityTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** The concurrent active-vacancy allowance this tier grants the payer. */
  maxActiveVacancies: positiveIntSchema,
  /** Days the granted allowance stays valid after purchase. */
  validityDays: positiveIntSchema,
});
export type CapacityTier = z.infer<typeof capacityTierSchema>;

/**
 * A quota top-up tier (B2). Buying it ADDS applicant-visibility views to an existing
 * active posting plan (the "view more → pay more" refill), on top of the plan's original
 * stamped `applicantVisibilityQuota`. The added views are consumed within the plan's
 * EXISTING validity window (no separate window). PII-FREE: a stable code + integer ₹ +
 * a positive view count only.
 */
export const quotaTopupTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** How many additional applicant-visibility views this top-up grants the plan. */
  additionalVisibilityQuota: positiveIntSchema,
});
export type QuotaTopupTier = z.infer<typeof quotaTopupTierSchema>;

/**
 * A Managed Hiring tier (#2751 item 4, brief section 2 and 4B.9): a prepaid, per-job sourcing and
 * screening service. NOT a payer-catalogue product: `GET /payer/pricing/catalog` never ships it
 * (agency and contractor accounts must not be served it, and every other company reads it from the
 * Managed Hiring quote, which decides the tier from the job). PII-free: a code, integer ₹, counts.
 *
 * The clock and the target are STAMPED on the order when it is created, so an ops edit here never
 * changes an order already sold.
 */
export const managedHiringTierSchema = z.object({
  code: codeSchema,
  priceInr: priceInrSchema,
  /** Phone-confirmed interested workers the order aims for (brief: at least 5). */
  targetCount: z.number().int().min(1).max(100),
  /** Working days from the first working day after payment to the deadline (brief: 7). */
  workingDays: z.number().int().min(1).max(60),
  /**
   * The free extension's end, in calendar days counted from the first working day (brief: 30).
   * Never before the deadline (checked on the product).
   */
  extensionDays: z.number().int().min(1).max(180),
});
export type ManagedHiringTier = z.infer<typeof managedHiringTierSchema>;

/** At most this many holidays in the Managed Hiring holiday list. */
export const MAX_MANAGED_HIRING_HOLIDAYS = 120;

/** The six priced product kinds. */
export const productKindSchema = z.enum([
  "posting",
  "boost",
  "credit_pack",
  "capacity",
  "quota_topup",
  "managed_hiring",
]);
export type ProductKind = z.infer<typeof productKindSchema>;

/**
 * A product is a code + a kind + its tiers. Discriminated on `kind` so the tier
 * shape is exact. Tier codes within a product must be unique (enforced in the
 * catalog superRefine).
 */
export const productSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("posting"),
    code: codeSchema,
    tiers: z.array(postingTierSchema).min(1),
  }),
  z.object({
    kind: z.literal("boost"),
    code: codeSchema,
    tiers: z.array(boostTierSchema).min(1),
  }),
  z.object({
    kind: z.literal("credit_pack"),
    code: codeSchema,
    tiers: z.array(creditPackTierSchema).min(1),
  }),
  z.object({
    kind: z.literal("capacity"),
    code: codeSchema,
    tiers: z.array(capacityTierSchema).min(1),
  }),
  z.object({
    kind: z.literal("quota_topup"),
    code: codeSchema,
    tiers: z.array(quotaTopupTierSchema).min(1),
  }),
  z.object({
    kind: z.literal("managed_hiring"),
    code: codeSchema,
    tiers: z.array(managedHiringTierSchema).min(1),
    /**
     * Days that are not working days on top of Sunday, as IST calendar dates (#2751 item 7). The
     * owner's ruling (2026-11-18, #2931): no holidays, so the list is empty. Absent = empty, so a
     * catalogue stored before this field still validates.
     */
    holidays: z.array(istCalendarDateSchema).max(MAX_MANAGED_HIRING_HOLIDAYS).optional(),
  }),
]);
export type Product = z.infer<typeof productSchema>;

// ---------------------------------------------------------------------------
// Discounts: offers (automatic, time-boxed) + coupons (code-redeemed, capped).
// ---------------------------------------------------------------------------

/** Percentage (1–100) or a flat ₹ amount (≥ 1). */
export const discountKindSchema = z.enum(["percent", "flat"]);
export type DiscountKind = z.infer<typeof discountKindSchema>;

/** Which (product, tier?) a discount applies to. Omit `tierCode` to scope a whole product. */
export const discountScopeSchema = z.object({
  productCode: codeSchema,
  tierCode: codeSchema.optional(),
});
export type DiscountScope = z.infer<typeof discountScopeSchema>;

const discountValueRefinement = <T extends { kind: DiscountKind; value: number }>(d: T, ctx: z.RefinementCtx) => {
  if (d.kind === "percent" && (d.value < 1 || d.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percent discount must be 1–100", path: ["value"] });
  }
  if (d.kind === "flat" && d.value < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "flat discount must be ≥ 1", path: ["value"] });
  }
};

/** An automatic, time-boxed offer (no code; applies to anyone in-window + in-scope). */
export const offerSchema = z
  .object({
    code: codeSchema,
    scope: discountScopeSchema,
    kind: discountKindSchema,
    /** percent: 1–100; flat: whole ₹ ≥ 1. */
    value: z.number().int().min(1),
    /** Inclusive validity window (ISO-8601). */
    from: isoTimestampSchema,
    until: isoTimestampSchema,
  })
  .superRefine((o, ctx) => {
    discountValueRefinement(o, ctx);
    if (Date.parse(o.from) >= Date.parse(o.until)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "offer.from must be before offer.until", path: ["until"] });
    }
  });
export type Offer = z.infer<typeof offerSchema>;

/** A code-redeemed coupon with validity window + usage caps (abuse posture, A-R2/OQ-4). */
export const couponSchema = z
  .object({
    code: codeSchema,
    scope: discountScopeSchema,
    kind: discountKindSchema,
    value: z.number().int().min(1),
    from: isoTimestampSchema,
    until: isoTimestampSchema,
    /** Total redemptions allowed across all payers. */
    totalUsageCap: z.number().int().min(1),
    /** Redemptions allowed per single payer. */
    perPayerLimit: z.number().int().min(1),
  })
  .superRefine((c, ctx) => {
    discountValueRefinement(c, ctx);
    if (Date.parse(c.from) >= Date.parse(c.until)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "coupon.from must be before coupon.until", path: ["until"] });
    }
    if (c.perPayerLimit > c.totalUsageCap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "perPayerLimit cannot exceed totalUsageCap",
        path: ["perPayerLimit"],
      });
    }
  });
export type Coupon = z.infer<typeof couponSchema>;

// ---------------------------------------------------------------------------
// The catalog — the single source of truth, validated as a whole.
// ---------------------------------------------------------------------------

/**
 * The full pricing catalog. `floorPriceInr` is the hard floor a discounted price
 * can never drop below (default 0 = a 100%-off coupon may reach free, but a price
 * can NEVER go negative). Codes are unique across each collection.
 */
export const catalogSchema = z
  .object({
    /** Schema/version tag for the catalog payload (bump on a breaking shape change). */
    version: z.literal(1),
    /** Hard floor (₹) for any resolved price — never negative. Default 0. */
    floorPriceInr: z.number().int().min(0).default(0),
    products: z.array(productSchema).min(1),
    offers: z.array(offerSchema).default([]),
    coupons: z.array(couponSchema).default([]),
  })
  .superRefine((cat, ctx) => {
    // Product codes unique.
    const seenProducts = new Set<string>();
    for (const p of cat.products) {
      if (seenProducts.has(p.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate product code: ${p.code}`, path: ["products"] });
      }
      seenProducts.add(p.code);
      // Managed Hiring: the free extension never ends before the deadline could.
      if (p.kind === "managed_hiring") {
        for (const t of p.tiers) {
          if (t.extensionDays < t.workingDays) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `managed hiring tier ${t.code}: extensionDays must be at least workingDays`,
              path: ["products"],
            });
          }
        }
      }
      // Tier codes unique within the product.
      const seenTiers = new Set<string>();
      for (const t of p.tiers) {
        if (seenTiers.has(t.code)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate tier code ${t.code} in product ${p.code}`,
            path: ["products"],
          });
        }
        seenTiers.add(t.code);
      }
    }
    // Offer/coupon codes unique within their collection; scopes must resolve.
    const resolveScope = (scope: DiscountScope): boolean => {
      const product = cat.products.find((p) => p.code === scope.productCode);
      if (!product) return false;
      if (scope.tierCode === undefined) return true;
      return product.tiers.some((t) => t.code === scope.tierCode);
    };
    const seenOffers = new Set<string>();
    for (const o of cat.offers) {
      if (seenOffers.has(o.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate offer code: ${o.code}`, path: ["offers"] });
      }
      seenOffers.add(o.code);
      if (!resolveScope(o.scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `offer ${o.code} scope does not resolve to a product/tier`,
          path: ["offers"],
        });
      }
    }
    const seenCoupons = new Set<string>();
    for (const c of cat.coupons) {
      if (seenCoupons.has(c.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate coupon code: ${c.code}`, path: ["coupons"] });
      }
      seenCoupons.add(c.code);
      if (!resolveScope(c.scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `coupon ${c.code} scope does not resolve to a product/tier`,
          path: ["coupons"],
        });
      }
    }
  });

/** The parsed, validated catalog (defaults applied). */
export type Catalog = z.infer<typeof catalogSchema>;
