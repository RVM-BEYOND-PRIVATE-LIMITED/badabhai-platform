import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AiJobsController } from "./ai-jobs.controller";
import type { AiJobsRepository } from "./ai-jobs.repository";

const ID = "11111111-1111-4111-8111-111111111111";
const JOB = {
  id: ID,
  jobType: "profile_extraction",
  status: "completed",
  modelName: "gemini-2.5-flash",
  realCall: false,
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  costInr: "0.01",
  outputRef: { profile_id: "p1" },
  errorMessage: null,
  createdAt: new Date("2026-06-11T00:00:00Z"),
  updatedAt: new Date("2026-06-11T00:01:00Z"),
  // A field that must NOT be surfaced (would-be PII if any existed on the row):
  inputRef: { worker_id: "w1" },
};

function make() {
  const aiJobs = {
    list: vi.fn(async () => [JOB]),
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  };
  return { controller: new AiJobsController(aiJobs as unknown as AiJobsRepository), aiJobs };
}

describe("AiJobsController (read) — projection, clamp, 404, no-PII", () => {
  it("list clamps the limit and surfaces cost/usage but not input_ref", async () => {
    const { controller, aiJobs } = make();
    const res = await controller.list("nan");
    expect(aiJobs.list).toHaveBeenCalledWith(100);
    const row = res.ai_jobs[0]!;
    expect(row).toMatchObject({ id: ID, job_type: "profile_extraction", cost_inr: "0.01" });
    expect(row).not.toHaveProperty("input_ref"); // worker ref not surfaced in list
    expect(JSON.stringify(row)).not.toMatch(/phone|full_?name/i);
  });

  it("get returns the usage projection (output_ref present, no PII)", async () => {
    const { controller, aiJobs } = make();
    aiJobs.findById.mockResolvedValueOnce(JOB);
    const res = await controller.get(ID);
    expect(res.output_ref).toEqual({ profile_id: "p1" });
    expect(res.ai_usage).toMatchObject({ model_name: "gemini-2.5-flash", total_tokens: 30 });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("get 404s when the job is unknown", async () => {
    const { controller } = make();
    await expect(controller.get(ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
