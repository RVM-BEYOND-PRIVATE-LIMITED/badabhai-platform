import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { VoiceTranscriptionProcessor } from "./voice-transcription.processor";
import type { VoiceTranscriptionJobData } from "../queue/queue.constants";

const JOB = {
  voiceNoteId: "11111111-1111-4111-8111-111111111111",
  workerId: "22222222-2222-4222-8222-222222222222",
  storagePath: "worker/sess/v1.ogg",
  durationSeconds: 12,
  languageCode: null,
  aiJobId: "33333333-3333-4333-8333-333333333333",
  correlationId: "44444444-4444-4444-8444-444444444444",
  requestId: "req-1",
} satisfies VoiceTranscriptionJobData;

const MOCK_TRANSCRIPT = "main vmc operator hoon";
const MOCK_ENGLISH = "i am a vmc operator";

function makeJob(over: { attemptsMade?: number; attempts?: number } = {}) {
  return {
    data: JOB,
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 3 },
  } as never;
}

function make(opts: { findById?: unknown; transcribeThrows?: boolean } = {}) {
  const voice = {
    setTranscript: vi.fn().mockResolvedValue(undefined),
  };
  const aiJobs = {
    findById: vi.fn().mockResolvedValue(opts.findById ?? undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const ai = {
    transcribe: opts.transcribeThrows
      ? vi.fn().mockRejectedValue(new Error("boom"))
      : vi.fn().mockResolvedValue({
          transcript_text: MOCK_TRANSCRIPT,
          confidence: 0.9,
          english_text: MOCK_ENGLISH,
          is_mock: true,
        }),
  };
  const proc = new VoiceTranscriptionProcessor(
    voice as never,
    aiJobs as never,
    events as never,
    ai as never,
  );
  return { proc, voice, aiJobs, events, ai };
}

describe("VoiceTranscriptionProcessor", () => {
  it("D-2: forwards the opaque worker_ref + duration so the ai-service can chunk + attribute spend", async () => {
    // A 30-120s note costs up to 5 real Sarvam calls; worker_ref attributes them
    // to this worker's TD27 per-user daily budget. It is an opaque UUID (PII-free
    // — the same id already sent for chat/extraction), never a name or phone.
    const { proc, ai } = make();
    await proc.process(makeJob());
    expect(ai.transcribe).toHaveBeenCalledWith({
      voice_note_id: JOB.voiceNoteId,
      storage_path: JOB.storagePath,
      duration_seconds: JOB.durationSeconds,
      language_code: undefined,
      worker_ref: JOB.workerId,
    });
    // The transcription request carries refs + duration only — no PII.
    expect(JSON.stringify(ai.transcribe.mock.calls)).not.toContain("transcript");
  });

  it("happy path: persists transcript, marks completed, emits transcription_completed", async () => {
    const { proc, voice, aiJobs, events } = make();
    const res = await proc.process(makeJob());
    expect(res).toEqual({ voice_note_id: JOB.voiceNoteId });
    expect(voice.setTranscript).toHaveBeenCalledWith(
      JOB.voiceNoteId,
      MOCK_TRANSCRIPT,
      0.9,
      MOCK_ENGLISH,
    );
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(JOB.aiJobId, {
      voice_note_id: JOB.voiceNoteId,
    });
    expect(events.emit.mock.calls[0]![0].event_name).toBe("voice_note.transcription_completed");
  });

  it("privacy: the completed event carries length, never the transcript text", async () => {
    const { proc, events } = make();
    await proc.process(makeJob());
    const payload = events.emit.mock.calls[0]![0].payload;
    expect(payload.transcript_length).toBe(MOCK_TRANSCRIPT.length);
    expect(payload.transcript_english_length).toBe(MOCK_ENGLISH.length);
    expect(JSON.stringify(payload)).not.toContain(MOCK_TRANSCRIPT);
    expect(JSON.stringify(payload)).not.toContain(MOCK_ENGLISH);
  });

  it("idempotent: an already-completed job is not reprocessed", async () => {
    const { proc, voice, aiJobs, ai } = make({
      findById: { status: "completed", outputRef: { voice_note_id: JOB.voiceNoteId } },
    });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ voice_note_id: JOB.voiceNoteId });
    expect(aiJobs.markRunning).not.toHaveBeenCalled();
    expect(ai.transcribe).not.toHaveBeenCalled();
    expect(voice.setTranscript).not.toHaveBeenCalled();
  });

  it("non-final attempt failure: rethrows WITHOUT marking failed / emitting", async () => {
    const { proc, aiJobs, events } = make({ transcribeThrows: true });
    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow();
    expect(aiJobs.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("final attempt failure: marks failed + emits transcription_failed exactly once", async () => {
    const { proc, aiJobs, events } = make({ transcribeThrows: true });
    await expect(proc.process(makeJob({ attemptsMade: 2, attempts: 3 }))).rejects.toThrow();
    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    expect(events.emit).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("voice_note.transcription_failed");
  });
});
