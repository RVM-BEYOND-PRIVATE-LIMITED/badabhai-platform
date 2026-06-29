import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AuthModule } from "./auth.module";
import { DevicesController } from "./devices.controller";
import { WorkerAuthGuard } from "./worker-auth.guard";

/**
 * DI WIRING REGRESSION GUARD (ADR-0026 Phase 2) — the trusted-device routes are a NEW
 * controller + service graph added to AuthModule. DevicesService composes EventsService /
 * PiiCryptoService / SessionService and DevicesRepository reaches the @Global DATABASE
 * token; AuthService now also depends on DevicesService. We assert the eager @Module /
 * @UseGuards METADATA (the repo's vitest setup does not emit design:paramtypes, so we do
 * not build the container) — mirrors unlocks.module.boot.test.ts.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("Auth device wiring (ADR-0026 Phase 2 DI regression guard)", () => {
  it("AuthModule declares the DevicesController", () => {
    expect(getMeta("controllers", AuthModule)).toContain(DevicesController);
  });

  it("AuthModule provides DevicesService + DevicesRepository (the device service graph)", () => {
    const providers = getMeta("providers", AuthModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("DevicesService");
    expect(providers).toContain("DevicesRepository");
  });

  it("EVERY device route is worker-guarded (class-level WorkerAuthGuard — scopes to the token's worker)", () => {
    const classGuards = getMeta("__guards__", DevicesController);
    expect(classGuards).toContain(WorkerAuthGuard);
  });
});
