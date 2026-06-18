import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ProfilesService } from "./profiles.service";
import type { ProfilesRepository } from "./profiles.repository";
import type { AiJobsRepository } from "./ai-jobs.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { ProfileExtractionJobData, ResumeGenerateJobData } from "../queue/queue.constants";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const PROFILE = "33333333-3333-4333-8333-333333333333";

function setup() {
  const profiles = {
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    confirm: vi.fn(async () => undefined),
  };
  const aiJobs = { create: vi.fn(async () => ({ id: "job-1" })), markFailed: vi.fn(async () => undefined) };
  const workers = { findById: vi.fn(async () => undefined as Record<string, unknown> | undefined) };
  const events = { emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p) };
  const extractionQueue = { add: vi.fn(async () => undefined) };
  const resumeGenerateQueue = { add: vi.fn(async () => undefined) };
  const svc = new ProfilesService(
    profiles as unknown as ProfilesRepository,
    aiJobs as unknown as AiJobsRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    extractionQueue as unknown as Queue<ProfileExtractionJobData>,
    resumeGenerateQueue as unknown as Queue<ResumeGenerateJobData>,
  );
  return { svc, profiles, aiJobs, workers, events, extractionQueue, resumeGenerateQueue };
}

describe("ProfilesService.extract", () => {
  it("404s when the worker does not exist (nothing enqueued)", async () => {
    const { svc, aiJobs } = setup();
    await expect(svc.extract({ worker_id: WORKER, session_id: null }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(aiJobs.create).not.toHaveBeenCalled();
  });

  it("enqueues + emits extraction_requested for a known worker", async () => {
    const { svc, workers, events, extractionQueue } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    const res = await svc.extract({ worker_id: WORKER, session_id: "sess" }, CTX);
    expect(res).toEqual({ ai_job_id: "job-1", status: "queued" });
    expect(extractionQueue.add).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.extraction_requested");
  });

  it("on enqueue failure marks the job failed, emits failed, throws 503", async () => {
    const { svc, workers, aiJobs, events, extractionQueue } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    extractionQueue.add.mockRejectedValueOnce(new Error("redis down"));
    await expect(svc.extract({ worker_id: WORKER, session_id: null }, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls.map((c) => c[0].event_name)).toContain("profile.extraction_failed");
  });
});

describe("ProfilesService.confirm — ownership (IDOR) + event", () => {
  it("404s when the profile does not exist", async () => {
    const { svc } = setup();
    await expect(
      svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s when the profile belongs to ANOTHER worker (no oracle), confirming nothing", async () => {
    const { svc, profiles, events } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: OTHER });
    await expect(
      svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(profiles.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("confirms the OWNER's profile, emits profile.confirmed, enqueues resume generation", async () => {
    const { svc, profiles, events, resumeGenerateQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    const res = await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(res.profile_status).toBe("confirmed");
    expect(profiles.confirm).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.confirmed");
    expect(resumeGenerateQueue.add).toHaveBeenCalledOnce();
  });

  it("a resume-enqueue failure does NOT fail confirmation (degrades)", async () => {
    const { svc, profiles, resumeGenerateQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    resumeGenerateQueue.add.mockRejectedValueOnce(new Error("redis down"));
    const res = await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(res.profile_status).toBe("confirmed"); // confirmation still succeeds
  });
});
