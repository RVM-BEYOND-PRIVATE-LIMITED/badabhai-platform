import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  DEFAULT_CATALOG,
  gstPriceLine,
  type Catalog,
  type CreditPackTier,
} from "@badabhai/pricing";
import { PaymentGateway } from "./payment-gateway";
import type { UnlocksRepository } from "./unlocks.repository";
import type { RazorpayClient } from "./razorpay.client";
import { PricingService } from "../pricing/pricing.service";
import type { TenantKey } from "../payers/payer-tenant-scope";

/**
 * D-6 MEDIUM-1 — display/charge coupling at the credit-pack seam, and #2749 — purchase accepts
 * ONLY a pack the live catalogue lists and has on sale.
 *
 * The portal RENDERS the live `contact_unlock` tiers, so the CHARGE must resolve from the
 * SAME catalog or an ops price edit means advertised ≠ charged (and advertised-credits ≠
 * GRANTED-credits). These pin:
 *  - an ops-edited price/credits flows into the resolved pack (and onto the ledger stamp);
 *  - a LIVE-ONLY new tier resolves;
 *  - #2749: legacy pack_10/pack_25 (constant-only, absent from the catalog) are REFUSED — the
 *    constant fallback is gone — and so is any off-sale tier (offered:false, a future
 *    onSaleFrom), with the IST day boundary pinned;
 *  - a truly unknown code is null (→ the caller's 404).
 */

const CONFIG = { PAYMENTS_ENABLE_REAL: false } as unknown as ServerConfig;
/** The wallet the service resolved (ADR-0053) — the gateway never resolves one itself. */
const WALLET = "payer-1" as TenantKey;

/** A catalog whose `contact_unlock` tiers are replaced wholesale. */
function catalogWithUnlockTiers(tiers: CreditPackTier[]): Catalog {
  return {
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) =>
      p.kind === "credit_pack" && p.code === "contact_unlock" ? { ...p, tiers } : p,
    ),
  } as Catalog;
}

/** A provider client that is NOT live — the mock-mode default this suite exercises. */
function offlineRazorpay() {
  return {
    isLive: false,
    keyId: null,
    createOrder: vi.fn(async () => {
      throw new Error("createOrder must never be called while real payments are off");
    }),
  } as unknown as RazorpayClient;
}

function makeGateway(
  catalog: Catalog = DEFAULT_CATALOG,
  provenance: { source: "db" | "default"; revision: number } = { source: "db", revision: 2 },
) {
  const repo = { creditPack: vi.fn(async () => 60) };
  const pricing = {
    getActiveCatalog: vi.fn(async () => ({ catalog, ...provenance })),
  };
  const gw = new PaymentGateway(
    repo as unknown as UnlocksRepository,
    CONFIG,
    pricing as unknown as PricingService,
    offlineRazorpay(),
  );
  return { gw, repo, pricing };
}

describe("PaymentGateway.resolvePack — LIVE catalog, on-sale packs only (D-6 + #2749)", () => {
  it("resolves the default catalog tier (unchanged behaviour when ops has edited nothing)", async () => {
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_50")).resolves.toEqual({
      code: "pack_50",
      priceInr: 2000, // the LIST price, before GST (what expected_price_inr is compared with)
      credits: 50,
      validityDays: null, // DEFAULT_CATALOG sets none
      // #2749 PR 3: what the purchase charges — ₹2,000 + 18% = ₹2,360.
      priceLine: {
        taxablePaise: 200000,
        gstPaise: 36000,
        roundOffPaise: 0,
        totalPaise: 236000,
        gstRateBps: 1800,
      },
    });
  });

  it("an ops-EDITED price + credits flow into the charge (the divergence this closes)", async () => {
    // Ops re-priced pack_50 to ₹1,500 AND raised the grant to 60 credits.
    const { gw } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_50", priceInr: 1500, credits: 60, windowDays: 14 }]),
    );
    const pack = await gw.resolvePack("pack_50");
    // Both the ₹ AND the grant follow the catalog — the compile-time constant says 2000/50.
    expect(pack).toEqual({
      code: "pack_50",
      priceInr: 1500,
      credits: 60,
      validityDays: null,
      priceLine: gstPriceLine(1500),
    });
  });

  it("a LIVE-ONLY new tier resolves, with its validityDays", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([
        { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
      ]),
    );
    await expect(gw.resolvePack("pack_starter")).resolves.toEqual({
      code: "pack_starter",
      priceInr: 999,
      credits: 20,
      validityDays: 30,
      // The worked example, GST rounded to the rupee (owner ruling 2026-11-18): 99,900 + 18,000 =
      // 1,17,900 paise (₹1,179), no round-off.
      priceLine: {
        taxablePaise: 99900,
        gstPaise: 18000,
        roundOffPaise: 0,
        totalPaise: 117900,
        gstRateBps: 1800,
      },
    });
  });

  it("#2749: constant-only pack_10 / pack_25 are REFUSED (no constant fallback for purchases)", async () => {
    // They are in packages/db's CREDIT_PACKS (kept for ledger history) but not in the catalog.
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_10")).resolves.toBeNull();
    await expect(gw.resolvePack("pack_25")).resolves.toBeNull();
  });

  it("#2749: an old code a published catalogue drops is refused too (pack_50 after go-live)", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([
        { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
      ]),
    );
    for (const code of ["pack_50", "pack_200", "pack_1000", "pack_10", "pack_25"]) {
      await expect(gw.resolvePack(code)).resolves.toBeNull();
    }
  });

  it("the catalog's own pack_10 resolves at the catalog's price (ops is the source of truth)", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_10", priceInr: 777, credits: 11, windowDays: 14 }]),
    );
    await expect(gw.resolvePack("pack_10")).resolves.toEqual({
      code: "pack_10",
      priceInr: 777,
      credits: 11,
      validityDays: null,
      priceLine: gstPriceLine(777),
    });
  });

  it("a code the catalog does not list is null (→ the caller's 404)", async () => {
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_does_not_exist")).resolves.toBeNull();
  });

  it("#2749: a catalogue pack is refused BEFORE 00:00 IST on its onSaleFrom and accepted from then", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([
        { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 },
        {
          code: "pack_annual",
          priceInr: 9999,
          credits: 360,
          windowDays: 14,
          validityDays: 365,
          onSaleFrom: "2027-04-01",
        },
      ]),
    );
    await expect(
      gw.resolvePack("pack_annual", new Date("2027-03-31T18:29:59Z")),
    ).resolves.toBeNull();
    await expect(gw.resolvePack("pack_annual", new Date("2027-03-31T18:30:00Z"))).resolves.toEqual({
      code: "pack_annual",
      priceInr: 9999,
      credits: 360,
      validityDays: 365,
      priceLine: gstPriceLine(9999), // ₹11,799
    });
    // The other pack is unaffected either side of the boundary.
    await expect(
      gw.resolvePack("pack_50", new Date("2027-03-31T18:29:59Z")),
    ).resolves.toMatchObject({
      code: "pack_50",
    });
  });

  it("#2749: an offered:false pack is refused, whatever the date", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([
        { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14, offered: false },
        {
          code: "pack_old",
          priceInr: 500,
          credits: 5,
          windowDays: 14,
          offered: false,
          onSaleFrom: "2020-01-01",
        },
      ]),
    );
    await expect(gw.resolvePack("pack_50")).resolves.toBeNull();
    await expect(gw.resolvePack("pack_old")).resolves.toBeNull();
  });

  it("#2749: the default clock is now — a future onSaleFrom is refused today", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([
        {
          code: "pack_future",
          priceInr: 999,
          credits: 20,
          windowDays: 14,
          onSaleFrom: "2999-01-01",
        },
      ]),
    );
    await expect(gw.resolvePack("pack_future")).resolves.toBeNull();
  });

  it("#2749: with NO stored row (production today) the DEFAULT packs still sell", async () => {
    // getActiveCatalog reports "no row" as source:"default", revision 0.
    const { gw } = makeGateway(DEFAULT_CATALOG, { source: "default", revision: 0 });
    for (const code of ["pack_50", "pack_200", "pack_1000"]) {
      await expect(gw.resolvePack(code)).resolves.toMatchObject({ code });
    }
  });

  it("#2749: a stored row that FAILED validation sells nothing — not the default packs it falls back to", async () => {
    // getActiveCatalog reports a rejected row as source:"default" with that row's revision (≥ 1).
    const { gw } = makeGateway(DEFAULT_CATALOG, { source: "default", revision: 7 });
    for (const code of ["pack_50", "pack_200", "pack_1000"]) {
      await expect(gw.resolvePack(code)).resolves.toBeNull();
    }
  });

  it("#2749: the same two states through the REAL PricingService", async () => {
    const real = (row: unknown) =>
      new PaymentGateway(
        { creditPack: vi.fn() } as unknown as UnlocksRepository,
        CONFIG,
        new PricingService(
          { getActive: vi.fn().mockResolvedValue(row) } as never,
          {
            emit: vi.fn(),
          } as never,
          { RETIRED_PRODUCTS_OFF_SALE: false },
        ),
        offlineRazorpay(),
      );
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await expect(real(undefined).resolvePack("pack_50")).resolves.toMatchObject({
        priceInr: 2000,
        credits: 50,
      });
      await expect(
        real({ catalog: { version: 1, products: "broken" }, revision: 3 }).resolvePack("pack_50"),
      ).resolves.toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it("#2749: a pack whose GST line cannot be computed is refused and logged (code + error class)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { gw } = makeGateway(
        catalogWithUnlockTiers([
          { code: "pack_50", priceInr: 2000, credits: 50, windowDays: 14 },
          { code: "pack_huge", priceInr: 9_999_999_999, credits: 1, windowDays: 14 },
        ]),
      );
      await expect(gw.resolvePack("pack_huge")).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "credit pack refused: GST line failed pack=pack_huge error=RangeError",
      );
      await expect(gw.resolvePack("pack_50")).resolves.toMatchObject({ priceInr: 2000 });
    } finally {
      warn.mockRestore();
    }
  });

  it("#2749: a tier of ANOTHER credit-pack product is never sold (only contact_unlock)", async () => {
    const { gw } = makeGateway({
      ...DEFAULT_CATALOG,
      products: [
        ...DEFAULT_CATALOG.products,
        {
          kind: "credit_pack",
          code: "bulk_unlock",
          tiers: [{ code: "pack_bulk", priceInr: 4321, credits: 99, windowDays: 14 }],
        },
      ],
    } as Catalog);
    await expect(gw.resolvePack("pack_bulk")).resolves.toBeNull();
  });

  it("a catalog read failure PROPAGATES — the charge path never invents a price", async () => {
    // Unlike the DISPLAY seam (payer-web fails OPEN to cached prices), no money may move
    // on a guessed amount: the error surfaces and the purchase does not happen.
    const repo = { creditPack: vi.fn() };
    const pricing = {
      getActiveCatalog: vi.fn(async () => {
        throw new Error("catalog unavailable");
      }),
    };
    const gw = new PaymentGateway(
      repo as unknown as UnlocksRepository,
      CONFIG,
      pricing as unknown as PricingService,
      offlineRazorpay(),
    );
    await expect(gw.resolvePack("pack_50")).rejects.toThrow("catalog unavailable");
    expect(repo.creditPack).not.toHaveBeenCalled();
  });
});

describe("PaymentGateway.purchasePackMock — stamps the CHARGED ₹ on the ledger (D-6 MEDIUM-2)", () => {
  it("grants the resolved tier's credits and stamps its LIST price onto the ledger row", async () => {
    const { gw, repo } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_50", priceInr: 1500, credits: 60, windowDays: 14 }]),
    );
    const pack = (await gw.resolvePack("pack_50"))!;
    const res = await gw.purchasePackMock(WALLET, pack);

    expect(repo.creditPack).toHaveBeenCalledWith({
      payerId: WALLET, // the resolved tenant's wallet, exactly as handed in
      credits: 60, // the LIVE grant
      reason: "pack_purchase",
      packCode: "pack_50",
      paymentRef: null,
      // The LIVE price, STAMPED so History can never be re-priced. The LIST price, before GST:
      // this mock route takes no money and is retired at switch-on, so #2749 PR 3 leaves it as it
      // was (a real order charges the GST total, ₹1,770 here).
      priceInr: 1500,
      validityDays: null, // the tier sets none: the lot never expires
    });
    expect(res).toEqual({ balanceAfter: 60, credits: 60, priceInr: 1500, realCall: false });
  });

  it("#2749 PR 3: passes the tier's validityDays to the lot", async () => {
    const { gw, repo } = makeGateway(
      catalogWithUnlockTiers([
        { code: "pack_starter", priceInr: 999, credits: 20, windowDays: 14, validityDays: 30 },
      ]),
    );
    const pack = (await gw.resolvePack("pack_starter"))!;
    await gw.purchasePackMock(WALLET, pack);
    expect(repo.creditPack).toHaveBeenCalledWith(
      expect.objectContaining({ priceInr: 999, validityDays: 30 }),
    );
  });

  it("money stays MOCK — real_call is the honest false", async () => {
    const { gw } = makeGateway();
    const pack = (await gw.resolvePack("pack_50"))!;
    await expect(gw.purchasePackMock(WALLET, pack)).resolves.toMatchObject({ realCall: false });
  });
});
