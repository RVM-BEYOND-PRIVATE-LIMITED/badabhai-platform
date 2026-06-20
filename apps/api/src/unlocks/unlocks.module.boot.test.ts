import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { UnlocksModule } from "./unlocks.module";
import { UnlocksController } from "./unlocks.controller";
import { ConsentModule } from "../consent/consent.module";
import { ConsentRepository } from "../consent/consent.repository";
import { PayersModule } from "../payers/payers.module";
import { PayerAuthGuard } from "../payers/payer-auth.guard";

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

  it("imports PayersModule (source of PayerAuthGuard + the XB-G PayerDisclosureRateLimit cap)", () => {
    // R16 / LC-1: the self-serve surface binds every route to PayerAuthGuard and runs the
    // per-payer XB-G cap before the chokepoint — both are exported by PayersModule.
    expect(getMeta("imports", UnlocksModule)).toContain(PayersModule);
    const exported = getMeta("exports", PayersModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(exported).toContain("PayerAuthGuard");
    expect(exported).toContain("PayerDisclosureRateLimit");
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

  it("EVERY route is guarded by PayerAuthGuard (R16 / LC-1 — the self-serve payer surface)", () => {
    // The class-level @UseGuards applies to all routes: payer_id is the session payer,
    // never a body/param-trusted value (replaces the interim InternalServiceGuard seam).
    const classGuards = getMeta("__guards__", UnlocksController);
    expect(classGuards).toContain(PayerAuthGuard);
  });
});
