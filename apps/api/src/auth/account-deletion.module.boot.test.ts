import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AuthModule } from "./auth.module";
import { AuthController } from "./auth.controller";
import { AccountDeletionService } from "./account-deletion.service";
import { AccountDeletionSweepProcessor } from "./account-deletion-sweep.processor";
import { StorageModule } from "../storage/storage.module";
import { WorkerAuthGuard } from "./worker-auth.guard";

/**
 * DI WIRING REGRESSION GUARD (ADR-0026 Phase 5) — AccountDeletionService is a NEW provider
 * added to AuthModule, composing SessionService + StorageService + WorkersRepository (@Global)
 * + EventsService (@Global) + PiiCryptoService (@Global). The two account-deletion routes are
 * added to the existing AuthController. We assert the eager @Module / @UseGuards METADATA (the
 * repo's vitest setup does not emit design:paramtypes, so we do not build the container) —
 * mirrors devices.module.boot.test.ts.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("Account-deletion wiring (ADR-0026 Phase 5 DI regression guard)", () => {
  it("AuthModule imports StorageModule (StorageService backs the erasure)", () => {
    expect(getMeta("imports", AuthModule)).toContain(StorageModule);
  });

  it("AuthModule provides AccountDeletionService", () => {
    const providers = getMeta("providers", AuthModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("AccountDeletionService");
    expect(getMeta("providers", AuthModule)).toContain(AccountDeletionService);
  });

  it("all three account-deletion routes are worker-guarded (step-up gate runs on an authed worker)", () => {
    const proto = AuthController.prototype as unknown as Record<string, unknown>;
    const requestGuards = getMeta("__guards__", proto["accountDeleteRequest"]);
    const confirmGuards = getMeta("__guards__", proto["accountDeleteConfirm"]);
    const cancelGuards = getMeta("__guards__", proto["accountDeleteCancel"]);
    expect(requestGuards).toContain(WorkerAuthGuard);
    expect(confirmGuards).toContain(WorkerAuthGuard);
    expect(cancelGuards).toContain(WorkerAuthGuard);
  });

  // ---- ADR-0031 — grace-window wiring ----

  it("cancel is worker-guarded ONLY — deliberately NO ConsentGuard (a consent-revoked worker must still manage deletion)", () => {
    const proto = AuthController.prototype as unknown as Record<string, unknown>;
    const cancelGuards = getMeta("__guards__", proto["accountDeleteCancel"]);
    expect(cancelGuards).toEqual([WorkerAuthGuard]);
  });

  it("confirm + cancel respond 200 (confirm now returns {scheduled_for} — was 204 pre-ADR-0031)", () => {
    const proto = AuthController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata("__httpCode__", proto["accountDeleteConfirm"] as object)).toBe(200);
    expect(Reflect.getMetadata("__httpCode__", proto["accountDeleteCancel"] as object)).toBe(200);
  });

  it("AuthModule provides AccountDeletionSweepProcessor (the grace-elapse sweep)", () => {
    const providers = getMeta("providers", AuthModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers).toContain("AccountDeletionSweepProcessor");
    expect(getMeta("providers", AuthModule)).toContain(AccountDeletionSweepProcessor);
  });
});
