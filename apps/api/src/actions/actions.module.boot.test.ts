import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ActionsModule } from "./actions.module";
import { ActionsController } from "./actions.controller";
import { WorkerActionsController } from "./worker-actions.controller";
import { AuthModule } from "../auth/auth.module";
import { ConsentGuard } from "../auth/consent.guard";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";

/**
 * DI WIRING REGRESSION GUARD for the worker action sink (#694).
 *
 * WHY THIS FILE EXISTS, and it is not hypothetical. `WorkerActionsController` shipped with
 * `@UseGuards(WorkerAuthGuard, ConsentGuard)` and no `AuthModule` import, and every unit test
 * passed — because they construct the controller by hand and never ask Nest to resolve a guard.
 * The failure surfaced only at BOOT, in the E2E job, as:
 *
 *     WorkerAuthGuard { dependencies: [null, "SERVER_CONFIG", null] }
 *
 * A guard is resolved in the injector of the module that references it, so naming one in
 * `@UseGuards` obliges that module to import whatever provides it AND its own dependencies
 * (`SessionService`, `ConsentRepository`). These assertions move that class of mistake from a
 * two-minute E2E boot to the unit suite, which is where it can be seen while writing the code.
 *
 * METADATA, NOT A CONTAINER: the repo's vitest setup does not emit `design:paramtypes`, so a real
 * `Test.createTestingModule` cannot resolve constructor types here. Same approach as
 * `devices.module.boot.test.ts` and `profiling.module.boot.test.ts`.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("ActionsModule wiring (#694 DI regression guard)", () => {
  it("imports AuthModule — the guards' own dependencies resolve through it", () => {
    expect(getMeta("imports", ActionsModule)).toContain(AuthModule);
  });

  it("declares BOTH front doors", () => {
    const controllers = getMeta("controllers", ActionsModule);
    expect(controllers).toContain(ActionsController);
    expect(controllers).toContain(WorkerActionsController);
  });

  it("the worker controller is worker-guarded then consent-gated, IN THAT ORDER", () => {
    // Order is the contract, not a style: `ConsentGuard` reads `req.worker`, which
    // `WorkerAuthGuard` attaches. Reversed, it fails closed on every request instead.
    expect(getMeta("__guards__", WorkerActionsController)).toEqual([WorkerAuthGuard, ConsentGuard]);
  });

  it("the worker controller NEVER carries the ops guard", () => {
    // The reason it is a separate class at all: Nest unions class-level and method-level
    // guards, so a worker route on `ActionsController` would inherit `InternalServiceGuard`,
    // be pulled into `OPS_ROUTES` by `canary-coverage.test.ts`, and fail prod-canary stage 4.
    expect(getMeta("__guards__", WorkerActionsController)).not.toContain(InternalServiceGuard);
    // And the internal controller keeps it — this PR must not have relaxed the ops door.
    expect(getMeta("__guards__", ActionsController)).toContain(InternalServiceGuard);
  });
});
