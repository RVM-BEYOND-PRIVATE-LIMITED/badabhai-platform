import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PricingController } from "./pricing.controller";
import type { PricingService } from "./pricing.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

function make() {
  const pricing = {
    getActiveCatalog: vi.fn(async () => ({ catalog: {}, source: "stored" })),
    updateCatalog: vi.fn(async () => ({ revision: 8 })),
    quote: vi.fn(async () => ({ amount_inr: 100 })),
  };
  return { controller: new PricingController(pricing as unknown as PricingService), pricing };
}

describe("PricingController (thin) — delegation", () => {
  it("getCatalog delegates to getActiveCatalog", async () => {
    const { controller, pricing } = make();
    await controller.getCatalog();
    expect(pricing.getActiveCatalog).toHaveBeenCalledOnce();
  });

  it("updateCatalog delegates dto + ctx", async () => {
    const { controller, pricing } = make();
    const dto = { catalog: {}, updated_by: "ops-1" };
    await controller.updateCatalog(dto as never, CTX);
    expect(pricing.updateCatalog).toHaveBeenCalledWith(dto, CTX);
  });

  it("quote delegates the query", async () => {
    const { controller, pricing } = make();
    const query = { sku: "unlock", qty: 1 };
    await controller.quote(query as never);
    expect(pricing.quote).toHaveBeenCalledWith(query);
  });
});
