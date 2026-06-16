import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { PricingService } from "./pricing.service";
import type { UpdateCatalogDto } from "./pricing.dto";

const OPS = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

function make(activeRow?: { catalog: unknown; revision: number; id?: string }) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const getActive = vi.fn().mockResolvedValue(activeRow);
  const publish = vi.fn().mockImplementation(async (input: { revision: number }) => ({
    id: "11111111-1111-4111-8111-111111111111",
    revision: input.revision,
  }));
  const service = new PricingService(
    { getActive, publish } as never,
    { emit } as never,
  );
  return { service, emit, getActive, publish };
}

describe("PricingService.getActiveCatalog (fail-closed)", () => {
  it("returns the typed default when no row is seeded", async () => {
    const { service } = make(undefined);
    const res = await service.getActiveCatalog();
    expect(res.source).toBe("default");
    expect(res.revision).toBe(0);
    expect(res.catalog).toBe(DEFAULT_CATALOG);
  });

  it("returns a valid stored catalog as source=db", async () => {
    const { service } = make({ catalog: DEFAULT_CATALOG, revision: 3 });
    const res = await service.getActiveCatalog();
    expect(res.source).toBe("db");
    expect(res.revision).toBe(3);
  });

  it("FAILS CLOSED to the default when a stored row is invalid (never serves garbage)", async () => {
    const bad = { products: [{ kind: "boost", code: "x", tiers: [{ code: "t", priceInr: -1, boostDays: 2 }] }] };
    const { service } = make({ catalog: bad, revision: 7 });
    const res = await service.getActiveCatalog();
    expect(res.source).toBe("default");
    expect(res.catalog).toBe(DEFAULT_CATALOG);
    expect(res.revision).toBe(7); // surfaces the rejected revision, but serves the default
  });
});

describe("PricingService.quote", () => {
  it("resolves a price against the active catalog", async () => {
    const { service } = make({ catalog: DEFAULT_CATALOG, revision: 1 });
    const res = await service.quote({ product: "job_posting", tier: "standard" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.quote.finalInr).toBe(1000);
  });

  it("returns unavailable for an unknown product/tier (no 0-price)", async () => {
    const { service } = make({ catalog: DEFAULT_CATALOG, revision: 1 });
    const res = await service.quote({ product: "ghost", tier: "x" });
    expect(res).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("PricingService.updateCatalog", () => {
  const dto: UpdateCatalogDto = {
    updated_by: OPS,
    catalog: DEFAULT_CATALOG,
    change: { change_type: "plan", entity_code: "job_posting", changed_fields: ["priceInr"] },
  };

  it("publishes revision+1 and emits a PII-free pricing.changed event", async () => {
    const { service, publish, emit } = make({ catalog: DEFAULT_CATALOG, revision: 4 });
    const res = await service.updateCatalog(dto, CTX);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5, updatedBy: OPS }),
    );
    expect(res.revision).toBe(5);
    expect(res.source).toBe("db");
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.event_name).toBe("pricing.changed");
    expect(event.actor).toEqual({ actor_type: "ops", actor_id: OPS });
    expect(event.subject.subject_type).toBe("pricing_plan");
    // Field KEYS only — no old/new values in the payload.
    expect(event.payload).toEqual({
      change_type: "plan",
      entity_code: "job_posting",
      changed_fields: ["priceInr"],
      changed_by: OPS,
    });
  });

  it("starts at revision 1 when no catalog exists yet", async () => {
    const { service, publish } = make(undefined);
    await service.updateCatalog(dto, CTX);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
  });
});
