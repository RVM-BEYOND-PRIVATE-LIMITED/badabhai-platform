import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { getQueueToken } from "@nestjs/bullmq";
import { ACCOUNT_DELETION_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { HealthModule } from "./health.module";
import { HealthService } from "./health.service";

/**
 * DI WIRING REGRESSION GUARD (ADR-0031) — HealthService gained a THIRD constructor
 * dependency (the account-deletion queue, for the sweep-scheduler probe). That injection
 * only resolves if HealthModule registers the queue, and nothing else would catch a miss:
 * health.controller.test.ts constructs the service by hand, so a missing registration would
 * pass every unit test and then fail at BOOT — taking down the very endpoint that reports
 * the sweep. Asserts the eager @Module metadata (the repo's vitest setup does not emit
 * design:paramtypes, so we do not build the container) — mirrors
 * account-deletion.module.boot.test.ts.
 *
 * TD81 added a FOURTH dependency (`AiService`, for the ai-service reachability probe).
 * It needs no import here — AiModule is @Global — so the guard it needs is the opposite
 * one: that nobody "fixes" a future DI error by re-declaring AiService locally, which
 * would resolve cleanly and silently mint a SECOND client alongside the shared one.
 */

const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

/** Queue tokens provided by the BullModule.registerQueue dynamic modules HealthModule imports. */
function importedQueueTokens(): unknown[] {
  const imports = getMeta("imports", HealthModule) as Array<{
    providers?: Array<{ provide?: unknown }>;
  }>;
  return imports.flatMap((m) => (m.providers ?? []).map((p) => p.provide));
}

describe("HealthModule wiring (ADR-0031 sweep-readiness DI guard)", () => {
  it("registers the account-deletion queue (the sweep-scheduler probe's handle)", () => {
    expect(importedQueueTokens()).toContain(getQueueToken(ACCOUNT_DELETION_QUEUE));
  });

  it("still registers the resume-render queue (the pre-existing Redis PING handle)", () => {
    expect(importedQueueTokens()).toContain(getQueueToken(RESUME_RENDER_QUEUE));
  });

  it("does NOT re-provide AiService — the TD81 probe rides the @Global AiModule instance", () => {
    // A local provider would give HealthService its own AiService (own opening cache,
    // own config read) instead of the one chat/profiles/resume share. It would boot fine,
    // which is exactly why it needs pinning here rather than being left to review.
    expect(getMeta("providers", HealthModule)).toEqual([HealthService]);
  });
});
