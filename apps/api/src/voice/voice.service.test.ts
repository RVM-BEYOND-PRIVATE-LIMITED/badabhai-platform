import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { VoiceService } from "./voice.service";
import type { VoiceRepository } from "./voice.repository";
import type { ChatRepository } from "../chat/chat.repository";
import type { EventsService } from "../events/events.service";
import type { AiJobsRepository } from "../profiles/ai-jobs.repository";
import type { VoiceTranscriptionJobData } from "../queue/queue.constants";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const SESSION = "22222222-2222-4222-8222-222222222222";

function setup() {
  const voice = {
    create: vi.fn(async (i: Record<string, unknown>) => ({ id: "note-1", durationSeconds: i.durationSeconds })),
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  };
  const chat = {
    findSession: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  };
  const events = { emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p) };
  const aiJobs = { create: vi.fn(async () => ({ id: "job-1" })), markFailed: vi.fn(async () => undefined) };
  const queue = { add: vi.fn(async () => undefined) };
  const svc = new VoiceService(
    voice as unknown as VoiceRepository,
    chat as unknown as ChatRepository,
    events as unknown as EventsService,
    aiJobs as unknown as AiJobsRepository,
    queue as unknown as Queue<VoiceTranscriptionJobData>,
  );
  return { svc, voice, chat, events, aiJobs, queue };
}

const UPLOAD = { session_id: SESSION, storage_path: "p/a.m4a", duration_seconds: 12 } as never;

describe("VoiceService.upload — ownership + PII-free event", () => {
  it("404s when the session does not exist (no note created/emitted)", async () => {
    const { svc, voice, events } = setup();
    await expect(svc.upload(WORKER, UPLOAD, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(voice.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("404s when the session belongs to ANOTHER worker (no oracle)", async () => {
    const { svc, chat, voice } = setup();
    chat.findSession.mockResolvedValueOnce({ id: SESSION, workerId: OTHER });
    await expect(svc.upload(WORKER, UPLOAD, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(voice.create).not.toHaveBeenCalled();
  });

  it("creates the note + emits voice_note.uploaded carrying no phone/PII", async () => {
    const { svc, chat, events } = setup();
    chat.findSession.mockResolvedValueOnce({ id: SESSION, workerId: WORKER });
    const res = await svc.upload(WORKER, UPLOAD, CTX);
    expect(res).toEqual({ voice_note_id: "note-1", duration_seconds: 12 });
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("voice_note.uploaded");
    expect(call.payload.worker_id).toBe(WORKER);
    expect(JSON.stringify(call.payload)).not.toMatch(/phone|full_?name/i);
  });
});

describe("VoiceService.requestTranscription — ownership + enqueue safety", () => {
  it("404s when the note does not exist", async () => {
    const { svc } = setup();
    await expect(
      svc.requestTranscription(WORKER, { voice_note_id: "vn" } as never, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s when the note belongs to ANOTHER worker (no oracle)", async () => {
    const { svc, voice, aiJobs } = setup();
    voice.findById.mockResolvedValueOnce({ id: "vn", workerId: OTHER });
    await expect(
      svc.requestTranscription(WORKER, { voice_note_id: "vn" } as never, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(aiJobs.create).not.toHaveBeenCalled();
  });

  it("enqueues + emits transcription_requested for the OWNER", async () => {
    const { svc, voice, events, queue } = setup();
    voice.findById.mockResolvedValueOnce({ id: "vn", workerId: WORKER, storagePath: "p", durationSeconds: 5 });
    const res = await svc.requestTranscription(WORKER, { voice_note_id: "vn" } as never, CTX);
    expect(res).toEqual({ ai_job_id: "job-1", status: "queued" });
    expect(queue.add).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("voice_note.transcription_requested");
  });

  it("on enqueue failure marks the job failed, emits failed, and throws 503", async () => {
    const { svc, voice, aiJobs, events, queue } = setup();
    voice.findById.mockResolvedValueOnce({ id: "vn", workerId: WORKER, storagePath: "p", durationSeconds: 5 });
    queue.add.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      svc.requestTranscription(WORKER, { voice_note_id: "vn" } as never, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("voice_note.transcription_failed");
  });
});
