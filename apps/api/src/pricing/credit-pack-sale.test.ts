import { describe, it, expect } from "vitest";
import {
  DEFAULT_CATALOG,
  parseCatalog,
  type Catalog,
  type CreditPackTier,
} from "@badabhai/pricing";
import {
  CREDIT_PACK_PRODUCT,
  creditPackSale,
  findCreditPackTier,
  isRejectedCatalogRow,
} from "./credit-pack-sale";
import type { ActiveCatalog } from "./pricing.service";

/** #2749 — the one "can this pack be sold now?" answer the catalogue read and resolvePack share. */

const NOW = new Date("2026-11-16T06:00:00.000Z");

const withPackTiers = (tiers: CreditPackTier[]): Catalog =>
  parseCatalog({
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) => (p.kind === "credit_pack" ? { ...p, tiers } : p)),
  });

const active = (
  catalog: Catalog,
  source: ActiveCatalog["source"] = "db",
  revision = 4,
): ActiveCatalog => ({ catalog, source, revision });

const STARTER: CreditPackTier = {
  code: "pack_starter",
  priceInr: 999,
  credits: 20,
  windowDays: 14,
};

describe("isRejectedCatalogRow", () => {
  it("is true only for a stored row that failed validation (default source, revision ≥ 1)", () => {
    expect(isRejectedCatalogRow({ source: "default", revision: 7 })).toBe(true);
    expect(isRejectedCatalogRow({ source: "default", revision: 1 })).toBe(true);
  });

  it("is false with no row (revision 0 — production today) and for a valid row", () => {
    expect(isRejectedCatalogRow({ source: "default", revision: 0 })).toBe(false);
    expect(isRejectedCatalogRow({ source: "db", revision: 3 })).toBe(false);
  });
});

describe("creditPackSale", () => {
  it("a listed, on-sale tier is sellable, with its quote, credits and GST line", () => {
    const sale = creditPackSale(active(withPackTiers([STARTER])), STARTER, NOW);
    expect(sale).toMatchObject({
      sellable: true,
      pack: {
        tier: STARTER,
        credits: 20,
        quote: { finalInr: 999 },
        priceLine: {
          taxablePaise: 99_900,
          gstPaise: 17_982,
          roundOffPaise: 18,
          totalPaise: 117_900,
        },
      },
    });
  });

  it("with NO row the default packs are sellable (nothing production sells changes)", () => {
    const tier = findCreditPackTier(DEFAULT_CATALOG, "pack_50")!;
    expect(creditPackSale(active(DEFAULT_CATALOG, "default", 0), tier, NOW).sellable).toBe(true);
  });

  it("a REJECTED stored row sells nothing — not even the default packs it falls back to", () => {
    const tier = findCreditPackTier(DEFAULT_CATALOG, "pack_50")!;
    expect(creditPackSale(active(DEFAULT_CATALOG, "default", 7), tier, NOW)).toEqual({
      sellable: false,
      reason: "rejected_row",
    });
  });

  it("an off-sale tier is not sellable", () => {
    const hidden = { ...STARTER, onSaleFrom: "2999-01-01" };
    expect(creditPackSale(active(withPackTiers([hidden])), hidden, NOW)).toEqual({
      sellable: false,
      reason: "off_sale",
    });
    const retired = { ...STARTER, offered: false };
    expect(creditPackSale(active(withPackTiers([retired])), retired, NOW)).toEqual({
      sellable: false,
      reason: "off_sale",
    });
  });

  it("a tier whose GST line cannot be computed is not sellable, with the error CLASS only", () => {
    const huge = { ...STARTER, priceInr: 9_999_999_999 }; // valid to the schema; too large to tax exactly
    expect(creditPackSale(active(withPackTiers([huge])), huge, NOW)).toEqual({
      sellable: false,
      reason: "gst_error",
      errorClass: "RangeError",
    });
  });

  it("a tier the engine cannot price is not sellable (never an invented price)", () => {
    const notInCatalog = { ...STARTER, code: "pack_elsewhere" };
    expect(creditPackSale(active(withPackTiers([STARTER])), notInCatalog, NOW)).toEqual({
      sellable: false,
      reason: "unpriced",
    });
  });
});

describe("findCreditPackTier", () => {
  it("finds a tier of contact_unlock only — never of another credit-pack product", () => {
    const catalog = parseCatalog({
      ...DEFAULT_CATALOG,
      products: [
        ...DEFAULT_CATALOG.products,
        { kind: "credit_pack", code: "bulk_unlock", tiers: [{ ...STARTER, code: "pack_bulk" }] },
      ],
    });
    expect(CREDIT_PACK_PRODUCT).toBe("contact_unlock");
    expect(findCreditPackTier(catalog, "pack_50")).toMatchObject({ code: "pack_50" });
    expect(findCreditPackTier(catalog, "pack_bulk")).toBeUndefined();
    expect(findCreditPackTier(catalog, "pack_10")).toBeUndefined();
  });
});
