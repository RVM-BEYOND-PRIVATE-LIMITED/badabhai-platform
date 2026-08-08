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

function make(
  opts: {
    findById?: unknown;
    transcribeThrows?: boolean;
    /** The `voice_notes` row as it stands when the attempt starts. */
    note?: { transcriptText: string | null } | undefined;
    /** A degraded adapter result: an empty transcript that SAYS why it is empty. */
    errorCode?: string;
  } = {},
) {
  const voice = {
    setTranscript: vi.fn().mockResolvedValue(undefined),
    // Defaults to a row with NO transcript — i.e. this audio has not been paid for yet.
    findById: vi.fn().mockResolvedValue(
      opts.note === undefined ? { id: JOB.voiceNoteId, transcriptText: null } : opts.note,
    ),
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
      : vi.fn().mockResolvedValue(
          opts.errorCode
            ? {
                transcript_text: "",
                confidence: 0,
                english_text: "",
                is_mock: true,
                error_code: opts.errorCode,
              }
            : {
                transcript_text: MOCK_TRANSCRIPT,
                confidence: 0.9,
                english_text: MOCK_ENGLISH,
                is_mock: true,
                error_code: null,
              },
        ),
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
  // --- The silent-failure defect (plan §7.2) --------------------------------
  //
  // Four different empty transcripts used to arrive here identical, because the adapter's
  // `error_code` was logged on the ai-service and then dropped at the response boundary. Three
  // of them are failures; only the fourth is a worker who said nothing.

  it.each([
    ["stt_budget_blocked", "we refused to call the provider"],
    ["stt_call_failed", "the provider call failed"],
    ["stt_service_unreachable", "the ai-service never answered"],
  ])("a degraded result (%s) is NEVER stored or completed", async (code) => {
    const { proc, voice, aiJobs, events } = make({ errorCode: code });

    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow(code);

    // The worker's answer was not transcribed, so nothing may claim it was.
    expect(voice.setTranscript).not.toHaveBeenCalled();
    expect(aiJobs.markCompleted).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled(); // non-final attempt — BullMQ retries
  });

  it("a degraded result on the FINAL attempt fails the job and names the code", async () => {
    // The reason has to survive to the audit trail, or "why did this worker's answer vanish"
    // is unanswerable after the fact.
    const { proc, aiJobs, events } = make({ errorCode: "stt_call_failed" });

    await expect(proc.process(makeJob({ attemptsMade: 2, attempts: 3 }))).rejects.toThrow();

    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    expect(String(aiJobs.markFailed.mock.calls[0]![1])).toContain("stt_call_failed");
    expect(events.emit).toHaveBeenCalledOnce();
    const call = events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("voice_note.transcription_failed");
    expect(String(call.payload.reason)).toContain("stt_call_failed");
  });

  it("an empty transcript with NO error code is a real answer — the worker said nothing", async () => {
    // The case that makes the three above meaningful. Silence is a legitimate outcome and must
    // still complete, or every worker who pauses too long gets a failed job.
    const { proc, voice, aiJobs, events } = make();
    proc["ai"].transcribe = vi.fn().mockResolvedValue({
      transcript_text: "",
      confidence: 0,
      english_text: "",
      is_mock: true,
      error_code: null,
    });

    await proc.process(makeJob());

    expect(voice.setTranscript).toHaveBeenCalledWith(JOB.voiceNoteId, "", 0, "");
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("voice_note.transcription_completed");
  });

  // --- The retry double-charge (plan §7.3) ----------------------------------

  it("never re-calls the provider for audio already transcribed, whatever the job status says", async () => {
    // `markRunning` fires at the top of EVERY attempt, so the job-status guard sees `running`
    // on a retry and lets a second Sarvam call through. That is a real double-charge whenever
    // the call succeeded and something after it did not — `setTranscript` blipping, the
    // completion emit throwing, the worker being killed between the two.
    const { proc, voice, aiJobs, ai } = make({
      findById: { status: "running" },
      note: { transcriptText: MOCK_TRANSCRIPT },
    });

    const res = await proc.process(makeJob({ attemptsMade: 1, attempts: 3 }));

    expect(ai.transcribe).not.toHaveBeenCalled(); // the whole point
    expect(voice.setTranscript).not.toHaveBeenCalled();
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce(); // the job catches up to the row
    expect(res).toEqual({ voice_note_id: JOB.voiceNoteId });
  });

  it("treats an EMPTY stored transcript as already paid for, not as absent", async () => {
    // Compared against null explicitly, never truthiness. An empty string is a real transcript
    // (the worker said nothing) and it cost exactly as much as a full one.
    const { proc, ai, aiJobs } = make({ findById: { status: "running" }, note: { transcriptText: "" } });

    await proc.process(makeJob({ attemptsMade: 1, attempts: 3 }));

    expect(ai.transcribe).not.toHaveBeenCalled();
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce();
  });
});
