import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_CATALOG, type Catalog } from "@badabhai/pricing";
import { PaymentGateway } from "./payment-gateway";
import type { UnlocksRepository } from "./unlocks.repository";
import type { PricingService } from "../pricing/pricing.service";

/**
 * D-6 MEDIUM-1 — display/charge coupling at the credit-pack seam.
 *
 * The portal RENDERS the live `contact_unlock` tiers, so the CHARGE must resolve from the
 * SAME catalog or an ops price edit means advertised ≠ charged (and advertised-credits ≠
 * GRANTED-credits). These pin:
 *  - an ops-edited price/credits flows into the resolved pack (and onto the ledger stamp);
 *  - a LIVE-ONLY new tier resolves (it would 404 against the compile-time constants);
 *  - legacy pack_10/pack_25 (retained, not offered → absent from the catalog) still
 *    resolve via the constant fallback (invariant #8);
 *  - the live catalog WINS over a same-code constant (ops is the source of truth);
 *  - a truly unknown code is undefined (→ the caller's 404).
 */

const CONFIG = { PAYMENTS_ENABLE_REAL: false } as unknown as ServerConfig;

/** A catalog whose `contact_unlock` tiers are replaced wholesale. */
function catalogWithUnlockTiers(
  tiers: Array<{ code: string; priceInr: number; credits: number; windowDays: number }>,
): Catalog {
  return {
    ...DEFAULT_CATALOG,
    products: DEFAULT_CATALOG.products.map((p) =>
      p.kind === "credit_pack" && p.code === "contact_unlock" ? { ...p, tiers } : p,
    ),
  } as Catalog;
}

function makeGateway(catalog: Catalog = DEFAULT_CATALOG) {
  const repo = { creditPack: vi.fn(async () => 60) };
  const pricing = {
    getActiveCatalog: vi.fn(async () => ({ catalog, revision: 2, source: "db" as const })),
  };
  const gw = new PaymentGateway(
    repo as unknown as UnlocksRepository,
    CONFIG,
    pricing as unknown as PricingService,
  );
  return { gw, repo, pricing };
}

describe("PaymentGateway.resolvePack — LIVE catalog first (D-6 display==charge)", () => {
  it("resolves the default catalog tier (unchanged behaviour when ops has edited nothing)", async () => {
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_50")).resolves.toEqual({
      code: "pack_50",
      priceInr: 2000,
      credits: 50,
    });
  });

  it("an ops-EDITED price + credits flow into the charge (the divergence this closes)", async () => {
    // Ops re-priced pack_50 to ₹1,500 AND raised the grant to 60 credits.
    const { gw } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_50", priceInr: 1500, credits: 60, windowDays: 14 }]),
    );
    const pack = await gw.resolvePack("pack_50");
    // Both the ₹ AND the grant follow the catalog — the compile-time constant says 2000/50.
    expect(pack).toEqual({ code: "pack_50", priceInr: 1500, credits: 60 });
  });

  it("a LIVE-ONLY new tier resolves instead of 404ing (no compile-time constant exists)", async () => {
    const { gw } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_500", priceInr: 16000, credits: 500, windowDays: 14 }]),
    );
    await expect(gw.resolvePack("pack_500")).resolves.toEqual({
      code: "pack_500",
      priceInr: 16000,
      credits: 500,
    });
  });

  it("LEGACY pack_10 / pack_25 still resolve via the constant fallback (invariant #8)", async () => {
    // They are RETAINED-but-not-OFFERED, so the catalog does not carry them.
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_10")).resolves.toEqual({
      code: "pack_10",
      priceInr: 1000,
      credits: 10,
    });
    await expect(gw.resolvePack("pack_25")).resolves.toEqual({
      code: "pack_25",
      priceInr: 2000,
      credits: 25,
    });
  });

  it("the LIVE catalog WINS over a same-code legacy constant (ops is the source of truth)", async () => {
    // A catalog that re-defines the legacy pack_10 at a new price must not be shadowed.
    const { gw } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_10", priceInr: 777, credits: 11, windowDays: 14 }]),
    );
    await expect(gw.resolvePack("pack_10")).resolves.toEqual({
      code: "pack_10",
      priceInr: 777,
      credits: 11,
    });
  });

  it("a code in NEITHER the catalog nor the constants is undefined (→ the caller's 404)", async () => {
    const { gw } = makeGateway();
    await expect(gw.resolvePack("pack_does_not_exist")).resolves.toBeUndefined();
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
    );
    await expect(gw.resolvePack("pack_50")).rejects.toThrow("catalog unavailable");
    expect(repo.creditPack).not.toHaveBeenCalled();
  });
});

describe("PaymentGateway.purchasePackMock — stamps the CHARGED ₹ on the ledger (D-6 MEDIUM-2)", () => {
  it("grants the resolved tier's credits and stamps its priceInr onto the ledger row", async () => {
    const { gw, repo } = makeGateway(
      catalogWithUnlockTiers([{ code: "pack_50", priceInr: 1500, credits: 60, windowDays: 14 }]),
    );
    const pack = (await gw.resolvePack("pack_50"))!;
    const res = await gw.purchasePackMock("payer-1", pack);

    expect(repo.creditPack).toHaveBeenCalledWith({
      payerId: "payer-1",
      credits: 60, // the LIVE grant
      reason: "pack_purchase",
      packCode: "pack_50",
      paymentRef: null,
      priceInr: 1500, // the LIVE charge, STAMPED so History can never be re-priced
    });
    expect(res).toEqual({ balanceAfter: 60, credits: 60, priceInr: 1500, realCall: false });
  });

  it("money stays MOCK — real_call is the honest false", async () => {
    const { gw } = makeGateway();
    const pack = (await gw.resolvePack("pack_50"))!;
    await expect(gw.purchasePackMock("payer-1", pack)).resolves.toMatchObject({ realCall: false });
  });
});
