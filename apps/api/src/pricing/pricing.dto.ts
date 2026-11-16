import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { catalogSchema, creditPackTierSchema, type Catalog } from "@badabhai/pricing";
import { MAX_CHARGE_INR } from "./charge-price";

/** Every key a credit-pack tier may carry — the shared schema's own keys, nothing else. */
const CREDIT_PACK_TIER_KEYS: readonly string[] = Object.keys(creditPackTierSchema.shape);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * OPS WRITE ONLY (#2749): refuse an unknown key on a credit-pack tier.
 *
 * The shared `creditPackTierSchema` DROPS unknown keys, and must keep doing so because payer-web
 * parses API replies with it. But on an ops write a dropped key is a typo that changes what is
 * sold: `onsaleFrom`, `on_sale_from` or `Offered` would be dropped, the pack would validate with
 * no on-sale date, and the "hidden" pack would go on sale at once. So the raw body is checked
 * here, before the shared schema strips anything, and the 400 names the key.
 */
function rejectUnknownCreditPackTierKeys(raw: unknown, ctx: z.RefinementCtx): void {
  // Anything that is not the expected shape is left for `catalogSchema` to report.
  if (!isRecord(raw) || !Array.isArray(raw.products)) return;
  raw.products.forEach((product: unknown, p: number) => {
    if (!isRecord(product) || product.kind !== "credit_pack" || !Array.isArray(product.tiers)) {
      return;
    }
    product.tiers.forEach((tier: unknown, t: number) => {
      if (!isRecord(tier)) return;
      for (const key of Object.keys(tier)) {
        if (CREDIT_PACK_TIER_KEYS.includes(key)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["products", p, "tiers", t, key],
          message: `unknown credit-pack tier key "${key}" (allowed: ${CREDIT_PACK_TIER_KEYS.join(", ")})`,
        });
      }
    });
  });
}

/**
 * OPS WRITE ONLY (#2749): a credit pack's `priceInr` may not exceed {@link MAX_CHARGE_INR}, the
 * same cap a purchase's `expected_price_inr` has. Far beyond any real pack, and it keeps every
 * GST line exactly computable.
 */
function capCreditPackPrices(catalog: Catalog, ctx: z.RefinementCtx): void {
  catalog.products.forEach((product, p) => {
    if (product.kind !== "credit_pack") return;
    product.tiers.forEach((tier, t) => {
      if (tier.priceInr <= MAX_CHARGE_INR) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["products", p, "tiers", t, "priceInr"],
        message: `credit pack ${tier.code}: priceInr must be at most ${MAX_CHARGE_INR}`,
      });
    });
  });
}

/**
 * The catalogue an ops write may publish: the shared `catalogSchema`, plus the two ops-only
 * checks above. The unknown-key check reads the RAW body (so it runs first); the price cap reads
 * the parsed catalogue.
 */
export const opsCatalogSchema = z
  .unknown()
  .superRefine(rejectUnknownCreditPackTierKeys)
  .pipe(catalogSchema.superRefine(capCreditPackPrices));

/**
 * Update the pricing catalog (the ops config-builder write). The whole catalog is
 * validated by `@badabhai/pricing` `catalogSchema` AT THE BOUNDARY — a row that
 * would yield a negative/garbage/zero price is rejected with a 400 and never
 * stored (fail-closed). Since #2749 an unknown credit-pack tier key and a credit pack priced over
 * {@link MAX_CHARGE_INR} are 400s too ({@link opsCatalogSchema}). The `change` descriptor is the
 * PII-free audit detail for the `pricing.changed` event: field KEYS only, never old/new VALUES.
 *
 * There is no ops auth in alpha — `updated_by` is an opaque ops-actor uuid on the
 * body (same posture as job_postings.created_by).
 */
export const UpdateCatalogSchema = z.object({
  updated_by: uuidSchema,
  catalog: opsCatalogSchema,
  change: z.object({
    change_type: z.enum(["plan", "discount", "coupon"]),
    entity_code: z.string().min(1).max(64),
    changed_fields: z.array(z.string().min(1).max(64)).default([]),
  }),
});
export type UpdateCatalogDto = z.infer<typeof UpdateCatalogSchema>;

/**
 * Preview a resolved price (config-builder preview + purchase quote). PII-free
 * inputs: product/tier/coupon CODES + optional opaque payer_id (used only to read
 * that payer's coupon-usage count; never stored/echoed as identity).
 */
export const QuoteQuerySchema = z.object({
  product: z.string().min(1).max(64),
  tier: z.string().min(1).max(64),
  coupon: z.string().min(1).max(64).optional(),
  payer_id: uuidSchema.optional(),
});
export type QuoteQueryDto = z.infer<typeof QuoteQuerySchema>;
