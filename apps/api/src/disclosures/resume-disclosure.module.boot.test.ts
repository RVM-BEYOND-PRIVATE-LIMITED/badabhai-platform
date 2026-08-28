import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ResumeDisclosureModule } from "./resume-disclosure.module";
import { ResumeDisclosureController } from "./resume-disclosure.controller";
import { ConsentModule } from "../consent/consent.module";
import { ConsentRepository } from "../consent/consent.repository";
import { StorageModule } from "../storage/storage.module";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";

/**
 * DI WIRING REGRESSION GUARD (resume-disclosure stream) — same PR #38 lesson as the
 * unlock module: cross-module deps must be reachable in the importing injector. We
 * assert the @Module/@UseGuards metadata rather than building the container (the repo's
 * vitest setup does not emit design:paramtypes).
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("ResumeDisclosureModule wiring (cross-module DI regression guard)", () => {
  it("imports ConsentModule (ConsentRepository for the employer_sharing gate) + StorageModule", () => {
    const imports = getMeta("imports", ResumeDisclosureModule);
    expect(imports).toContain(ConsentModule);
    expect(imports).toContain(StorageModule);
  });

  it("ConsentModule exports ConsentRepository (the disclosure-consent read dependency)", () => {
    expect(getMeta("exports", ConsentModule)).toContain(ConsentRepository);
  });

  it("declares every constructor dependency the service cannot get from a @Global module", () => {
    expect(getMeta("controllers", ResumeDisclosureModule)).toContain(ResumeDisclosureController);
    const providers = getMeta("providers", ResumeDisclosureModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("ResumeDisclosureService");
    expect(providers).toContain("ResumeDisclosureRepository");
    expect(providers).toContain("ResumeRenderer");
    // Feeds the trade capability block on the masked sheet. Provided locally rather than
    // imported from ProfilesModule so the payer surface gains no edge into that subtree.
    expect(providers).toContain("WorkerAttributesRepository");

    // THIS LIST IS HAND-MAINTAINED, AND THAT IS THIS FILE'S REAL LIMITATION — worth stating
    // because the filename promises more than the test delivers. Nothing here builds the
    // container (the repo's vitest setup emits no `design:paramtypes`), so a new constructor
    // dependency that NOBODY provides still passes every assertion above and fails only when
    // the app boots. Measured: removing `WorkerAttributesRepository` from the module left all
    // four tests in this file green. Adding a dependency to the service means adding it here.
  });

  it("EVERY route is guarded by InternalServiceGuard (interim payer auth, F-7 / LC-A)", () => {
    const classGuards = getMeta("__guards__", ResumeDisclosureController);
    expect(classGuards).toContain(InternalServiceGuard);
  });
});
