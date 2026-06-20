import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerReachController } from "./payer-reach.controller";

const PAYER_A: AuthenticatedPayer = { id: "aaaaaaaa-0000-4000-8000-000000000001", sid: "sid-a" };
const CTX: RequestContext = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function makeCtrl() {
  const reach = { applicantsForOwnedJob: vi.fn(async () => ({ jobId: JOB, applicants: [] })) };
  const rateLimit = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const config = { PAYER_REACH_MAX_PER_HOUR: 60 } as unknown as ServerConfig;
  const ctrl = new PayerReachController(reach as never, rateLimit as never, config);
  return { ctrl, reach, rateLimit };
}

/**
 * XB-A at the payer-reach boundary: the candidate list is bound to the SESSION payer
 * (`req.payer.id`); the route carries only the :jobId, never a payer_id. The chokepoint
 * no-oracle ownership (a job a payer does not own → identical neutral 404) is proven in
 * reach.service.test.ts (applicantsForOwnedJob).
 */
describe("PayerReachController — identity from the session, rate-limited (ADR-0019 R22)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("delegates the :jobId with the SESSION payer (never a body/route payer_id)", async () => {
    await d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX);
    expect(d.reach.applicantsForOwnedJob).toHaveBeenCalledWith(JOB, PAYER_A.id, CTX);
  });

  it("enforces the per-payer reach cap on the payer_reach bucket BEFORE the read", async () => {
    await d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX);
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id, {
      scope: "payer_reach",
      cap: 60,
    });
  });

  it("a tripped reach cap blocks the read (applicantsForOwnedJob never runs)", async () => {
    d.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(new Error("429"));
    await expect(d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX)).rejects.toThrow();
    expect(d.reach.applicantsForOwnedJob).not.toHaveBeenCalled();
  });
});
