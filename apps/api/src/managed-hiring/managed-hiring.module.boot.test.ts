/**
 * #2751 — ManagedHiringModule wiring. The unit suites build the controller and the service by hand,
 * so a provider missing from the module only shows when the real api boots (the E2E job caught
 * `RequestIdempotency` absent: Nest could not resolve the company controller's second argument).
 * This pins every constructor dependency the module's own classes need to a provider or an import.
 */
import "reflect-metadata";
import { getQueueToken } from "@nestjs/bullmq";
import { describe, expect, it } from "vitest";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { ConsentModule } from "../consent/consent.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { PricingModule } from "../pricing/pricing.module";
import { MANAGED_HIRING_SWEEP_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { ManagedHiringMailer } from "./managed-hiring.mailer";
import { ManagedHiringModule } from "./managed-hiring.module";
import { ManagedHiringRepository } from "./managed-hiring.repository";
import { ManagedHiringService } from "./managed-hiring.service";
import { ManagedHiringSweepProcessor } from "./managed-hiring-sweep.processor";
import { PayerManagedHiringController } from "./payer-managed-hiring.controller";

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

/** The provider tokens the module's dynamic imports (BullModule.registerQueue) contribute. */
function dynamicProviderTokens(): unknown[] {
  return getMeta("imports", ManagedHiringModule).flatMap((m) => {
    const providers = (m as { providers?: unknown[] }).providers ?? [];
    return providers.map((p) =>
      typeof p === "object" && p !== null && "provide" in p ? (p as { provide: unknown }).provide : p,
    );
  });
}

describe("ManagedHiringModule wiring", () => {
  it("mounts the company controller; the desk routes stay AdminModule's", () => {
    expect(getMeta("controllers", ManagedHiringModule)).toEqual([PayerManagedHiringController]);
  });

  it("provides the controller's idempotency seam and the module's own classes", () => {
    expect(getMeta("providers", ManagedHiringModule)).toEqual(
      expect.arrayContaining([
        ManagedHiringRepository,
        ManagedHiringService,
        ManagedHiringMailer,
        ManagedHiringSweepProcessor,
        RequestIdempotency,
      ]),
    );
  });

  it("registers the sweep queue, and the Redis client RequestIdempotency injects", () => {
    const tokens = dynamicProviderTokens();
    expect(tokens).toContain(getQueueToken(MANAGED_HIRING_SWEEP_QUEUE));
    expect(tokens).toContain(getQueueToken(RESUME_RENDER_QUEUE));
  });

  it("imports the modules its service reads from", () => {
    expect(getMeta("imports", ManagedHiringModule)).toEqual(
      expect.arrayContaining([
        UnlocksModule,
        PricingModule,
        PayersModule,
        FeatureRolloutModule,
        ConsentModule,
      ]),
    );
  });

  it("exports the service for the admin desk", () => {
    expect(getMeta("exports", ManagedHiringModule)).toContain(ManagedHiringService);
  });
});
