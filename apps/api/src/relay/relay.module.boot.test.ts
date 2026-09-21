import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PayersModule } from "../payers/payers.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { RelayModule } from "./relay.module";
import { PayerRelayController } from "./payer-relay.controller";
import { WorkerRelayController } from "./worker-relay.controller";
import { RelayRepository } from "./relay.repository";
import { RelayService } from "./relay.service";

/**
 * DI WIRING CONTRACT for the relay module (E0 item 3).
 *
 * WHY THIS IS NOT CEREMONY. A guard used cross-module needs ITS dependencies reachable in
 * the importing module's injector, and a provider dropped from `providers` does not fail
 * where it was dropped — it fails at BOOT, with a Nest resolution error, while typecheck,
 * lint and every unit test still pass (they all hand-build their collaborators). The live
 * boot is exercised by `nest build` and the opt-in e2e suite; this file is the static net.
 *
 * Asserted on the `@Module` METADATA rather than by constructing the container — the repo's
 * vitest setup does not emit `design:paramtypes`, so type-based DI cannot be instantiated
 * under the runner. Same call as `match.module.boot.test.ts`.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("RelayModule — the E0 relay's wiring", () => {
  it("imports AuthModule (worker guards), PayersModule (PayerAuthGuard) and UnlocksModule (the resolution ladder)", () => {
    const imports = getMeta("imports", RelayModule);
    expect(imports).toContain(AuthModule);
    expect(imports).toContain(PayersModule);
    expect(imports).toContain(UnlocksModule);
  });

  it("declares both controllers — the payer send surface and the worker read/reply surface", () => {
    expect(getMeta("controllers", RelayModule)).toEqual([
      PayerRelayController,
      WorkerRelayController,
    ]);
  });

  it("provides the service and its repository", () => {
    const providers = getMeta("providers", RelayModule);
    expect(providers).toContain(RelayService);
    expect(providers).toContain(RelayRepository);
  });

  it("exports NOTHING — the relay is consumed through its routes, not by other modules", () => {
    expect(getMeta("exports", RelayModule)).toEqual([]);
  });
});
