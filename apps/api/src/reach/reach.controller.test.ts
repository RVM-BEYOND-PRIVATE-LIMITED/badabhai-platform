import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ReachController } from "./reach.controller";
import type { ReachService } from "./reach.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const JOB = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

function make() {
  const reach = {
    applicantsForJob: vi.fn(async () => ({ applicants: [] })),
    feedForWorker: vi.fn(async () => ({ jobs: [] })),
  };
  return { controller: new ReachController(reach as unknown as ReachService), reach };
}

describe("ReachController (thin) — delegation", () => {
  it("applicants delegates the validated jobId param + ctx", async () => {
    const { controller, reach } = make();
    await controller.applicants({ jobId: JOB }, CTX);
    expect(reach.applicantsForJob).toHaveBeenCalledWith(JOB, CTX);
  });

  it("feed delegates the validated workerId param + ctx", async () => {
    const { controller, reach } = make();
    await controller.feed({ workerId: WORKER }, CTX);
    expect(reach.feedForWorker).toHaveBeenCalledWith(WORKER, CTX);
  });
});
