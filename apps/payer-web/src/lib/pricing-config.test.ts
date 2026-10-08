import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG, type Product } from "@badabhai/pricing";
import {
  applicantQuotaStep,
  baseApplicantQuotaForBand,
  chargedPrice,
  hiringCapacityTiers,
  offeredCreditPacks,
  postingPaidTiers,
  quotaTopUpTier,
  unlockUnitPriceInr,
  type TierPrice,
} from "./pricing-config";

/**
 * Pricing-config tests — every figure must come from the catalog PRODUCTS the caller
 * passes in (since D-6 that is the LIVE catalog, with DEFAULT_CATALOG only as the
 * fetch-failure fallback), never a literal. quotaTopUpTier() feeds the LIVE
 * quota-topup body (the tier CODE, XT5) and the top-up success copy (addedViews) —
 * pin its selection rule against the default products AND against a LIVE (edited)
 * products array, proving there is no hidden compile-time read left.
 */
describe("quotaTopUpTier — the catalog quota_topup tier one top-up purchases", () => {
  it("returns the SMALLEST catalog tier (code + price + views), straight from config", () => {
    const tier = quotaTopUpTier({ products: DEFAULT_CATALOG.products });
    expect(tier).not.toBeNull();
    // The default catalog's smallest quota_topup tier (topup_10 < topup_30 by views).
    expect(tier!.code).toBe("topup_10");
    expect(tier!.additionalViews).toBe(10);
    expect(tier!.priceInr).toBeGreaterThan(0);
  });

  it("agrees with the posting-tier quota step (the same 'one step' the UI copy shows)", () => {
    // Both derive from config; the smallest top-up grant matches the smallest quota step.
    expect(quotaTopUpTier({ products: DEFAULT_CATALOG.products })!.additionalViews).toBe(
      applicantQuotaStep(DEFAULT_CATALOG.products),
    );
  });

  it("D-6: reads the PASSED products (a live ops edit changes the result — no hidden DEFAULT_CATALOG)", () => {
    // A "live" catalog where ops renamed + re-priced the smallest top-up tier.
    const liveProducts: Product[] = [
      {
        kind: "quota_topup",
        code: "quota_topup",
        tiers: [{ code: "topup_5_live", priceInr: 149, additionalVisibilityQuota: 5 }],
      },
    ];
    const tier = quotaTopUpTier({ products: liveProducts });
    expect(tier).toEqual({ code: "topup_5_live", priceInr: 149, additionalViews: 5 });
    // And the fallback products still resolve the default — the two are independent inputs.
    expect(quotaTopUpTier({ products: DEFAULT_CATALOG.products })!.code).toBe("topup_10");
  });
});

describe("baseApplicantQuotaForBand — scales the (server-resolved) config step, client-safe", () => {
  it("scales the passed step by the band index (smallest band → 1×)", () => {
    expect(baseApplicantQuotaForBand("1-5", 10)).toBe(10);
    expect(baseApplicantQuotaForBand("6-20", 10)).toBe(20);
    expect(baseApplicantQuotaForBand("50+", 10)).toBe(40);
  });

  it("fails closed to null when no step was resolvable (no catalog posting tiers)", () => {
    expect(baseApplicantQuotaForBand("1-5", null)).toBeNull();
  });
});

/**
 * SHOWN == CHARGED (#2085). Every price reader resolves a tier to the price a purchase of it is
 * CHARGED: the catalog's `prices[]` row (the active offer included) when the API sent one, the
 * catalog price only when it sent no `prices[]` at all. A tier missing from a present `prices[]`
 * is not on offer — the portal never invents a price for it.
 */
describe("chargedPrice + the price readers — #2085 effective prices", () => {
  // #2102 — the fixture's NAMED offer ends here, and every below-list expectation cites it.
  const ENDS_AT = "2026-11-01T00:00:00.000Z";
  const row = (productCode: string, tierCode: string, base: number, price: number): TierPrice => ({
    productCode,
    tierCode,
    basePriceInr: base,
    priceInr: price,
    discountInr: base - price,
    offer: price < base ? { code: "DIWALI", endsAt: ENDS_AT } : null,
  });
  // Every DEFAULT_CATALOG tier priced at list, except the offers set per test.
  const allAtList = (): TierPrice[] =>
    DEFAULT_CATALOG.products.flatMap((p) =>
      p.tiers.map((t) => row(p.code, t.code, t.priceInr, t.priceInr)),
    );
  const withOffer = (productCode: string, tierCode: string, price: number): TierPrice[] =>
    allAtList().map((r) =>
      r.productCode === productCode && r.tierCode === tierCode
        ? row(productCode, tierCode, r.basePriceInr, price)
        : r,
    );

  it("no prices[] (older API / cached fallback): the catalog price, no struck list price", () => {
    expect(chargedPrice({ products: [] }, "quota_topup", { code: "topup_10", priceInr: 1000 })).toEqual(
      { priceInr: 1000 },
    );
    expect(
      chargedPrice({ products: [], prices: null }, "quota_topup", { code: "topup_10", priceInr: 1000 }),
    ).toEqual({ priceInr: 1000 });
  });

  it("prices[] at list: the row's price — the catalog's own number is not what is read", () => {
    // The row disagrees with the catalog tier (a re-price between the two reads is impossible
    // server-side, but the reader must take the CHARGE source, not the catalog).
    const catalog = { products: [], prices: [row("quota_topup", "topup_10", 1200, 1200)] };
    expect(chargedPrice(catalog, "quota_topup", { code: "topup_10", priceInr: 1000 })).toEqual({
      priceInr: 1200,
    });
  });

  it("an active offer: the offer price is charged, the list price and the DEADLINE ride along", () => {
    // #2102 — a struck list price with no end date asks the payer to decide against an unstated
    // deadline, so `offerEndsAt` travels with it and the tile prints it.
    const catalog = { products: [], prices: [row("quota_topup", "topup_10", 1000, 750)] };
    expect(chargedPrice(catalog, "quota_topup", { code: "topup_10", priceInr: 1000 })).toEqual({
      priceInr: 750,
      listPriceInr: 1000,
      offerEndsAt: ENDS_AT,
    });
  });

  it("#2102 below list with NO named offer: the list price is struck, no date is invented", () => {
    // The API may price a row below list without naming an offer; there is then no end date to
    // state, and the reader must not substitute one.
    const unnamed: TierPrice = { ...row("quota_topup", "topup_10", 1000, 750), offer: null };
    expect(
      chargedPrice({ products: [], prices: [unnamed] }, "quota_topup", {
        code: "topup_10",
        priceInr: 1000,
      }),
    ).toEqual({ priceInr: 750, listPriceInr: 1000 });
  });

  it("#2102 at list with a named offer: no deadline — nothing was lowered to put a date on", () => {
    const atList: TierPrice = {
      ...row("quota_topup", "topup_10", 1000, 1000),
      offer: { code: "DIWALI", endsAt: ENDS_AT },
    };
    expect(
      chargedPrice({ products: [], prices: [atList] }, "quota_topup", {
        code: "topup_10",
        priceInr: 1000,
      }),
    ).toEqual({ priceInr: 1000 });
  });

  it("a tier missing from a PRESENT prices[] is not on offer (null) — never an invented price", () => {
    const catalog = { products: [], prices: [row("quota_topup", "topup_30", 2500, 2500)] };
    expect(chargedPrice(catalog, "quota_topup", { code: "topup_10", priceInr: 1000 })).toBeNull();
    // …matched on product AND tier: the same tier code under another product is not it.
    const other = { products: [], prices: [row("job_boost", "topup_10", 1000, 1000)] };
    expect(chargedPrice(other, "quota_topup", { code: "topup_10", priceInr: 1000 })).toBeNull();
  });

  it("quotaTopUpTier: the offer price (and the struck list price) — what the confirm shows and sends", () => {
    const catalog = {
      products: DEFAULT_CATALOG.products,
      prices: withOffer("quota_topup", "topup_10", 750),
    };
    expect(quotaTopUpTier(catalog)).toEqual({
      code: "topup_10",
      priceInr: 750,
      listPriceInr: 1000,
      offerEndsAt: ENDS_AT,
      additionalViews: 10,
    });
  });

  it("quotaTopUpTier: the smallest PRICED tier — an unpriced smallest tier is not sold", () => {
    const catalog = {
      products: DEFAULT_CATALOG.products,
      prices: allAtList().filter((r) => r.tierCode !== "topup_10"),
    };
    expect(quotaTopUpTier(catalog)).toEqual({ code: "topup_30", priceInr: 2500, additionalViews: 30 });
  });

  it("hiringCapacityTiers / offeredCreditPacks / postingPaidTiers read the charge price too", () => {
    const prices = [
      ...withOffer("hiring_capacity", "cap_15", 9000).filter((r) => r.productCode !== "contact_unlock"),
      row("contact_unlock", "pack_50", 2000, 2000),
      row("contact_unlock", "pack_200", 8000, 8000),
      // pack_1000 left unpriced → not on offer
    ];
    const catalog = { products: DEFAULT_CATALOG.products, prices };
    expect(hiringCapacityTiers(catalog)).toEqual([
      { code: "cap_5", priceInr: 5000, maxActiveVacancies: expect.any(Number) },
      {
        code: "cap_15",
        priceInr: 9000,
        listPriceInr: 12000,
        offerEndsAt: ENDS_AT,
        maxActiveVacancies: expect.any(Number),
      },
    ]);
    expect(offeredCreditPacks(catalog).map((p) => p.code)).toEqual(["pack_50", "pack_200"]);
    expect(postingPaidTiers(catalog).map((t) => [t.code, t.priceInr])).toEqual([
      ["standard", 1000],
      ["pro", 2500],
    ]);
  });

  it("the per-unlock unit price follows the packs on offer (no prices[] → the catalog packs)", () => {
    const fallback = unlockUnitPriceInr({ products: DEFAULT_CATALOG.products });
    expect(fallback).toBe(40); // pack_50: ₹2,000 / 50
    const repriced = {
      products: DEFAULT_CATALOG.products,
      prices: allAtList().map((r) =>
        r.tierCode === "pack_50" ? row("contact_unlock", "pack_50", 2500, 2500) : r,
      ),
    };
    expect(unlockUnitPriceInr(repriced)).toBe(50);
  });
});
