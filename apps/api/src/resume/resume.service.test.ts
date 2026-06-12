import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { ProfilesRepository } from "../profiles/profiles.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { AiService } from "../ai/ai.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import type { GenerateResumeDto } from "./resume.dto";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const DTO = { worker_id: "w-1", profile_id: "p-1" } as GenerateResumeDto;
const NAME = "Asha Kumari";

function setup(fullNameToken: string | null) {
  const profiles = {
    findById: vi.fn(async () => ({ id: "p-1", workerId: "w-1", rawProfile: {} })),
  };
  // The AI mock returns a NAME-LESS resume (as the real service does).
  const ai = {
    generateResume: vi.fn(async (_input: unknown) => ({
      resume_text: "PROFESSIONAL SUMMARY (draft)",
      resume_json: { profile: {} },
      format: "text",
      is_mock: true,
    })),
  };
  const workers = {
    findById: vi.fn(async () => ({ id: "w-1", fullName: fullNameToken })),
    latestResume: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn(() => NAME) };
  const resumes = { create: vi.fn(async (input: Record<string, unknown>) => ({ id: "res-1", ...input })) };
  const events = { emit: vi.fn(async () => true) };

  const svc = new ResumeService(
    resumes as unknown as ResumeRepository,
    profiles as unknown as ProfilesRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    ai as unknown as AiService,
    pii as unknown as PiiCryptoService,
  );
  return { svc, ai, pii, resumes };
}

describe("ResumeService — TD21 name injection", () => {
  it("injects the decrypted name into the resume but NEVER sends it to the AI service", async () => {
    const { svc, ai, pii, resumes } = setup("v1.ciphertext");
    await svc.generate(DTO, CTX);

    // The AI service only ever received the structured profile — no name anywhere.
    const aiArg = ai.generateResume.mock.calls[0]![0];
    expect(JSON.stringify(aiArg)).not.toMatch(/Asha/i);

    expect(pii.decrypt).toHaveBeenCalledWith("v1.ciphertext");
    const saved = resumes.create.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
    expect(saved.resumeText).toContain(NAME); // name lands on the worker's own resume
    expect(saved.resumeJson.name).toBe(NAME);
  });

  it("omits the name when none is set — no decrypt, resume unchanged", async () => {
    const { svc, pii, resumes } = setup(null);
    await svc.generate(DTO, CTX);

    expect(pii.decrypt).not.toHaveBeenCalled();
    const saved = resumes.create.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
    expect(saved.resumeText).toBe("PROFESSIONAL SUMMARY (draft)");
    expect(saved.resumeJson.name).toBeUndefined();
  });

  it("degrades to a name-less resume when full_name can't be decrypted (no 500)", async () => {
    // A malformed/rotated/tampered token must not break resume generation.
    const { svc, pii, resumes } = setup("v1.corrupt-token");
    pii.decrypt.mockImplementation(() => {
      throw new Error("GCM auth failed");
    });

    const out = await svc.generate(DTO, CTX); // must NOT throw
    expect(out.resume_id).toBeTruthy();
    const saved = resumes.create.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
    expect(saved.resumeText).toBe("PROFESSIONAL SUMMARY (draft)"); // name-less fallback
    expect(saved.resumeJson.name).toBeUndefined();
  });
});
