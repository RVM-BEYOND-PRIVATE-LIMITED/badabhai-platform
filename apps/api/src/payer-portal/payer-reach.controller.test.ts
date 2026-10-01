import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerReachController } from "./payer-reach.controller";

const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function makeCtrl() {
  const list = { jobId: JOB, applicants: [] };
  const applicantsService = { listForOwned: vi.fn(async () => list) };
  const rateLimit = { assertWithinHourlyCap: vi.fn(async () => undefined) };
  const config = { PAYER_REACH_MAX_PER_HOUR: 60 } as unknown as ServerConfig;
  const ctrl = new PayerReachController(applicantsService as never, rateLimit as never, config);
  return { ctrl, applicantsService, rateLimit, list };
}

/**
 * XB-A at the payer-reach boundary: the candidate list is bound to the SESSION payer
 * (`req.payer.id`); the route carries only the :jobId, never a payer_id. The source selection
 * and the no-oracle ownership (a job or posting a payer does not own → identical neutral 404)
 * are proven in payer-applicants.service.test.ts; this file pins that the controller is
 * HTTP-only — cap first, then one delegation, nothing else.
 */
describe("PayerReachController — identity from the session, rate-limited (ADR-0019 R22)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("delegates the :jobId with the SESSION payer (never a body/route payer_id)", async () => {
    await d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX);
    expect(d.applicantsService.listForOwned).toHaveBeenCalledWith(JOB, PAYER_A.id, CTX);
  });

  it("returns the service's list verbatim (no reshaping in the controller)", async () => {
    await expect(d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX)).resolves.toBe(d.list);
  });

  it("enforces the per-payer reach cap on the payer_reach bucket BEFORE the read", async () => {
    await d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX);
    expect(d.rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(PAYER_A.id, {
      scope: "payer_reach",
      cap: 60,
    });
    expect(d.rateLimit.assertWithinHourlyCap.mock.invocationCallOrder[0]!).toBeLessThan(
      d.applicantsService.listForOwned.mock.invocationCallOrder[0]!,
    );
  });

  it("a tripped reach cap blocks the read (listForOwned never runs)", async () => {
    d.rateLimit.assertWithinHourlyCap.mockRejectedValueOnce(new Error("429"));
    await expect(d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX)).rejects.toThrow();
    expect(d.applicantsService.listForOwned).not.toHaveBeenCalled();
  });

  it("passes the neutral 404 through untouched", async () => {
    d.applicantsService.listForOwned.mockRejectedValueOnce(new NotFoundException("Job not found"));
    await expect(d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("never converts a server error into a 404 (fail closed)", async () => {
    d.applicantsService.listForOwned.mockRejectedValueOnce(new InternalServerErrorException());
    await expect(d.ctrl.applicants({ jobId: JOB }, PAYER_A, CTX)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it("takes no data-access dependency: service + cap + config only (CLAUDE.md §4)", () => {
    // The flag branch and the ownership reads used to live here. A fourth constructor
    // parameter means one of them came back.
    expect(PayerReachController.length).toBe(3);
  });
});
