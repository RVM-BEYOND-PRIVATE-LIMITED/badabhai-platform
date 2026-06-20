import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Queue } from "bullmq";
import { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { ResumeRateLimit } from "./resume-rate-limit.service";
import type { ProfilesRepository } from "../profiles/profiles.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { AiService } from "../ai/ai.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { StorageService } from "../storage/storage.service";
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
  opts: { previousVersion?: number; previousProfileId?: string } = {},
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
      opts.previousVersion != null
        ? { id: "prev", version: opts.previousVersion, profileId: opts.previousProfileId }
        : undefined,
    ),
  };
  const pii = { decrypt: vi.fn(() => NAME) };
  const resumes = {
    // create() is the regenerate (force) path → version comes from the input.
    create: vi.fn(async (input: Record<string, unknown>) => ({ id: "res-1", ...input })),
    // createInitial() is the idempotent initial path (version 1). The optional
    // `existing` lets a test simulate a row already present (conflict) for the
    // insert-if-absent (systemInitiated) case.
    createInitial: vi.fn(async (input: Record<string, unknown>, _o: { overwrite: boolean }) => ({
      id: "res-1",
      ...input,
    })),
    // findById backs getById/download/regenerate/recordShare; tests override it.
    findById: vi.fn(async (_id: string) => undefined as Record<string, unknown> | undefined),
  };
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
  const storage = {
    createSignedUrl: vi.fn(async (_key: string, _ttl: number) => "https://signed.example/url?token=abc"),
  };
  const config = {
    RESUME_SIGNED_URL_TTL_SECONDS: 900,
    RESUME_RATE_LIMIT_PER_IP_PER_HOUR: 20,
  } as ServerConfig;

  const svc = new ResumeService(
    resumes as unknown as ResumeRepository,
    profiles as unknown as ProfilesRepository,
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
    ai as unknown as AiService,
    pii as unknown as PiiCryptoService,
    rateLimit as unknown as ResumeRateLimit,
    storage as unknown as StorageService,
    config,
    renderQueue as unknown as Queue<ResumeRenderJobData>,
  );
  EVENTS.set(svc, events);
  return { svc, ai, pii, resumes, rateLimit, renderQueue, events, storage, config };
}

describe("ResumeService — TD21 name injection", () => {
  it("injects the decrypted name into the resume but NEVER sends it to the AI service", async () => {
    const { svc, ai, pii, resumes } = setup("v1.ciphertext");
    await svc.generate(DTO, CTX);

    // The AI service only ever received the structured profile — no name anywhere.
    const aiArg = ai.generateResume.mock.calls[0]![0];
    expect(JSON.stringify(aiArg)).not.toMatch(/Asha/i);

    expect(pii.decrypt).toHaveBeenCalledWith("v1.ciphertext");
    const saved = resumes.createInitial.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
    expect(saved.resumeText).toContain(NAME); // name lands on the worker's own resume
    expect(saved.resumeJson.name).toBe(NAME);
  });

  it("omits the name when none is set — no decrypt, resume unchanged", async () => {
    const { svc, pii, resumes } = setup(null);
    await svc.generate(DTO, CTX);

    expect(pii.decrypt).not.toHaveBeenCalled();
    const saved = resumes.createInitial.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
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
    const saved = resumes.createInitial.mock.calls[0]![0] as { resumeText: string; resumeJson: { name?: string } };
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

  it("emits resume.regenerated with previous_version on an explicit regenerate (version > 1)", async () => {
    const { svc } = setup(null, { previousVersion: 2 });
    const events = lastEvents(svc);
    await svc.generate(DTO, CTX, { forceNewVersion: true });
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

describe("ResumeService — idempotent initial resume (TD5)", () => {
  it("manual generate is authoritative: createInitial with overwrite=true (refresh content)", async () => {
    // The name is recorded after the (name-less) auto-generate; the manual generate
    // must overwrite the existing v1 with the named content — never create a v2.
    const { svc, resumes } = setup("v1.ciphertext");
    const out = await svc.generate(DTO, CTX); // not systemInitiated
    expect(resumes.createInitial).toHaveBeenCalledOnce();
    expect(resumes.create).not.toHaveBeenCalled();
    const [input, options] = resumes.createInitial.mock.calls[0]!;
    expect((options as { overwrite: boolean }).overwrite).toBe(true);
    expect((input as { version: number }).version).toBe(1);
    expect((input as { resumeJson: { name?: string } }).resumeJson.name).toBe(NAME);
    expect(out.version).toBe(1);
  });

  it("system auto-generate inserts-if-absent: createInitial with overwrite=false", async () => {
    const { svc, resumes } = setup(null);
    await svc.generate(DTO, CTX, { systemInitiated: true });
    expect(resumes.createInitial).toHaveBeenCalledOnce();
    const [, options] = resumes.createInitial.mock.calls[0]!;
    expect((options as { overwrite: boolean }).overwrite).toBe(false);
  });

  it("forceNewVersion creates a new version via create() (not the initial path)", async () => {
    const { svc, resumes } = setup(null, { previousVersion: 1 });
    const out = await svc.generate(DTO, CTX, { forceNewVersion: true });
    expect(resumes.create).toHaveBeenCalledOnce();
    expect(resumes.createInitial).not.toHaveBeenCalled();
    expect(out.version).toBe(2);
  });
});

const RES_ID = "11111111-1111-1111-1111-111111111111";
// Align with the generate-path mocks in setup(): profile/worker are "w-1"/"p-1".
const OWNER = "w-1";
const OTHER = "99999999-9999-9999-9999-999999999999";
const ROW = {
  id: RES_ID,
  workerId: OWNER,
  profileId: "p-1",
  resumeJson: { summary: "CNC/VMC operator" },
  resumeText: "Experienced CNC/VMC operator.",
  generatedAt: new Date("2026-06-11T00:00:00.000Z"),
  version: 2,
  renderStatus: "pending" as string,
  pdfStorageKey: null as string | null,
};

describe("ResumeService.getById (ops read view)", () => {
  it("returns the resume shaped snake_case and PII-free", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    const res = await svc.getById(RES_ID);
    expect(res).toEqual({
      resume_id: RES_ID,
      worker_id: OWNER,
      profile_id: ROW.profileId,
      version: 2,
      resume_text: ROW.resumeText,
      resume_json: ROW.resumeJson,
      render_status: "pending",
      generated_at: ROW.generatedAt,
    });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.getById(RES_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ResumeService.download (TD5 / TD29 worker-authed + ownership)", () => {
  it("mints a signed URL + emits resume.downloaded (actor=worker) for the OWNER of a rendered PDF", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: "resumes/w/r/v2.pdf",
    });
    const res = await svc.download(OWNER, RES_ID, CTX);
    expect(res).toEqual({ url: "https://signed.example/url?token=abc", expires_in: 900 });
    expect(storage.createSignedUrl).toHaveBeenCalledWith("resumes/w/r/v2.pdf", 900);
    const call = events.emit.mock.calls[0]![0] as {
      event_name: string;
      actor: { actor_type: string; actor_id: string };
      payload: Record<string, unknown>;
    };
    expect(call.event_name).toBe("resume.downloaded");
    expect(call.payload.format).toBe("pdf");
    expect(call.actor).toEqual({ actor_type: "worker", actor_id: OWNER });
    expect(call.payload.worker_id).toBe(OWNER);
    // The signed URL (token) must NEVER ride the event payload.
    expect(JSON.stringify(call.payload)).not.toContain("token=abc");
  });

  it("404s for a NON-OWNER (no existence oracle) and mints/emits nothing", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: "resumes/w/r/v2.pdf",
    });
    await expect(svc.download(OTHER, RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s while still rendering ('pending') and emits nothing", async () => {
    const { svc, resumes, storage, events } = setup(null);
    resumes.findById.mockResolvedValueOnce({ ...ROW, renderStatus: "pending" });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s when the render failed", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce({ ...ROW, renderStatus: "failed" });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("409s when rendered but the storage key is missing (defensive)", async () => {
    const { svc, resumes } = setup(null);
    resumes.findById.mockResolvedValueOnce({ ...ROW, renderStatus: "rendered", pdfStorageKey: null });
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.download(OWNER, RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ResumeService.recordShare (TD5)", () => {
  it("emits resume.shared with the closed-enum channel and no free text", async () => {
    const { svc, resumes, events } = setup(null);
    resumes.findById.mockResolvedValueOnce(ROW);
    const res = await svc.recordShare(RES_ID, { channel: "whatsapp" }, CTX);
    expect(res).toEqual({ ok: true });
    const call = events.emit.mock.calls[0]![0] as { event_name: string; payload: { channel: string } };
    expect(call.event_name).toBe("resume.shared");
    expect(call.payload.channel).toBe("whatsapp");
  });

  it("404s when the resume does not exist", async () => {
    const { svc } = setup(null);
    await expect(svc.recordShare(RES_ID, { channel: "link" }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("ResumeService.regenerate (TD5)", () => {
  it("loads the source resume then calls generate (forcing a new version)", async () => {
    const { svc, resumes } = setup(null, { previousVersion: 2, previousProfileId: ROW.profileId });
    resumes.findById.mockResolvedValueOnce(ROW);
    const out = await svc.regenerate(RES_ID, CTX);
    // generate() ran the force path (create, not createInitial) → version bumped.
    expect(resumes.create).toHaveBeenCalledOnce();
    expect(out.version).toBe(3);
  });

  it("404s when the source resume does not exist", async () => {
    const { svc, resumes } = setup(null);
    await expect(svc.regenerate(RES_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(resumes.create).not.toHaveBeenCalled();
  });
});
