import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ResumeGenerateProcessor } from "./resume-generate.processor";
import type { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { ProfilesRepository } from "../profiles/profiles.repository";
import type { ResumeGenerateJobData } from "../queue/queue.constants";

const JOB: ResumeGenerateJobData = {
  workerId: "w-1",
  profileId: "p-1",
  correlationId: "c-1",
  requestId: "r-1",
};

function makeJob(attemptsMade = 0): Job<ResumeGenerateJobData> {
  return { data: JOB, attemptsMade } as unknown as Job<ResumeGenerateJobData>;
}

interface Setup {
  /** The worker's newest résumé, or undefined — the one-per-worker skip's read. */
  existingResume?: unknown;
  /** The profile row the job names. */
  profile?: { workerId: string; resumeUpdateAcceptedAt: Date | null } | undefined;
  /** This profile's newest résumé, or undefined — the accepted-update bypass's idempotency read. */
  profileResume?: unknown;
  /** The worker's latest consent row. Default: active, naming `resume_generation`. */
  consent?: { revokedAt: Date | null; purposes: string[] } | null;
}

function setup(over: Setup = {}) {
  const resumeService = { generate: vi.fn(async () => ({ resume_id: "res-1" })) };
  const workers = { latestResume: vi.fn(async () => over.existingResume) };
  const profiles = {
    findById: vi.fn(async () =>
      "profile" in over ? over.profile : { workerId: "w-1", resumeUpdateAcceptedAt: null },
    ),
  };
  const resumes = { newestForProfile: vi.fn(async () => over.profileResume) };
  const consents = {
    findLatestByWorker: vi.fn(async () =>
      "consent" in over
        ? (over.consent ?? undefined)
        : { revokedAt: null, purposes: ["profiling", "resume_generation"] },
    ),
  };
  const proc = new ResumeGenerateProcessor(
    resumeService as unknown as ResumeService,
    workers as unknown as WorkersRepository,
    profiles as unknown as ProfilesRepository,
    resumes as unknown as ResumeRepository,
    consents as never,
  );
  return { proc, resumeService, workers, profiles, resumes };
}

const ACCEPTED = { workerId: "w-1", resumeUpdateAcceptedAt: new Date("2026-09-24T10:00:00Z") };

describe("ResumeGenerateProcessor (auto-generate after confirm)", () => {
  it("skips generation when the worker already has a resume", async () => {
    const { proc, resumeService } = setup({ existingResume: { id: "existing", version: 1 } });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
  });

  it("calls resumeService.generate with worker/profile + carried tracing ids when no resume exists", async () => {
    const { proc, resumeService } = setup();
    const res = await proc.process(makeJob());
    expect(res).toEqual({ skipped: false });
    expect(resumeService.generate).toHaveBeenCalledWith(
      { worker_id: "w-1", profile_id: "p-1" },
      { correlationId: "c-1", requestId: "r-1" },
      { systemInitiated: true },
    );
  });
});

describe("the accepted chat update (ADR-0043) — the ONE bypass of the one-per-worker skip", () => {
  it("generates for a worker who already has a résumé when THE PROFILE says they said Haan", async () => {
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
      profileResume: undefined,
    });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ skipped: false });
    expect(resumeService.generate).toHaveBeenCalledWith(
      { worker_id: "w-1", profile_id: "p-1" },
      { correlationId: "c-1", requestId: "r-1" },
      { systemInitiated: true, trigger: "chat_update_accepted", retry: false },
    );
  });

  it("marks a queue RETRY so the worker's daily cap is charged once per Haan, not per attempt", async () => {
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
    });
    await proc.process(makeJob(2));
    expect(resumeService.generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ retry: true }),
    );
  });

  it("is idempotent PER PROFILE under the bypass — the twin job from the other confirm does nothing", async () => {
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
      profileResume: { id: "already-made" },
    });
    expect(await proc.process(makeJob())).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
  });

  it("a DAILY-CAP REFUSAL is terminal — never retried, so attempt two cannot walk past the cap", async () => {
    // A retry is exempt from the per-worker cap (it was charged on attempt one). If a REFUSED first
    // attempt threw, BullMQ would retry it and attempt two would generate over the cap.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
    });
    resumeService.generate.mockRejectedValue(
      new HttpException("daily cap", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(proc.process(makeJob(0))).resolves.toEqual({ skipped: true });
  });

  it("any OTHER failure still throws, so the queue retries it", async () => {
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
    });
    resumeService.generate.mockRejectedValue(new Error("model timeout"));
    await expect(proc.process(makeJob(0))).rejects.toThrow("model timeout");
  });

  it("does NOT generate the accepted update when consent was withdrawn after the confirm", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: ACCEPTED,
      consent: { revokedAt: new Date(), purposes: ["resume_generation"] },
    });
    expect(await proc.process(makeJob())).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
  });

  it("KEEPS the skip for a returning worker who did NOT accept — 'Abhi nahi' then the preview's confirm", async () => {
    // This is the behaviour a per-profile rule would have broken: every re-confirm would mint a
    // paid résumé. The profile carries no acceptance, so the worker-level skip still decides.
    const { proc, resumeService, resumes } = setup({
      existingResume: { id: "older", version: 3 },
      profile: { workerId: "w-1", resumeUpdateAcceptedAt: null },
    });
    expect(await proc.process(makeJob())).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
    expect(resumes.newestForProfile).not.toHaveBeenCalled();
  });

  it("does not honour an acceptance on a profile that belongs to a DIFFERENT worker", async () => {
    // The job's ids are internal, but the bypass must still read as "this worker's profile says
    // so" — anything else falls back to the ordinary skip.
    const { proc, resumeService } = setup({
      existingResume: { id: "older", version: 3 },
      profile: { ...ACCEPTED, workerId: "w-2" },
    });
    expect(await proc.process(makeJob())).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
  });

  it("a missing profile falls back to the ordinary path", async () => {
    const { proc, resumeService } = setup({ profile: undefined });
    expect(await proc.process(makeJob())).toEqual({ skipped: false });
    expect(resumeService.generate).toHaveBeenCalledWith(
      { worker_id: "w-1", profile_id: "p-1" },
      { correlationId: "c-1", requestId: "r-1" },
      { systemInitiated: true },
    );
  });
});
