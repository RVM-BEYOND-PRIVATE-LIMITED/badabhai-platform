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
    upload: vi.fn(async () => ({ voice_note_id: "v", duration_seconds: 10 })),
    requestTranscription: vi.fn(async () => ({ ai_job_id: "j", status: "queued" })),
  };
  return { controller: new VoiceController(voice as unknown as VoiceService), voice };
}

describe("VoiceController (thin) — worker from token, never the body", () => {
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
});
