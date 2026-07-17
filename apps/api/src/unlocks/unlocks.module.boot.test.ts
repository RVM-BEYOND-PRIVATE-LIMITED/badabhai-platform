import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { UnlocksModule } from "./unlocks.module";
import { UnlocksController } from "./unlocks.controller";
import { ConsentModule } from "../consent/consent.module";
import { ConsentRepository } from "../consent/consent.repository";
import { PricingModule } from "../pricing/pricing.module";
import { PricingService } from "../pricing/pricing.service";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";

/**
 * DI WIRING REGRESSION GUARD (ADR-0010, Stream A) — the PR #38 lesson: a cross-module
 * dependency must be reachable in the importing module's injector, and a module may
 * only re-export a MODULE it imports (not a foreign provider directly). We assert the
 * Nest module/route METADATA (defined eagerly by @Module/@UseGuards) rather than
 * building the container (the repo's vitest setup does not emit design:paramtypes).
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("UnlocksModule wiring (cross-module DI regression guard)", () => {
  it("imports ConsentModule (source of ConsentRepository for the employer_sharing gate)", () => {
    expect(getMeta("imports", UnlocksModule)).toContain(ConsentModule);
  });

  it("ConsentModule exports ConsentRepository (the disclosure-consent read dependency)", () => {
    expect(getMeta("exports", ConsentModule)).toContain(ConsentRepository);
  });

  // D-6: the PaymentGateway resolves credit packs through the ONE pricing engine, so the
  // price/credits CHARGED equal the ones the portal DISPLAYED. That dep must be reachable
  // in THIS injector (the PR #38 lesson) — assert the import AND that it exports the service.
  it("imports PricingModule (source of PricingService for the live credit-pack resolve)", () => {
    expect(getMeta("imports", UnlocksModule)).toContain(PricingModule);
  });

  it("PricingModule exports PricingService (the live-catalog resolve dependency)", () => {
    expect(getMeta("exports", PricingModule)).toContain(PricingService);
  });

  it("declares the controller + service + repository + payment gateway", () => {
    expect(getMeta("controllers", UnlocksModule)).toContain(UnlocksController);
    const providers = getMeta("providers", UnlocksModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("UnlockService");
    expect(providers).toContain("UnlocksRepository");
    expect(providers).toContain("PaymentGateway");
  });

  it("EVERY route is guarded by InternalServiceGuard (interim payer auth, F-7)", () => {
    // The class-level @UseGuards applies to all routes.
    const classGuards = getMeta("__guards__", UnlocksController);
    expect(classGuards).toContain(InternalServiceGuard);
  });
});
