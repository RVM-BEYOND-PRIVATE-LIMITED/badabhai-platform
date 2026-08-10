import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { CONSENT_PURPOSES } from "@badabhai/types";
import { CONSENT_PURPOSE_KEY } from "../auth/consent.guard";
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

/**
 * V9 WIRING — the `voice_processing` purpose is declared where a clip can come into existence.
 *
 * Reflects the REAL metadata rather than mocking the guard, the same shape
 * `resume-consent.authz.test.ts` uses: this catches a decorator silently dropped in a later
 * refactor, which is the failure mode a behavioural test on the guard alone cannot see.
 */
describe("V9 — @RequireConsentPurpose wiring on VoiceController", () => {
  const declared = (method: keyof VoiceController): unknown =>
    Reflect.getMetadata(
      CONSENT_PURPOSE_KEY,
      (VoiceController.prototype as unknown as Record<string, object>)[method as string]!,
    );

  it.each(["createUploadUrl", "upload", "transcribe"] as const)(
    "%s requires voice_processing — the three routes that create or send a recording",
    (method) => {
      expect(declared(method)).toBe("voice_processing");
    },
  );

  it("the READ route declares no purpose — withdrawal must not hide a worker's own data", () => {
    // Deliberate: gating this would lock a worker out of what was already captured, which
    // inverts what withdrawal is for. Erasure removes the clip; reading it back is not
    // processing. See the route's own comment in voice.controller.ts.
    expect(declared("get")).toBeUndefined();
  });

  it("the purpose is a REAL member of CONSENT_PURPOSES (not a typo'd string)", () => {
    // The decorator is typed, but the metadata is read back as a bare string at runtime; a
    // mismatch between this and the consent row would fail OPEN-looking (always 403) rather
    // than loudly, so pin it against the source list.
    expect(CONSENT_PURPOSES).toContain("voice_processing");
  });
});
