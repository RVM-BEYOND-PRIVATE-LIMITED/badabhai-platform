import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { FeedbackModule } from "./feedback.module";
import { WorkerFeedbackController } from "./worker-feedback.controller";
import { FeedbackService } from "./feedback.service";
import { FeedbackRepository } from "./feedback.repository";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { ConsentGuard } from "../auth/consent.guard";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";

/**
 * DI WIRING REGRESSION GUARD for the worker feedback sink (#997).
 *
 * WHY THIS FILE EXISTS, and it is not hypothetical — `WorkerActionsController` shipped with
 * `@UseGuards(WorkerAuthGuard, ConsentGuard)` and no `AuthModule` import, and every unit test
 * passed, because they construct the controller by hand and never ask Nest to resolve a guard.
 * The failure surfaced only at BOOT, in the E2E job, as:
 *
 *     WorkerAuthGuard { dependencies: [null, "SERVER_CONFIG", null] }
 *
 * A guard is resolved in the injector of the module that references it, so naming one in
 * `@UseGuards` obliges that module to import whatever provides it AND its own dependencies
 * (`SessionService`, `ConsentRepository`). These assertions move that class of mistake from a
 * two-minute E2E boot into the unit suite, where it can be seen while writing the code.
 *
 * METADATA, NOT A CONTAINER: the repo's vitest setup does not emit `design:paramtypes`, so a real
 * `Test.createTestingModule` cannot resolve constructor types here. Same approach as
 * `actions.module.boot.test.ts` and `devices.module.boot.test.ts`.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("FeedbackModule wiring (#997 DI regression guard)", () => {
  it("imports AuthModule — the guards' own dependencies resolve through it", () => {
    expect(getMeta("imports", FeedbackModule)).toContain(AuthModule);
  });

  it("imports StorageModule — the #1191 mint resolves StorageService through it", () => {
    // NOT a @Global module, so this import is the only thing that resolves
    // `FeedbackService`'s `StorageService` dependency. Its absence is a BOOT-TIME failure of
    // exactly the shape the AuthModule assertion above exists for, and equally invisible to
    // every unit test that constructs the service by hand.
    expect(getMeta("imports", FeedbackModule)).toContain(StorageModule);
  });

  it("declares the worker front door and both layers behind it", () => {
    expect(getMeta("controllers", FeedbackModule)).toContain(WorkerFeedbackController);
    const providers = getMeta("providers", FeedbackModule);
    expect(providers).toContain(FeedbackService);
    // The repository is module-local rather than global: it is the only writer of
    // `worker_feedback`, so a second consumer should have to declare itself in a diff.
    expect(providers).toContain(FeedbackRepository);
  });

  it("is worker-guarded then consent-gated, IN THAT ORDER", () => {
    // Order is the contract, not a style: `ConsentGuard` reads `req.worker`, which
    // `WorkerAuthGuard` attaches. Reversed, it fails closed on every request instead — and
    // storing a worker's free text is exactly the processing consent gates.
    expect(getMeta("__guards__", WorkerFeedbackController)).toEqual([
      WorkerAuthGuard,
      ConsentGuard,
    ]);
  });

  it("NEVER carries the ops guard — the reason it is its own controller at all", () => {
    // Nest unions class-level and method-level guards, so a feedback route hung off an
    // ops-guarded class would inherit `InternalServiceGuard`, be pulled into `OPS_ROUTES` by
    // `canary-coverage.test.ts`, and fail prod-canary stage 4.
    expect(getMeta("__guards__", WorkerFeedbackController)).not.toContain(InternalServiceGuard);
  });
});
