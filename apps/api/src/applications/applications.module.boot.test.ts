import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ApplicationsModule } from "./applications.module";
import { ApplicationsController } from "./applications.controller";
import { AuthModule } from "../auth/auth.module";
import { ConsentModule } from "../consent/consent.module";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";

/**
 * DI WIRING REGRESSION GUARD (ADR-0009 Stream B). The lesson this protects: a
 * guard used cross-module needs ITS dependencies reachable in the importing
 * module's injector, or the app fails to BOOT even though the plain unit tests
 * pass — and the specific Nest rule that a module may only re-export a MODULE it
 * imports (not a foreign module's provider directly).
 *
 * We assert the Nest module/route METADATA (defined eagerly by @Module / @UseGuards
 * via Reflect.defineMetadata) rather than constructing the container, because the
 * repo's vitest setup does not emit `design:paramtypes`, so type-based DI cannot be
 * instantiated under the test runner (the live boot is exercised by `nest build`
 * and the opt-in tests/e2e HTTP suite). The metadata below IS the wiring contract:
 * if AuthModule reverts to exporting ConsentRepository directly (the bug that was
 * caught here), `exports` no longer contains ConsentModule and this fails.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("ApplicationsModule wiring (cross-module guard DI regression guard)", () => {
  it("imports AuthModule (source of WorkerAuthGuard + ConsentGuard)", () => {
    expect(getMeta("imports", ApplicationsModule)).toContain(AuthModule);
  });

  it("declares the controller + service + repository", () => {
    expect(getMeta("controllers", ApplicationsModule)).toContain(ApplicationsController);
    const providers = getMeta("providers", ApplicationsModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("ApplicationsService");
    expect(providers).toContain("ApplicationsRepository");
  });

  it("AuthModule exports BOTH guards and re-exports ConsentModule (not the provider directly)", () => {
    const exports = getMeta("exports", AuthModule);
    expect(exports).toContain(WorkerAuthGuard);
    expect(exports).toContain(ConsentGuard);
    // The corrected wiring: re-export the MODULE that owns ConsentRepository, so
    // Nest propagates ConsentRepository to importers of AuthModule. Exporting the
    // raw ConsentRepository here is the bug ("cannot export a provider not part of
    // this module") — this assertion fails if that regresses.
    expect(exports).toContain(ConsentModule);
    expect(exports).not.toContain(ConsentRepository);
  });

  it("ConsentModule exports ConsentRepository (the dependency ConsentGuard injects)", () => {
    expect(getMeta("exports", ConsentModule)).toContain(ConsentRepository);
  });

  it("worker routes are guarded by [WorkerAuthGuard, ConsentGuard] IN THAT ORDER", () => {
    const ctrl = ApplicationsController.prototype;
    // @UseGuards stores guard classes under '__guards__' on the route handler.
    for (const handler of ["feed", "apply", "skip"] as const) {
      const guards = getMeta("__guards__", ctrl[handler]);
      expect(guards, `${handler} guards`).toEqual([WorkerAuthGuard, ConsentGuard]);
    }
  });

  it("ops routes are guarded by InternalServiceGuard only (PII-free projections)", () => {
    const ctrl = ApplicationsController.prototype;
    for (const handler of ["applicants", "workerApplications"] as const) {
      const guards = getMeta("__guards__", ctrl[handler]);
      expect(guards, `${handler} guards`).toEqual([InternalServiceGuard]);
    }
  });
});
