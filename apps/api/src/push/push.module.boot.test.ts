import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { DevicesRepository } from "../auth/devices.repository";
import { PushModule } from "./push.module";
import { PushService } from "./push.service";

/**
 * DI WIRING REGRESSION GUARD (ADR-0034) — PushModule is a NEW module whose service reaches
 * ACROSS a module boundary: PushService's ctor takes DevicesRepository, which is owned by
 * AuthModule.
 *
 * WHY THIS FILE EXISTS: PushModule shipped without a boot test, and AuthModule provided
 * DevicesRepository without EXPORTING it. A provider is private to its module unless
 * exported, so PushService's 4th param resolved to null and the API failed to boot —
 * `UnknownDependenciesException{ type: PushService, index: 3 }`. Every unit suite stayed
 * green (they construct the service directly with fakes and never touch @Module metadata),
 * so only the E2E job caught it, and only by the API dying during startup. This asserts the
 * wiring itself, at unit speed.
 *
 * Follows the repo's boot-test convention (devices/unlocks/admin/...): assert the eager
 * @Module METADATA rather than building the container — the repo's vitest setup does not
 * emit design:paramtypes, so a real Test.createTestingModule cannot resolve class tokens.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("Push wiring (ADR-0034 DI regression guard)", () => {
  it("PushModule imports AuthModule — the owner of DevicesRepository", () => {
    expect(getMeta("imports", PushModule)).toContain(AuthModule);
  });

  it("AuthModule EXPORTS DevicesRepository, not merely provides it", () => {
    // The regression. Providing without exporting keeps it private to AuthModule, and
    // PushService's cross-module injection then resolves to null at boot.
    const providers = getMeta("providers", AuthModule).map((p) =>
      typeof p === "function" ? p.name : p,
    );
    expect(providers, "AuthModule must still own DevicesRepository").toContain(
      "DevicesRepository",
    );
    expect(
      getMeta("exports", AuthModule),
      "AuthModule must EXPORT DevicesRepository or PushService cannot boot",
    ).toContain(DevicesRepository);
  });

  it("PushModule provides the service graph and exports PushService", () => {
    const providers = getMeta("providers", PushModule).map((p) =>
      typeof p === "function" ? p.name : (p as { provide?: symbol | string }).provide,
    );
    expect(providers).toContain("PushService");
    expect(providers).toContain("PushRepository");
    expect(providers).toContain("PushProcessor");
    expect(getMeta("exports", PushModule)).toContain(PushService);
  });
});
