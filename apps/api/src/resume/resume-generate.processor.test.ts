import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";
import { ResumeGenerateProcessor } from "./resume-generate.processor";
import type { ResumeService } from "./resume.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { ResumeGenerateJobData } from "../queue/queue.constants";

const JOB: ResumeGenerateJobData = {
  workerId: "w-1",
  profileId: "p-1",
  correlationId: "c-1",
  requestId: "r-1",
};

function makeJob(): Job<ResumeGenerateJobData> {
  return { data: JOB } as unknown as Job<ResumeGenerateJobData>;
}

function setup(existingResume: unknown) {
  const resumeService = { generate: vi.fn(async () => ({ resume_id: "res-1" })) };
  const workers = { latestResume: vi.fn(async () => existingResume) };
  const proc = new ResumeGenerateProcessor(
    resumeService as unknown as ResumeService,
    workers as unknown as WorkersRepository,
  );
  return { proc, resumeService, workers };
}

describe("ResumeGenerateProcessor (auto-generate after confirm)", () => {
  it("skips generation when the worker already has a resume", async () => {
    const { proc, resumeService } = setup({ id: "existing", version: 1 });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ skipped: true });
    expect(resumeService.generate).not.toHaveBeenCalled();
  });

  it("calls resumeService.generate with worker/profile + carried tracing ids when no resume exists", async () => {
    const { proc, resumeService } = setup(undefined);
    const res = await proc.process(makeJob());
    expect(res).toEqual({ skipped: false });
    expect(resumeService.generate).toHaveBeenCalledWith(
      { worker_id: "w-1", profile_id: "p-1" },
      { correlationId: "c-1", requestId: "r-1" },
      { systemInitiated: true },
    );
  });
});
