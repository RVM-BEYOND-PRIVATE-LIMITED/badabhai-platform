import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { catalogSchema } from "@badabhai/pricing";

/**
 * Update the pricing catalog (the ops config-builder write). The whole catalog is
 * validated by `@badabhai/pricing` `catalogSchema` AT THE BOUNDARY — a row that
 * would yield a negative/garbage/zero price is rejected with a 400 and never
 * stored (fail-closed). The `change` descriptor is the PII-free audit detail for
 * the `pricing.changed` event: field KEYS only, never old/new VALUES.
 *
 * There is no ops auth in alpha — `updated_by` is an opaque ops-actor uuid on the
 * body (same posture as job_postings.created_by).
 */
export const UpdateCatalogSchema = z.object({
  updated_by: uuidSchema,
  catalog: catalogSchema,
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
