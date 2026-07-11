import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { VoiceController } from "./voice.controller";
import type { VoiceService } from "./voice.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid" };

function make() {
  const voice = {
    createUploadUrl: vi.fn(async () => ({
      storage_path: "voice-notes/w/k.m4a",
      upload_url: "https://s/storage/v1/object/upload/sign/b/k?token=t",
      expires_in: 7200,
    })),
    upload: vi.fn(async () => ({ voice_note_id: "v", duration_seconds: 10 })),
    requestTranscription: vi.fn(async () => ({ ai_job_id: "j", status: "queued" })),
    getNote: vi.fn(async () => ({ voice_note_id: "vn" })),
  };
  return { controller: new VoiceController(voice as unknown as VoiceService), voice };
}

describe("VoiceController (thin) — worker from token, never the body", () => {
  it("upload-url passes ONLY the authenticated worker id (empty body by design)", async () => {
    const { controller, voice } = make();
    await controller.createUploadUrl(WORKER, {} as never);
    expect(voice.createUploadUrl).toHaveBeenCalledWith(WORKER.id);
  });

  it("upload passes the authenticated worker id + dto", async () => {
    const { controller, voice } = make();
    const dto = { session_id: "s", storage_path: "p", duration_seconds: 10 };
    await controller.upload(WORKER, dto as never, CTX);
    expect(voice.upload).toHaveBeenCalledWith(WORKER.id, dto, CTX);
  });

  it("transcribe passes the authenticated worker id + dto", async () => {
    const { controller, voice } = make();
    const dto = { voice_note_id: "vn" };
    await controller.transcribe(WORKER, dto as never, CTX);
    expect(voice.requestTranscription).toHaveBeenCalledWith(WORKER.id, dto, CTX);
  });

  it("get passes the authenticated worker id + the validated param", async () => {
    const { controller, voice } = make();
    await controller.get(WORKER, { voiceNoteId: "vn" });
    expect(voice.getNote).toHaveBeenCalledWith(WORKER.id, "vn");
  });
});
