import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { OptionalWorkerAuthGuard } from "../auth/optional-worker-auth.guard";
import { SessionService } from "../auth/session.service";
import { InterviewKitController } from "./interview-kit.controller";
import { InterviewKitModule } from "./interview-kit.module";

/**
 * DI WIRING GUARD for the interview-kit module, added with the optional worker attribution.
 *
 * WHY IT EXISTS NOW. Putting `OptionalWorkerAuthGuard` on the download route added a module
 * EDGE: a guard's constructor dependencies resolve in the injector of the module that APPLIES
 * it, so `SessionService` has to be reachable from here. If it is not, the guard's dependency
 * resolves to null and the API fails to BOOT — while typecheck, lint, build and every unit
 * suite stay green, because none of them builds the container. That exact failure has already
 * cost this codebase an E2E run once.
 *
 * ASSERTED ON `@Module` METADATA, NOT BY BOOTING: this repo's vitest does not emit
 * `design:paramtypes`, so `Test.createTestingModule` would resolve constructor dependencies as
 * `undefined` and pass regardless of the wiring. The E2E boot job proves the graph resolves;
 * this file proves the declarations exist.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("InterviewKitModule wiring", () => {
  it("imports AuthModule, so OptionalWorkerAuthGuard's SessionService dependency resolves", () => {
    expect(getMeta("imports", InterviewKitModule)).toContain(AuthModule);
  });

  it("still imports StorageModule (kit upload / sign / exists)", () => {
    expect(getMeta("imports", InterviewKitModule)).toContain(StorageModule);
  });

  it("AuthModule exports BOTH the guard and the SessionService it depends on", () => {
    // Providing is not enough — a provider is private to its module unless exported, and the
    // guard is instantiated in THIS module's injector.
    const exported = getMeta("exports", AuthModule);
    expect(exported).toContain(OptionalWorkerAuthGuard);
    expect(exported).toContain(SessionService);
  });

  it("the download route carries the OPTIONAL guard — and only that one", () => {
    const guards = getMeta(
      "__guards__",
      (InterviewKitController.prototype as unknown as Record<string, object>).download,
    ) as Array<{ name?: string }>;
    const names = guards.map((g) => g.name ?? g.constructor?.name);
    expect(names).toContain(OptionalWorkerAuthGuard.name);
    // ⚠ `WorkerAuthGuard` here would turn a deliberately PUBLIC route into a 401 for every
    // worker who has not logged in — the kit is per-trade, PII-free content that exists to be
    // reachable before a worker commits to the app.
    expect(names).not.toContain("WorkerAuthGuard");
  });

  it("the CLASS carries no guard — the module's other routes stay untouched", () => {
    expect(getMeta("__guards__", InterviewKitController)).toHaveLength(0);
  });
});
