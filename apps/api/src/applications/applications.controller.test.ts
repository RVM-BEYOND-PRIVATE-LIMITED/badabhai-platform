import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ApplicationsController } from "./applications.controller";
import type { ApplicationsService } from "./applications.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
const JOB = "22222222-2222-4222-8222-222222222222";

function make() {
  const applications = {
    getFeed: vi.fn(async () => ({ jobs: [] })),
    apply: vi.fn(async () => ({ status: "applied" })),
    skip: vi.fn(async () => ({ status: "skipped" })),
    applicantsForJob: vi.fn(async () => ({ applicants: [] })),
    applicationsForWorker: vi.fn(async () => ({ applications: [] })),
  };
  return {
    controller: new ApplicationsController(applications as unknown as ApplicationsService),
    applications,
  };
}

describe("ApplicationsController (thin) — worker from token", () => {
  it("feed uses the authed worker id + clamped limit", async () => {
    const { controller, applications } = make();
    await controller.feed(WORKER, { limit: 20 } as never, CTX);
    expect(applications.getFeed).toHaveBeenCalledWith(WORKER.id, 20, CTX);
  });

  it("apply passes the authed worker id (not the body) + jobId", async () => {
    const { controller, applications } = make();
    const dto = { rank: 1, source_surface: "feed" };
    await controller.apply(JOB, WORKER, dto as never, CTX);
    expect(applications.apply).toHaveBeenCalledWith(WORKER.id, JOB, dto, CTX);
  });

  it("skip passes the authed worker id + jobId", async () => {
    const { controller, applications } = make();
    const dto = { reason: "too_far" };
    await controller.skip(JOB, WORKER, dto as never, CTX);
    expect(applications.skip).toHaveBeenCalledWith(WORKER.id, JOB, dto, CTX);
  });

  it("ops applicants delegates by jobId", async () => {
    const { controller, applications } = make();
    await controller.applicants(JOB);
    expect(applications.applicantsForJob).toHaveBeenCalledWith(JOB);
  });

  it("ops workerApplications delegates by workerId", async () => {
    const { controller, applications } = make();
    await controller.workerApplications(WORKER.id);
    expect(applications.applicationsForWorker).toHaveBeenCalledWith(WORKER.id);
  });
});
