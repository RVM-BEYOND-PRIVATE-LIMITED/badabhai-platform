import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PricingController } from "./pricing.controller";
import { UpdateCatalogSchema } from "./pricing.dto";

/**
 * #2749 — the OPS catalogue write (`PUT /pricing/catalog`) refuses what the shared schema would
 * silently drop or accept:
 *  - an UNKNOWN credit-pack tier key. A misspelt `onSaleFrom` / `offered` would otherwise be
 *    dropped and the "hidden" pack sold at once;
 *  - a credit pack priced over ₹1,00,00,000 (the `expected_price_inr` cap).
 * The shared `creditPackTierSchema` is NOT made strict: payer-web parses API replies with it.
 *
 * Driven through the very pipe the controller's PUT binds, so a 400 here is the route's 400.
 */

/** The ZodValidationPipe instance bound to `PricingController.updateCatalog`'s body. */
function putPipe(): ZodValidationPipe<typeof UpdateCatalogSchema> {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    PricingController,
    "updateCatalog",
  ) as Record<string, { pipes?: unknown[] }>;
  const pipe = Object.values(args)
    .flatMap((a) => a.pipes ?? [])
    .find(
      (p): p is ZodValidationPipe<typeof UpdateCatalogSchema> => p instanceof ZodValidationPipe,
    );
  expect(
    pipe,
    "PUT /pricing/catalog must validate its body with a ZodValidationPipe",
  ).toBeDefined();
  return pipe!;
}

const PACK_INDEX = DEFAULT_CATALOG.products.findIndex((p) => p.kind === "credit_pack");

/** A PUT body whose `contact_unlock` tiers are `tiers` (raw — not pre-parsed). */
function body(tiers: Array<Record<string, unknown>>, catalogExtra: Record<string, unknown> = {}) {
  return {
    updated_by: "44444444-4444-4444-8444-444444444444",
    catalog: {
      ...DEFAULT_CATALOG,
      products: DEFAULT_CATALOG.products.map((p) =>
        p.kind === "credit_pack" ? { ...p, tiers } : p,
      ),
      ...catalogExtra,
    },
    change: { change_type: "plan", entity_code: "contact_unlock", changed_fields: ["tiers"] },
  };
}

const STARTER = {
  code: "pack_starter",
  priceInr: 999,
  credits: 20,
  windowDays: 14,
  validityDays: 30,
};
const ANNUAL = {
  code: "pack_annual",
  priceInr: 9999,
  credits: 360,
  windowDays: 14,
  validityDays: 365,
  onSaleFrom: "2027-04-01",
};

/** The 400's issues, or a failure if the pipe accepted the body. */
function issuesOf(raw: unknown): Array<{ path: string; message: string }> {
  try {
    putPipe().transform(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const res = (err as BadRequestException).getResponse() as {
      issues: Array<{ path: string; message: string }>;
    };
    return res.issues;
  }
  throw new Error("expected a 400, but the body was accepted");
}

describe("PUT /pricing/catalog — ops-only credit-pack checks (#2749)", () => {
  it("accepts the brief's packs with every valid new field", () => {
    const dto = putPipe().transform(
      body([STARTER, ANNUAL, { ...STARTER, code: "pack_retired", offered: false }]),
    );
    const packs = dto.catalog.products[PACK_INDEX]!;
    expect(packs.kind).toBe("credit_pack");
    expect(packs.tiers[1]).toMatchObject({ code: "pack_annual", onSaleFrom: "2027-04-01" });
    expect(packs.tiers[2]).toMatchObject({ code: "pack_retired", offered: false });
  });

  it.each(["onsaleFrom", "on_sale_from", "Offered"])(
    "a misspelt key %j is a 400 that names it (never dropped, never sold)",
    (typo) => {
      const issues = issuesOf(
        body([STARTER, { ...STARTER, code: "pack_annual", [typo]: "2027-04-01" }]),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toBe(`catalog.products.${PACK_INDEX}.tiers.1.${typo}`);
      expect(issues[0]!.message).toContain(`"${typo}"`);
      expect(issues[0]!.message).toContain("onSaleFrom");
    },
  );

  it("names every unknown key, on every tier", () => {
    const issues = issuesOf(
      body([
        { ...STARTER, foo: 1 },
        { ...ANNUAL, bar: true },
      ]),
    );
    expect(issues.map((i) => i.path)).toEqual([
      `catalog.products.${PACK_INDEX}.tiers.0.foo`,
      `catalog.products.${PACK_INDEX}.tiers.1.bar`,
    ]);
  });

  it("other product kinds keep today's behaviour (an extra key is dropped, not refused)", () => {
    const raw = body([STARTER]);
    const boostIndex = raw.catalog.products.findIndex((p) => p.kind === "boost");
    const products = raw.catalog.products.map((p, i) =>
      i === boostIndex ? { ...p, tiers: p.tiers.map((t) => ({ ...t, note: "x" })) } : p,
    );
    const dto = putPipe().transform({ ...raw, catalog: { ...raw.catalog, products } });
    expect(JSON.stringify(dto.catalog.products[boostIndex])).not.toContain("note");
  });

  it("caps a credit pack's priceInr at 10,000,000 (the expected_price_inr cap)", () => {
    expect(() => putPipe().transform(body([{ ...STARTER, priceInr: 10_000_000 }]))).not.toThrow();
    const issues = issuesOf(body([{ ...STARTER, priceInr: 10_000_001 }]));
    expect(issues).toEqual([
      {
        path: `catalog.products.${PACK_INDEX}.tiers.0.priceInr`,
        message: "credit pack pack_starter: priceInr must be at most 10000000",
      },
    ]);
  });

  it("a malformed catalogue still gets the shared schema's 400 (the raw check never throws)", () => {
    expect(issuesOf({ ...body([STARTER]), catalog: "not a catalogue" }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...body([STARTER]), catalog: { products: "x" } }).length).toBeGreaterThan(0);
    expect(issuesOf(body([STARTER, "not a tier" as never])).length).toBeGreaterThan(0);
  });

  it("the same schema the module exports is the one the route binds", () => {
    expect((putPipe() as unknown as { schema: unknown }).schema).toBe(UpdateCatalogSchema);
  });
});
