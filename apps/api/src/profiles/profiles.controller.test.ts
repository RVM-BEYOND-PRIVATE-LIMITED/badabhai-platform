import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ProfilesController } from "./profiles.controller";
import type { ProfilesService } from "./profiles.service";
import type { AiJobsRepository } from "./ai-jobs.repository";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid" };
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function make(aiJob?: unknown) {
  const profiles = {
    extract: vi.fn(async () => ({ ai_job_id: "j", status: "queued" })),
    confirm: vi.fn(async () => ({ profile_id: "p", profile_status: "confirmed" })),
  };
  const aiJobs = { findById: vi.fn(async () => aiJob) };
  return {
    controller: new ProfilesController(
      profiles as unknown as ProfilesService,
      aiJobs as unknown as AiJobsRepository,
    ),
    profiles,
    aiJobs,
  };
}

describe("ProfilesController (thin) — worker from token, never the body", () => {
  it("extract builds the service input from the authed worker + body session_id", async () => {
    const { controller, profiles } = make();
    await controller.extract(WORKER, { session_id: "sess" } as never, CTX);
    expect(profiles.extract).toHaveBeenCalledWith(
      { worker_id: WORKER.id, session_id: "sess" },
      CTX,
    );
  });

  it("extract passes session_id null when omitted", async () => {
    const { controller, profiles } = make();
    await controller.extract(WORKER, {} as never, CTX);
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER.id, session_id: null }, CTX);
  });

  it("confirm builds the service input from the authed worker + body profile_id", async () => {
    const { controller, profiles } = make();
    await controller.confirm(WORKER, { profile_id: "p1" } as never, CTX);
    expect(profiles.confirm).toHaveBeenCalledWith({ worker_id: WORKER.id, profile_id: "p1" }, CTX);
  });
});

describe("ProfilesController.ownAiJob — owner-scoped poll (no cross-worker read)", () => {
  const ownedJob = {
    id: JOB_ID,
    jobType: "profile_extraction",
    status: "completed",
    inputRef: { worker_id: WORKER.id },
    outputRef: { profile_id: "p1" },
    errorMessage: null,
    modelName: null,
    realCall: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costInr: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("returns the job when the ai_job's input_ref.worker_id matches the bearer", async () => {
    const { controller } = make(ownedJob);
    const res = await controller.ownAiJob(WORKER, JOB_ID);
    expect(res.id).toBe(JOB_ID);
    expect(res.output_ref).toEqual({ profile_id: "p1" });
  });

  it("404s a job owned by ANOTHER worker — not a distinguishable 403 (no oracle)", async () => {
    const { controller } = make({ ...ownedJob, inputRef: { worker_id: "someone-else" } });
    await expect(controller.ownAiJob(WORKER, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s an unknown job id the same way", async () => {
    const { controller } = make(undefined);
    await expect(controller.ownAiJob(WORKER, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
