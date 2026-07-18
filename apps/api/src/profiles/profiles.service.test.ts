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
const SESSION = "44444444-4444-4444-8444-444444444444";
const SESSION_B = "55555555-5555-4555-8555-555555555555";

type FakeAiJob = { id: string; status: string };

function setup() {
  const profiles = {
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    confirm: vi.fn(async () => undefined),
  };
  const aiJobs = {
    create: vi.fn(async (_input: { inputRef?: Record<string, unknown> }) => ({
      id: "job-1",
    })),
    markFailed: vi.fn(async () => undefined),
    findActiveExtractionForSession: vi.fn(async (_sessionId: string) => undefined as
      | FakeAiJob
      | undefined),
  };
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

/**
 * Issue #420 — session-scoped idempotency. The server auto-trigger (ChatService,
 * on the extraction_ready flip) and the worker app's unconditional
 * POST /profile/extract both fire for the same interview; without a guard that is
 * 2 ai_jobs + 2x AI spend on every normal completion.
 */
describe("ProfilesService.extract — session-scoped idempotency (#420)", () => {
  /** setup() plus a stateful ai_jobs store mirroring the repository predicate. */
  function setupWithStore() {
    const h = setup();
    h.workers.findById.mockResolvedValue({ id: WORKER });

    const store: Array<{ id: string; status: string; sessionId: string | null }> = [];
    let seq = 0;
    h.aiJobs.create.mockImplementation(async (input) => {
      const sessionId = (input.inputRef?.["session_id"] as string | null) ?? null;
      const row = { id: `job-${++seq}`, status: "queued", sessionId };
      store.push(row);
      return { id: row.id };
    });
    // Mirrors findActiveExtractionForSession: profile_extraction jobs for this
    // session in queued/running/completed (NOT failed), newest first.
    h.aiJobs.findActiveExtractionForSession.mockImplementation(async (sessionId: string) => {
      const matches = store.filter(
        (r) => r.sessionId === sessionId && r.status !== "failed",
      );
      return matches[matches.length - 1];
    });
    return { ...h, store };
  }

  const requestedEvents = (events: ReturnType<typeof setup>["events"]) =>
    events.emit.mock.calls.filter((c) => c[0].event_name === "profile.extraction_requested");

  it("returns the SAME ai_job_id for a second extract while a job is queued — no second job, no enqueue, no second requested event", async () => {
    const { svc, aiJobs, events, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findActiveExtractionForSession.mockResolvedValueOnce({
      id: "job-existing",
      status: "queued",
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res).toEqual({ ai_job_id: "job-existing", status: "queued" });
    expect(aiJobs.create).not.toHaveBeenCalled();
    expect(extractionQueue.add).not.toHaveBeenCalled();
    expect(requestedEvents(events)).toHaveLength(0);
  });

  it("dedupes against a RUNNING job too (in-flight, not just freshly queued)", async () => {
    const { svc, aiJobs, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findActiveExtractionForSession.mockResolvedValueOnce({
      id: "job-running",
      status: "running",
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res).toEqual({ ai_job_id: "job-running", status: "running" });
    expect(extractionQueue.add).not.toHaveBeenCalled();
  });

  it("dedupes against an already COMPLETED job (never re-spends on a finished session)", async () => {
    const { svc, aiJobs, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findActiveExtractionForSession.mockResolvedValueOnce({
      id: "job-done",
      status: "completed",
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res).toEqual({ ai_job_id: "job-done", status: "completed" });
    expect(aiJobs.create).not.toHaveBeenCalled();
    expect(extractionQueue.add).not.toHaveBeenCalled();
  });

  it("the real #420 scenario: server auto-trigger THEN the client's POST /profile/extract yields exactly ONE ai_job and ONE enqueue", async () => {
    const { svc, aiJobs, events, extractionQueue } = setupWithStore();

    // 1. ChatService.autoTriggerExtraction on the extraction_ready flip.
    const auto = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    // 2. Worker taps "Done"; ProfileCubit.extract() fires unconditionally.
    const client = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(client.ai_job_id).toBe(auto.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
    expect(requestedEvents(events)).toHaveLength(1);
  });

  it("does NOT over-dedupe: a different session still creates its own job", async () => {
    const { svc, aiJobs, events, extractionQueue } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION_B }, CTX);

    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(requestedEvents(events)).toHaveLength(2);
  });

  it("null session_id falls through to create-always and is never looked up (no null-against-null dedupe)", async () => {
    const { svc, aiJobs, extractionQueue } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);
    const second = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(aiJobs.findActiveExtractionForSession).not.toHaveBeenCalled();
    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
  });

  it("a FAILED prior job does not wedge the session — a retry still creates and enqueues", async () => {
    const { svc, aiJobs, events, extractionQueue, store } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    store[0]!.status = "failed"; // extraction failed (processor or enqueue)

    const retry = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(retry.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(requestedEvents(events)).toHaveLength(2);
  });

  it("still 404s an unknown worker before consulting the dedupe lookup", async () => {
    const { svc, aiJobs } = setup();
    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(aiJobs.findActiveExtractionForSession).not.toHaveBeenCalled();
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
