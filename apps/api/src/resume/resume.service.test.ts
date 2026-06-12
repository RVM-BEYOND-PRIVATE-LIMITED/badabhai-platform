import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { ResumeRateLimit } from "./resume-rate-limit.service";
import type { ProfilesRepository } from "../profiles/profiles.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { AiService } from "../ai/ai.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { ResumeRenderJobData } from "../queue/queue.constants";
import type { RequestContext } from "../common/request-context";
import type { GenerateResumeDto } from "./resume.dto";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const DTO = { worker_id: "w-1", profile_id: "p-1" } as GenerateResumeDto;
const NAME = "Asha Kumari";

// Per-svc events handle, so a test can read the emit calls for that instance.
const EVENTS = new WeakMap<ResumeService, { emit: ReturnType<typeof vi.fn> }>();
function lastEvents(svc: ResumeService): { emit: ReturnType<typeof vi.fn> } {
  const e = EVENTS.get(svc);
  if (!e) throw new Error("no events handle for svc");
  return e;
}

function setup(
  fullNameToken: string | null,
  opts: { previousVersion?: number } = {},
) {
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
    latestResume: vi.fn(async () =>
      opts.previousVersion != null ? { id: "prev", version: opts.previousVersion } : undefined,
    ),
  };
  const pii = { decrypt: vi.fn(() => NAME) };
  const resumes = { create: vi.fn(async (input: Record<string, unknown>) => ({ id: "res-1", ...input })) };
  const events = {
    emit: vi.fn(
      async (params: { event_name: string; payload: Record<string, unknown> }) => params,
    ),
  };
  // Rate-cap is a pass-through here (its own behaviour is covered separately).
  const rateLimit = { assertWithinDailyCap: vi.fn(async (_workerId: string) => undefined) };
  // The render enqueue must never affect generation; record the call only.
  const renderQueue = {
    add: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
  };

  const svc = new ResumeService(
    resumes as unknown as ResumeRepository,
    profiles as unknown as ProfilesRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    ai as unknown as AiService,
    pii as unknown as PiiCryptoService,
    rateLimit as unknown as ResumeRateLimit,
    renderQueue as unknown as Queue<ResumeRenderJobData>,
  );
  EVENTS.set(svc, events);
  return { svc, ai, pii, resumes, rateLimit, renderQueue, events };
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

describe("ResumeService — TD5 rate-limit, events, and render enqueue", () => {
  it("asserts the daily cap FIRST — before any AI / profile / render work", async () => {
    const { svc, rateLimit } = setup(null);
    // Make the cap reject; nothing downstream should run.
    const order: string[] = [];
    rateLimit.assertWithinDailyCap.mockImplementation(async () => {
      order.push("ratelimit");
      throw new HttpException("cap", HttpStatus.TOO_MANY_REQUESTS);
    });

    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(order).toEqual(["ratelimit"]);
  });

  it("does not call the AI service when the rate-limit rejects", async () => {
    const { svc, ai, rateLimit } = setup(null);
    rateLimit.assertWithinDailyCap.mockRejectedValue(
      new HttpException("cap", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(svc.generate(DTO, CTX)).rejects.toBeInstanceOf(HttpException);
    expect(ai.generateResume).not.toHaveBeenCalled();
  });

  it("emits resume.generated on a first-ever resume (v1)", async () => {
    const { svc } = setup(null);
    const events = lastEvents(svc);
    await svc.generate(DTO, CTX);
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.generated");
    expect(call.payload.version).toBe(1);
    expect(call.payload).not.toHaveProperty("previous_version");
  });

  it("emits resume.regenerated with previous_version when version > 1", async () => {
    const { svc } = setup(null, { previousVersion: 2 });
    const events = lastEvents(svc);
    await svc.generate(DTO, CTX);
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.regenerated");
    expect(call.payload.version).toBe(3);
    expect(call.payload.previous_version).toBe(2);
  });

  it("enqueues a render job carrying refs + tracing only (no PII)", async () => {
    const { svc, renderQueue } = setup("v1.ciphertext");
    await svc.generate(DTO, CTX);
    expect(renderQueue.add).toHaveBeenCalledOnce();
    const [, payload] = renderQueue.add.mock.calls[0]!;
    expect(payload).toEqual({
      resumeId: "res-1",
      workerId: "w-1",
      correlationId: "c",
      requestId: "r",
    });
    // The decrypted name must never ride the render job.
    expect(JSON.stringify(payload)).not.toMatch(/Asha/i);
  });

  it("a render-enqueue failure does NOT fail generation (caught + degraded)", async () => {
    const { svc, renderQueue } = setup(null);
    renderQueue.add.mockRejectedValue(new Error("redis down"));
    const out = await svc.generate(DTO, CTX); // must NOT throw
    expect(out.resume_id).toBe("res-1");
  });
});
