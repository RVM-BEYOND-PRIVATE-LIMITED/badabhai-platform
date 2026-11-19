/**
 * #2751 item 4 — the `managed_hiring` product kind in the catalogue: the default tiers carry the
 * brief's prices and terms (register B2-31 to B2-33), GST lands on ₹4,720 and ₹9,440, the schema
 * refuses a broken tier, and `resolvePrice` grants the clock terms.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CATALOG,
  catalogSchema,
  gstPriceLine,
  resolvePrice,
  safeParseCatalog,
} from "./index";

function managedHiring() {
  const product = DEFAULT_CATALOG.products.find((p) => p.kind === "managed_hiring");
  if (!product || product.kind !== "managed_hiring") throw new Error("no managed_hiring product");
  return product;
}

describe("the default Managed Hiring product", () => {
  it("has the two tiers at the brief's prices before GST, and an empty holiday list", () => {
    const product = managedHiring();
    expect(product.code).toBe("managed_hiring");
    expect(product.tiers.map((t) => [t.code, t.priceInr])).toEqual([
      ["standard", 4000],
      ["large", 8000],
    ]);
    expect(product.holidays).toEqual([]);
  });

  it("both tiers aim for 5 confirmed workers in 7 working days, extension to day 30", () => {
    for (const tier of managedHiring().tiers) {
      expect(tier).toMatchObject({ targetCount: 5, workingDays: 7, extensionDays: 30 });
    }
  });

  it("charges ₹4,720 and ₹9,440 with GST (B2-31, B2-33)", () => {
    const [standard, large] = managedHiring().tiers;
    expect(gstPriceLine(standard!.priceInr).totalPaise).toBe(472_000);
    expect(gstPriceLine(large!.priceInr).totalPaise).toBe(944_000);
  });

  it("resolvePrice grants the stamped clock terms", () => {
    const result = resolvePrice(DEFAULT_CATALOG, {
      productCode: "managed_hiring",
      tierCode: "large",
    });
    expect(result).toMatchObject({
      ok: true,
      quote: {
        kind: "managed_hiring",
        finalInr: 8000,
        grants: { kind: "managed_hiring", targetCount: 5, workingDays: 7, extensionDays: 30 },
      },
    });
    expect(
      resolvePrice(DEFAULT_CATALOG, { productCode: "managed_hiring", tierCode: "huge" }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the managed_hiring schema", () => {
  const withProduct = (product: unknown) => ({
    ...DEFAULT_CATALOG,
    products: [...DEFAULT_CATALOG.products.filter((p) => p.kind !== "managed_hiring"), product],
  });
  const tier = {
    code: "standard",
    priceInr: 4000,
    targetCount: 5,
    workingDays: 7,
    extensionDays: 30,
  };

  it("accepts a product stored without a holiday list", () => {
    expect(
      catalogSchema.safeParse(
        withProduct({ kind: "managed_hiring", code: "managed_hiring", tiers: [tier] }),
      ).success,
    ).toBe(true);
  });

  it("refuses an extension shorter than the working days", () => {
    const parsed = safeParseCatalog(
      withProduct({
        kind: "managed_hiring",
        code: "managed_hiring",
        tiers: [{ ...tier, extensionDays: 6 }],
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses a holiday that is not a real date, and a zero target", () => {
    expect(
      catalogSchema.safeParse(
        withProduct({
          kind: "managed_hiring",
          code: "managed_hiring",
          tiers: [tier],
          holidays: ["2027-02-30"],
        }),
      ).success,
    ).toBe(false);
    expect(
      catalogSchema.safeParse(
        withProduct({
          kind: "managed_hiring",
          code: "managed_hiring",
          tiers: [{ ...tier, targetCount: 0 }],
        }),
      ).success,
    ).toBe(false);
  });
});
