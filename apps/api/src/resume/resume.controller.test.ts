import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ResumeController } from "./resume.controller";
import type { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  workerId: "22222222-2222-2222-2222-222222222222",
  profileId: "33333333-3333-3333-3333-333333333333",
  resumeJson: { summary: "CNC/VMC operator", skills: ["vmc_operator"] },
  resumeText: "Experienced CNC/VMC operator with 5 years on Fanuc controls.",
  generatedAt: new Date("2026-06-11T00:00:00.000Z"),
  version: 2,
};

/** The read endpoint only touches the repository; the service is irrelevant here. */
function makeController(findById: () => Promise<typeof ROW | undefined>): ResumeController {
  const repo = { findById } as unknown as ResumeRepository;
  return new ResumeController({} as unknown as ResumeService, repo);
}

describe("ResumeController.get (ops read view)", () => {
  it("returns the resume by id, shaped snake_case and PII-free", async () => {
    const controller = makeController(async () => ROW);
    const res = await controller.get(ROW.id);

    expect(res).toEqual({
      resume_id: ROW.id,
      worker_id: ROW.workerId,
      profile_id: ROW.profileId,
      version: 2,
      resume_text: ROW.resumeText,
      resume_json: ROW.resumeJson,
      generated_at: ROW.generatedAt,
    });

    // No worker PII (phone / full name) ever rides this payload.
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("throws NotFoundException when the resume does not exist", async () => {
    const controller = makeController(async () => undefined);
    await expect(
      controller.get("44444444-4444-4444-4444-444444444444"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
