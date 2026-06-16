import type { CatalogView, ProductView } from "./api";

/**
 * PURE catalog → view-state mapping for the ops Pricing screen (ADR-0013). No I/O,
 * no React, no secrets — just the deterministic translation from the validated
 * catalog the API serves to the rows the screen renders, plus the two small
 * helpers the editor + the top-up panel need (pack-code extraction, JSON guard).
 * Unit-tested in `pricing-view.test.ts`.
 *
 * The catalog is PII-FREE by construction: stable codes + integer ₹ amounts +
 * ISO timestamps only. Nothing here can surface a payer name or worker identity —
 * there is none on this path.
 */

/** Human label for each product kind. */
export const PRODUCT_KIND_LABEL: Record<ProductView["kind"], string> = {
  posting: "Job posting plan",
  boost: "Boost",
  credit_pack: "Credit pack",
};

/**
 * One flattened row in the product summary table — one per (product, tier). The
 * kind-specific grant columns are normalized to optional fields so a single table
 * can render every product kind honestly (a blank cell means "not applicable").
 */
export interface ProductTierRow {
  productCode: string;
  kind: ProductView["kind"];
  kindLabel: string;
  tierCode: string;
  priceInr: number;
  /** posting: validity; credit_pack: access window. */
  validityDays: number | null;
  /** posting only. */
  applicantVisibilityQuota: number | null;
  /** boost only. */
  boostDays: number | null;
  /** credit_pack only — the credits the unlock flow consumes. */
  credits: number | null;
}

/** Flatten the catalog's products into one renderable row per tier. */
export function toProductTierRows(catalog: CatalogView): ProductTierRow[] {
  const rows: ProductTierRow[] = [];
  for (const product of catalog.products) {
    const kindLabel = PRODUCT_KIND_LABEL[product.kind];
    if (product.kind === "posting") {
      for (const t of product.tiers) {
        rows.push({
          productCode: product.code,
          kind: product.kind,
          kindLabel,
          tierCode: t.code,
          priceInr: t.priceInr,
          validityDays: t.validityDays,
          applicantVisibilityQuota: t.applicantVisibilityQuota,
          boostDays: null,
          credits: null,
        });
      }
    } else if (product.kind === "boost") {
      for (const t of product.tiers) {
        rows.push({
          productCode: product.code,
          kind: product.kind,
          kindLabel,
          tierCode: t.code,
          priceInr: t.priceInr,
          validityDays: null,
          applicantVisibilityQuota: null,
          boostDays: t.boostDays,
          credits: null,
        });
      }
    } else {
      for (const t of product.tiers) {
        rows.push({
          productCode: product.code,
          kind: product.kind,
          kindLabel,
          tierCode: t.code,
          priceInr: t.priceInr,
          validityDays: t.windowDays,
          applicantVisibilityQuota: null,
          boostDays: null,
          credits: t.credits,
        });
      }
    }
  }
  return rows;
}

/** A selectable credit pack for the mock top-up (derived from the catalog). */
export interface CreditPackOption {
  /** The tier code the top-up POSTs as `pack_code` (e.g. "pack_10"). */
  code: string;
  priceInr: number;
  credits: number;
  windowDays: number;
}

/**
 * Pull the credit-pack options out of a catalog. These are the credit_pack
 * product tiers — their `code` is the `pack_code` the mock top-up consumes. Order
 * is preserved; the list is empty when the catalog defines no credit packs.
 */
export function extractCreditPacks(catalog: CatalogView): CreditPackOption[] {
  const packs: CreditPackOption[] = [];
  for (const product of catalog.products) {
    if (product.kind !== "credit_pack") continue;
    for (const t of product.tiers) {
      packs.push({
        code: t.code,
        priceInr: t.priceInr,
        credits: t.credits,
        windowDays: t.windowDays,
      });
    }
  }
  return packs;
}

/** Result of the client-side JSON guard before a catalog PUT. */
export type ParsedCatalogJson =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * HONEST client-side JSON guard for the catalog editor. We do NOT validate the
 * catalog SHAPE here — the server's `@badabhai/pricing` `catalogSchema` is the
 * single source of truth and returns a verbatim 400 on an invalid catalog. We
 * only reject input that is not parseable JSON (or not a JSON object), so the
 * operator gets an immediate, honest parse error instead of a confusing 400.
 */
export function parseCatalogJson(raw: string): ParsedCatalogJson {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Catalog JSON is empty." };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Catalog must be a JSON object." };
  }
  return { ok: true, value };
}

/** Pretty-print a catalog object for the editor textarea (stable 2-space indent). */
export function formatCatalogJson(catalog: unknown): string {
  return JSON.stringify(catalog, null, 2);
}

/** Split a comma-separated `changed_fields` input into trimmed, non-empty keys. */
export function parseChangedFields(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Stub ops-actor id (no ops auth in alpha — same posture as job-postings). */
export const OPS_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

/** A v4-shaped UUID guard for the `updated_by` ops-actor input. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True if `s` is a syntactically valid UUID. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}
