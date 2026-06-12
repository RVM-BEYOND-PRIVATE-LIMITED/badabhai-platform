import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { ResumeController } from "./resume.controller";
import type { ResumeService } from "./resume.service";
import type { ResumeRepository } from "./resume.repository";
import type { EventsService } from "../events/events.service";
import type { StorageService } from "../storage/storage.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  workerId: "22222222-2222-2222-2222-222222222222",
  profileId: "33333333-3333-3333-3333-333333333333",
  resumeJson: { summary: "CNC/VMC operator", skills: ["vmc_operator"] },
  resumeText: "Experienced CNC/VMC operator with 5 years on Fanuc controls.",
  generatedAt: new Date("2026-06-11T00:00:00.000Z"),
  version: 2,
  renderStatus: "pending",
};

/** The read endpoint only touches the repository; the other deps are irrelevant here. */
function makeController(findById: () => Promise<typeof ROW | undefined>): ResumeController {
  const repo = { findById } as unknown as ResumeRepository;
  return new ResumeController(
    {} as unknown as ResumeService,
    repo,
    {} as unknown as EventsService,
    {} as unknown as StorageService,
    {} as unknown as ServerConfig,
  );
}

/** Full controller with spy-able service/events/storage for the action endpoints. */
function makeFullController(row: Record<string, unknown> | undefined) {
  const resumes = { findById: vi.fn(async () => row) };
  const resume = { generate: vi.fn(async () => ({ resume_id: "new-res", version: 3 })) };
  const events = {
    emit: vi.fn(
      async (params: { event_name: string; payload: Record<string, unknown> }) => params,
    ),
  };
  const storage = {
    createSignedUrl: vi.fn(async (_key: string, _ttl: number) => "https://signed.example/url?token=abc"),
  };
  const config = { RESUME_SIGNED_URL_TTL_SECONDS: 900 } as ServerConfig;
  const controller = new ResumeController(
    resume as unknown as ResumeService,
    resumes as unknown as ResumeRepository,
    events as unknown as EventsService,
    storage as unknown as StorageService,
    config,
  );
  return { controller, resumes, resume, events, storage };
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
      render_status: ROW.renderStatus,
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

describe("ResumeController.download (TD5)", () => {
  it("mints a signed URL + emits resume.downloaded when the PDF is rendered", async () => {
    const { controller, events, storage } = makeFullController({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: "resumes/w/r/v2.pdf",
    });

    const res = await controller.download(ROW.id, CTX);
    expect(res).toEqual({ url: "https://signed.example/url?token=abc", expires_in: 900 });
    expect(storage.createSignedUrl).toHaveBeenCalledWith("resumes/w/r/v2.pdf", 900);

    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.downloaded");
    expect(call.payload.format).toBe("pdf");
    // The signed URL (token) must NEVER ride the event payload.
    expect(JSON.stringify(call.payload)).not.toContain("token=abc");
  });

  it("409s while still rendering ('pending') and emits nothing", async () => {
    const { controller, events, storage } = makeFullController({ ...ROW, renderStatus: "pending" });
    await expect(controller.download(ROW.id, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("409s when the render failed", async () => {
    const { controller } = makeFullController({ ...ROW, renderStatus: "failed" });
    await expect(controller.download(ROW.id, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("409s when rendered but the storage key is missing (defensive)", async () => {
    const { controller } = makeFullController({
      ...ROW,
      renderStatus: "rendered",
      pdfStorageKey: null,
    });
    await expect(controller.download(ROW.id, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s when the resume does not exist", async () => {
    const { controller } = makeFullController(undefined);
    await expect(controller.download(ROW.id, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ResumeController.share (TD5)", () => {
  it("emits resume.shared with the closed-enum channel and no free text", async () => {
    const { controller, events } = makeFullController({ ...ROW });
    const res = await controller.share(ROW.id, { channel: "whatsapp" }, CTX);
    expect(res).toEqual({ ok: true });
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("resume.shared");
    expect(call.payload.channel).toBe("whatsapp");
  });

  it("404s when the resume does not exist", async () => {
    const { controller } = makeFullController(undefined);
    await expect(controller.share(ROW.id, { channel: "link" }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("ResumeController.regenerate (TD5)", () => {
  it("loads the source resume then calls generate (forcing a new version) with its worker/profile", async () => {
    const { controller, resume } = makeFullController({ ...ROW });
    const out = await controller.regenerate(ROW.id, CTX);
    expect(resume.generate).toHaveBeenCalledWith(
      { worker_id: ROW.workerId, profile_id: ROW.profileId },
      CTX,
      { forceNewVersion: true }, // regenerate bumps, never upserts the current resume
    );
    expect(out).toEqual({ resume_id: "new-res", version: 3 });
  });

  it("404s when the source resume does not exist", async () => {
    const { controller, resume } = makeFullController(undefined);
    await expect(controller.regenerate(ROW.id, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(resume.generate).not.toHaveBeenCalled();
  });
});
