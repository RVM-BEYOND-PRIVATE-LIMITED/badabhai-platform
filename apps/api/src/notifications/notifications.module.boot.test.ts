import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { WorkersModule } from "../workers/workers.module";
import { EventsModule } from "../events/events.module";
import { NotificationsModule } from "./notifications.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationPrefsController } from "./notification-prefs.controller";
import { NotificationStateService } from "./notification-state.service";

/**
 * DI WIRING REGRESSION GUARD (#643) — NotificationsModule gained a second controller and a
 * service that reaches ACROSS module boundaries: NotificationStateService's ctor takes
 * WorkersRepository (owned by WorkersModule) and EventsService (owned by EventsModule).
 *
 * WHY THIS FILE EXISTS: exactly the failure push.module.boot.test.ts documents. A provider is
 * PRIVATE to its module unless exported or @Global, so a cross-module ctor param can resolve
 * to null and kill the API at STARTUP — while every unit suite stays green, because they
 * construct the service directly with fakes and never read @Module metadata. Here the two
 * dependencies resolve because both owning modules are @Global; this asserts that fact rather
 * than assuming it, so demoting either module fails at unit speed instead of in the E2E job.
 *
 * Follows the repo's boot-test convention (push/devices/unlocks/admin/...): assert the eager
 * @Module METADATA rather than building the container — the repo's vitest setup does not emit
 * design:paramtypes, so a real Test.createTestingModule cannot resolve class tokens.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

const isGlobal = (target: unknown): boolean =>
  Reflect.getMetadata("__module:global__", target as object) === true;

describe("Notifications wiring (#643 DI regression guard)", () => {
  it("registers BOTH controllers — the feed and the prefs toggle", () => {
    const controllers = getMeta("controllers", NotificationsModule);
    expect(controllers).toContain(NotificationsController);
    // Dropping this line would 404 the two prefs routes while every unit test still passed.
    expect(controllers).toContain(NotificationPrefsController);
  });

  it("provides NotificationStateService — the owner of both new columns", () => {
    const providers = getMeta("providers", NotificationsModule).map((p) =>
      typeof p === "function" ? p.name : (p as { provide?: symbol | string }).provide,
    );
    expect(providers).toContain("NotificationStateService");
    expect(providers).toContain("NotificationsService");
    expect(providers).toContain("NotificationsRepository");
  });

  it("imports AuthModule — the owner of WorkerAuthGuard + ConsentGuard", () => {
    // Both new controllers are @UseGuards(WorkerAuthGuard, ConsentGuard).
    expect(getMeta("imports", NotificationsModule)).toContain(AuthModule);
  });

  it("its cross-module deps resolve because WorkersModule and EventsModule are @Global", () => {
    // NotificationStateService injects WorkersRepository + EventsService without importing
    // either module. That is only legal while both are @Global — demoting one would fail
    // the API at BOOT, so pin the property the wiring silently depends on.
    expect(isGlobal(WorkersModule), "WorkersModule must stay @Global").toBe(true);
    expect(isGlobal(EventsModule), "EventsModule must stay @Global").toBe(true);
  });

  it("NotificationStateService is a real injectable class, not a stray export", () => {
    expect(typeof NotificationStateService).toBe("function");
    expect(NotificationStateService.name).toBe("NotificationStateService");
  });
});
