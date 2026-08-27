import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { fakeAiCostTotals } from "../ai/ai-cost-totals.fake";
import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import { VoiceTranscriptionProcessor } from "./voice-transcription.processor";
import { VoiceTranscriptionService } from "./voice-transcription.service";
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

/**
 * The interview this clip was spoken into. NOT on `VoiceTranscriptionJobData` and never was —
 * it lives on the `voice_notes` row (`session_id`, NOT NULL), which is the same authority the
 * ownership guard already reads. Cost attribution takes it from there for the same reason.
 */
const SESSION_ID = "66666666-6666-4666-8666-666666666666";

/** The `voice_notes` row for [JOB] — the AUTHORITY for storage path, owner and duration. */
const ROW = {
  id: JOB.voiceNoteId,
  workerId: JOB.workerId,
  sessionId: SESSION_ID,
  storagePath: JOB.storagePath,
  durationSeconds: JOB.durationSeconds,
};

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
    note?: Record<string, unknown> | undefined;
    /** A degraded adapter result: an empty transcript that SAYS why it is empty. */
    errorCode?: string;
    /** The per-call cost record the ai-service returns (#738). `null`/absent = the mock path. */
    aiMetadata?: Record<string, unknown> | null;
    /**
     * Whether the adapter's success result is a MOCK — the provider was never called and the
     * transcript is the adapter's canned sentence (#1246). Defaults to `false` (a real call).
     */
    isMock?: boolean;
  } = {},
) {
  const voice = {
    setTranscript: vi.fn().mockResolvedValue(undefined),
    // Defaults to a row with NO transcript — i.e. this audio has not been paid for yet — in
    // the REAL row shape: transcription now reads storage_path,
    // worker_id and duration from here rather than from the job payload, so a
    // fixture missing them is a fixture that cannot pass the ownership guard.
    findById: vi.fn().mockResolvedValue(
      opts.note === undefined
        ? {
            id: JOB.voiceNoteId,
            workerId: JOB.workerId,
            sessionId: SESSION_ID,
            storagePath: JOB.storagePath,
            durationSeconds: JOB.durationSeconds,
            transcriptText: null,
          }
        : opts.note,
    ),
  };
  const aiJobs = {
    create: vi.fn().mockResolvedValue({ id: "aij_sync_1" }),
    findById: vi.fn().mockResolvedValue(opts.findById ?? undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  // `emitOnce` is what `AiCostRecorder` calls — it needs the "written or deduped" bit to
  // decide whether to move the running totals. Routed through the SAME `emit` spy so the cost
  // assertions below still read a real emit rather than passing against nothing.
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = {
    emit,
    emitOnce: vi.fn(async (params: unknown) => {
      await emit(params);
      return { event: params, written: true };
    }),
  };
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
                ai_metadata: opts.aiMetadata ?? null,
              }
            : {
                transcript_text: MOCK_TRANSCRIPT,
                confidence: 0.9,
                english_text: MOCK_ENGLISH,
                // A REAL transcription by default (#1246). The constant is named MOCK_* because
                // it borrows the adapter's canned string, but what these cases exercise is the
                // SUCCESS path — and `transcribeNow` now refuses a provably synthetic transcript
                // rather than storing it as a worker's answer. Cases that mean "the provider was
                // never called" opt in with `isMock: true`.
                is_mock: opts.isMock ?? false,
                error_code: null,
                ai_metadata: opts.aiMetadata ?? null,
              },
        ),
  };
  // The logic moved into `VoiceTranscriptionService`; the processor is now a BullMQ adapter over
  // it. Every behavioural case below still drives through `proc.process(...)` ON PURPOSE — that
  // is what makes this suite a regression proof that the extraction changed no behaviour, rather
  // than a rewritten suite testing the new shape and quietly forgiving a drift.
  const totals = fakeAiCostTotals();
  // 0083: the SHARED trace fake. STT has a worker AND a session, so a transcription is one
  // of the traces that actually stores.
  const traces = fakeAiTraceRecorder();
  const service = new VoiceTranscriptionService(
    voice as never,
    aiJobs as never,
    events as never,
    ai as never,
    // The REAL recorder over the same fake events service, so the cost assertions below are
    // about an event that was actually built rather than about a stub being called (#738).
    new AiCostRecorder(events as never, totals.repo),
    traces.recorder,
  );
  const proc = new VoiceTranscriptionProcessor(service);
  return { proc, service, voice, aiJobs, events, ai, totals, traces };
}

describe("VoiceTranscriptionProcessor", () => {
  it("D-2: forwards the opaque worker_ref + duration so the ai-service can chunk + attribute spend", async () => {
    // A 30-120s note costs up to 5 real Sarvam calls; worker_ref attributes them
    // to this worker's TD27 per-user daily budget. It is an opaque UUID (PII-free
    // — the same id already sent for chat/extraction), never a name or phone.
    const { proc, ai } = make();
    await proc.process(makeJob());
    expect(ai.transcribe).toHaveBeenCalledWith(
      {
        voice_note_id: JOB.voiceNoteId,
        storage_path: JOB.storagePath,
        duration_seconds: JOB.durationSeconds,
        language_code: undefined,
        worker_ref: JOB.workerId,
      },
      // BL-19: the job's own correlation/request id, threaded to the ai-service call.
      { correlationId: JOB.correlationId, requestId: JOB.requestId },
    );
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
    // `undefined` usage on the MOCK path (`ai_metadata` is null here) — the columns stay NULL
    // rather than recording a zero cost that cannot be told apart from a real free call. The
    // real-metadata case is locked in "STT cost recording" below.
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(
      JOB.aiJobId,
      { voice_note_id: JOB.voiceNoteId },
      undefined,
    );
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
    // Overrides the harness's shared `ai` double rather than reaching into a private field —
    // the collaborator is the same object the service holds, so this stays honest without
    // depending on which class currently owns it.
    const { proc, voice, aiJobs, events, ai } = make();
    ai.transcribe = vi.fn().mockResolvedValue({
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
      note: { ...ROW, transcriptText: MOCK_TRANSCRIPT },
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
    const { proc, ai, aiJobs } = make({
      findById: { status: "running" },
      note: { ...ROW, transcriptText: "" },
    });

    await proc.process(makeJob({ attemptsMade: 1, attempts: 3 }));

    expect(ai.transcribe).not.toHaveBeenCalled();
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * V4b — the queue/service seam.
 *
 * The processor keeps exactly one decision: whether this attempt is the LAST one. It is a
 * BullMQ fact the service cannot derive, and the terminal record (`markFailed` + one
 * `transcription_failed`) hangs off it — so getting it wrong means either no audit trail for a
 * failure, or one written on every retry.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("VoiceTranscriptionProcessor — the BullMQ adapter, and only that", () => {
  /** A service double that records the options it was handed. */
  function spyService() {
    const transcribe = vi.fn().mockResolvedValue({ voice_note_id: JOB.voiceNoteId });
    const proc = new VoiceTranscriptionProcessor({ transcribe } as never);
    return { proc, transcribe };
  }

  it("passes the job payload through untouched", async () => {
    const { proc, transcribe } = spyService();
    await proc.process(makeJob());
    expect(transcribe.mock.calls[0]![0]).toBe(JOB);
  });

  it.each([
    [0, 3, false],
    [1, 3, false],
    [2, 3, true], // attemptsMade is ZERO-BASED: attempt 3 of 3 is the last one
  ])("attempt %i of %i → terminal=%s", async (attemptsMade, attempts, terminal) => {
    const { proc, transcribe } = spyService();
    await proc.process(makeJob({ attemptsMade, attempts }));
    expect(transcribe.mock.calls[0]![1]).toEqual({ terminal });
  });

  it("a queue configured with NO attempts treats the first failure as final", async () => {
    // `opts.attempts ?? 1` — without the default, `attemptsMade + 1 >= undefined` is false and
    // a queue that never retries would never write a terminal record at all.
    const { proc, transcribe } = spyService();
    await proc.process({ data: JOB, attemptsMade: 0, opts: {} } as never);
    expect(transcribe.mock.calls[0]![1]).toEqual({ terminal: true });
  });

  it("propagates the service's failure rather than swallowing it", async () => {
    // The rethrow is how BullMQ learns to retry. A processor that resolved on failure would
    // mark the job succeeded and drop the worker's audio silently.
    const transcribe = vi.fn().mockRejectedValue(new Error("transcription degraded: x"));
    const proc = new VoiceTranscriptionProcessor({ transcribe } as never);
    await expect(proc.process(makeJob())).rejects.toThrow("transcription degraded");
  });
});

describe("VoiceTranscriptionService — the ROW owns the audio, not the payload (#686)", () => {
  const OTHER_WORKER = "99999999-9999-4999-8999-999999999999";

  it("REFUSES a payload naming another worker: no provider call, no write, no event", async () => {
    // The IDOR the export opens up. Authorization lives in VoiceService today; the moment a
    // second (request-path) caller exists, a caller who can name someone else's
    // voice_note_id would otherwise have that audio fetched, billed to them, and the
    // transcript written onto a row of their choosing.
    const {
      service: svc,
      ai,
      voice,
      aiJobs,
      events,
    } = make({
      note: { ...ROW, workerId: OTHER_WORKER, transcriptText: null },
    });

    await expect(svc.transcribe(JOB, { terminal: true })).rejects.toThrow(/does not belong/i);

    expect(ai.transcribe).not.toHaveBeenCalled(); // nothing fetched, nothing billed
    expect(voice.setTranscript).not.toHaveBeenCalled(); // nothing written
    expect(aiJobs.markRunning).not.toHaveBeenCalled();
    // The guard sits BEFORE the try, so a refused call must not stamp a terminal
    // failure onto a job it was never entitled to touch.
    expect(aiJobs.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("the refusal message names no ids — it must not confirm whose note it is", async () => {
    const { service: svc } = make({
      note: { ...ROW, workerId: OTHER_WORKER, transcriptText: null },
    });

    const err = await svc.transcribe(JOB, { terminal: true }).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : String(err);

    expect(message).not.toContain(OTHER_WORKER);
    expect(message).not.toContain(JOB.voiceNoteId);
    expect(message).not.toContain(JOB.storagePath);
  });

  it("a missing row fails closed rather than transcribing the payload's path", async () => {
    const { service: svc, ai } = make({ note: null as never });

    await expect(svc.transcribe(JOB, { terminal: true })).rejects.toThrow(/not found/i);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it("reads storage_path, duration and worker_ref from the ROW, ignoring the payload", async () => {
    // A payload that disagrees with the row on everything EXCEPT the owner — the guard
    // passes, and the provider call must still be driven entirely by the row.
    const { service: svc, ai } = make({
      note: {
        ...ROW,
        storagePath: "worker/sess/REAL.ogg",
        durationSeconds: 7,
        transcriptText: null,
      },
    });

    await svc.transcribe(
      { ...JOB, storagePath: "attacker/OTHER.ogg", durationSeconds: 999 },
      { terminal: false },
    );

    expect(ai.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        storage_path: "worker/sess/REAL.ogg",
        duration_seconds: 7,
        worker_ref: JOB.workerId,
      }),
      // BL-19: the job's own correlation/request id, threaded to the ai-service call.
      { correlationId: JOB.correlationId, requestId: JOB.requestId },
    );
  });

  it("still transcribes normally when the payload agrees with the row", async () => {
    // The guard must not break the queue path, whose payload is built from the row anyway.
    const { service: svc, ai, voice } = make();

    await svc.transcribe(JOB, { terminal: false });

    expect(ai.transcribe).toHaveBeenCalledTimes(1);
    expect(voice.setTranscript).toHaveBeenCalledWith(
      JOB.voiceNoteId,
      MOCK_TRANSCRIPT,
      0.9,
      MOCK_ENGLISH,
    );
  });
});

describe("transcribeNow — the voice form's synchronous leg", () => {
  const CTX = { correlationId: "c", requestId: "r" };
  const now = (overrides: Record<string, unknown> = {}) => ({
    voiceNoteId: JOB.voiceNoteId,
    workerId: JOB.workerId,
    maxSeconds: 30,
    ctx: CTX,
    ...overrides,
  });

  it("asks for NO English translation — the form wants the worker's own Hinglish", async () => {
    // Two reasons, and the second is money. The capture layer — the city gazetteer, the yes/no
    // lexicon, the chip labels — is written against what the worker actually says. And the
    // translate leg is a REAL Sarvam call on no ledger at all (`translate.py` imports no cost
    // tracker and takes no worker ref), so every one of them is spend nothing records: R9.
    const { service, ai } = make();

    await service.transcribeNow(now());

    expect(ai.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ translate_to_english: false }),
      CTX,
    );
  });

  it("leaves the QUEUE path's call byte-identical — chat's response must not change", async () => {
    // `GET /voice/:id` returns `transcript_english` to a shipped client. Flipping the default
    // globally is a product decision; setting it for one surface is not.
    const { proc, ai } = make();

    await proc.process(makeJob());

    expect(ai.transcribe).toHaveBeenCalledWith(
      expect.not.objectContaining({ translate_to_english: expect.anything() }),
      { correlationId: JOB.correlationId, requestId: JOB.requestId },
    );
  });

  it("refuses a clip longer than the cap BEFORE paying for it", async () => {
    // The cap is what keeps this on Sarvam's single synchronous call. A longer clip is not
    // "slower" — it is the chunked path, with a different cost and a multi-minute ceiling.
    const { service, ai } = make({
      note: {
        id: JOB.voiceNoteId,
        workerId: JOB.workerId,
        storagePath: JOB.storagePath,
        durationSeconds: 47,
        transcriptText: null,
      },
    });

    await expect(service.transcribeNow(now())).rejects.toBeInstanceOf(BadRequestException);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it("404s on another worker's clip, without an existence oracle", async () => {
    const { service, ai } = make();

    await expect(
      service.transcribeNow(now({ workerId: "99999999-9999-4999-8999-999999999999" })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ai.transcribe).not.toHaveBeenCalled();
  });

  it("REPORTS a degraded transcription instead of throwing — the caller is answering a worker", async () => {
    const { service } = make({ errorCode: "stt_budget_blocked" });

    await expect(service.transcribeNow(now())).resolves.toEqual({
      ok: false,
      errorCode: "stt_budget_blocked",
    });
  });

  it("returns the transcript READ BACK FROM THE ROW, which is what every other reader sees", async () => {
    const { service, voice } = make();
    const pending = {
      id: JOB.voiceNoteId,
      workerId: JOB.workerId,
      storagePath: JOB.storagePath,
      durationSeconds: 6,
      transcriptText: null,
    };
    // THREE reads, and naming them is the point: `transcribeNow`'s own ownership + cap guard,
    // then `transcribe`'s independent guard (the row is the authority on whose audio this is,
    // never the payload), then the read-back AFTER the transcript has been persisted.
    voice.findById
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        id: JOB.voiceNoteId,
        workerId: JOB.workerId,
        storagePath: JOB.storagePath,
        durationSeconds: 6,
        transcriptText: MOCK_TRANSCRIPT,
      });

    await expect(service.transcribeNow(now())).resolves.toEqual({
      ok: true,
      text: MOCK_TRANSCRIPT,
      durationSeconds: 6,
    });
  });

  it("REFUSES a mock transcript rather than storing it as the worker's answer (#1246)", async () => {
    // THE DEFECT THIS PINS. On the mock path the adapter returns a canned, plausible Hinglish
    // sentence with `is_mock: true` and NO `error_code` — so the degraded-result check passes it
    // and it was stored as the worker's words, copied into `chat_messages` at flush, and fed to
    // extraction. Mock is the DEFAULT posture (`AI_ENABLE_REAL_CALLS=false`), so this gave every
    // worker on this surface the same fabricated trade and the same four years of experience.
    //
    // It must NOT be reported as success-with-canned-text, and it must NOT be silently empty:
    // the worker is told their answer did not arrive so they can record it again.
    const { service, voice } = make({ isMock: true });
    const pending = {
      id: JOB.voiceNoteId,
      workerId: JOB.workerId,
      storagePath: JOB.storagePath,
      durationSeconds: 6,
      transcriptText: null,
    };
    voice.findById.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending);

    await expect(service.transcribeNow(now())).resolves.toEqual({
      ok: false,
      errorCode: "stt_mock_transcript",
    });
    // The fabrication never reaches the row, which is what every other reader sees.
    expect(voice.setTranscript).not.toHaveBeenCalled();
  });

  it("still accepts a mock on the QUEUE path — that is the documented staging handset check", async () => {
    // `rejectMock` is opt-in per caller. The chat voice-note route exercises the pipeline
    // end-to-end without a provider on purpose (infra/supabase/storage-buckets.md), so a
    // blanket refusal would break the G2 exit criteria rather than fix anything.
    const { service, voice } = make({ isMock: true });
    await expect(
      service.transcribe(JOB, { terminal: true }),
    ).resolves.toEqual({ voice_note_id: JOB.voiceNoteId });
    expect(voice.setTranscript).toHaveBeenCalled();
  });
});

/**
 * STT SPEND HAS TO REACH THE COST HISTORY (#738).
 *
 * Before this, `recordAiCost` was a private method on `ProfileExtractionProcessor` and nothing on
 * the transcription path could reach it, while `aiTaskType` already listed `stt_transcription`.
 * The result was the worst available shape: querying the events table for STT cost returned empty
 * and read as "no spend" rather than "not instrumented", with the money bounded only by a Redis
 * limiter whose keys expire ~25h after the day they describe.
 */
describe("STT cost recording", () => {
  /** What the ai-service returns for a real, billed Sarvam call. Cost is per CALL, not tokens. */
  const REAL_META = {
    ai_call_id: "55555555-5555-4555-8555-555555555555",
    task_type: "stt_transcription",
    model_name: "saarika:v2.5",
    provider: "sarvam",
    real_call: true,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_inr: 0.25,
    latency_ms: 1200,
    success: true,
    error_code: null,
    cost_alert: false,
    above_target: false,
    attempt_count: 1,
    candidates_tried: [],
    failure_reason: null,
    created_at: "2026-08-10T00:00:00.000Z",
  };

  /** The shape this suite actually reads off `events.emit`. */
  type Emitted = {
    event_name: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  };

  const costEvents = (events: { emit: { mock: { calls: unknown[][] } } }): Emitted[] =>
    events.emit.mock.calls
      .map((c) => c[0] as Emitted)
      .filter((e) => e.event_name === "ai.cost_recorded");

  it("a real call emits ai.cost_recorded as stt_transcription, keyed on the CALL not the job", async () => {
    const { proc, events } = make({ aiMetadata: REAL_META });
    await proc.process(makeJob());

    const [cost] = costEvents(events as never);
    expect(cost).toBeDefined();
    expect(cost!.payload.task_type).toBe("stt_transcription");
    expect(cost!.payload.estimated_cost_inr).toBe(0.25);
    expect(cost!.payload.real_call).toBe(true);
    expect(cost!.payload.provider).toBe("sarvam");
    // One job can make several billable calls; a per-job key deduped the later ones away.
    expect(cost!.idempotencyKey).toBe(`ai.cost_recorded:${REAL_META.ai_call_id}`);
  });

  it("the mock path emits NO cost event — a mocked environment must not write fictional money", async () => {
    // `ai_metadata` is null on the mock path, which is also what an ai-service predating the
    // field returns. Both mean "no real call to record".
    const { proc, events } = make();
    await proc.process(makeJob());
    expect(costEvents(events as never)).toHaveLength(0);
  });

  it("a call that FAILED PART-WAY still records what it spent", async () => {
    // The adapter bills for chunks that returned before the failure and reports `real_call` from
    // the money rather than from `is_mock`. The degraded-result throw happens after this emit ON
    // PURPOSE — putting the record after it would drop exactly this spend.
    const { proc, events } = make({
      errorCode: "stt_call_failed",
      aiMetadata: {
        ...REAL_META,
        success: false,
        error_code: "stt_call_failed",
        estimated_cost_inr: 0.5,
      },
    });
    await expect(proc.process(makeJob({ attemptsMade: 2, attempts: 3 }))).rejects.toThrow();

    const [cost] = costEvents(events as never);
    expect(cost).toBeDefined();
    expect(cost!.payload.estimated_cost_inr).toBe(0.5);
    expect(cost!.payload.task_type).toBe("stt_transcription");
  });

  it("privacy: the cost event carries no transcript", async () => {
    const { proc, events } = make({ aiMetadata: REAL_META });
    await proc.process(makeJob());
    const dump = JSON.stringify(costEvents(events as never));
    expect(dump).not.toContain(MOCK_TRANSCRIPT);
    expect(dump).not.toContain(MOCK_ENGLISH);
  });

  it("the cost event names the WORKER and the SESSION, both taken from the row", async () => {
    // Both ids come from `voice_notes`, not from the job payload — the same authority the
    // ownership guard uses, so a caller that named someone else's worker id cannot also
    // misfile the spend. `session_id` makes a voice-led interview's STT land on the same
    // per-session total as its model turns, which is what "cost per profile" means.
    const { proc, events } = make({ aiMetadata: REAL_META });
    await proc.process(makeJob());
    const [cost] = costEvents(events as never);
    expect(cost!.payload.worker_id).toBe(JOB.workerId);
    expect(cost!.payload.session_id).toBe(SESSION_ID);
  });

  it("a real call now populates ai_jobs usage/cost — it stayed NULL for every STT job", async () => {
    // THE HOLE THIS CLOSES. `markCompleted` has taken an optional `usage` since extraction
    // needed it; the transcription call site passed none, so `ai_jobs.cost_inr` was NULL for
    // `job_type = 'transcription'` forever — while the very same call's cost was on the event
    // spine. A per-job cost query answered "free" for the whole STT surface.
    const { proc, aiJobs } = make({ aiMetadata: REAL_META });
    await proc.process(makeJob());
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(
      JOB.aiJobId,
      { voice_note_id: JOB.voiceNoteId },
      {
        modelName: REAL_META.model_name,
        realCall: true,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costInr: 0.25,
      },
    );
  });

  it("a real call accrues EXACTLY ONE running total, on the emit's own transaction", async () => {
    // The accrual is bound to the event insert actually writing a row — see `AiCostRecorder`.
    // The fake throws if `accrue` arrives on any handle other than the one `withTransaction`
    // handed out, so this also proves the two writes share a transaction.
    const { proc, totals } = make({ aiMetadata: REAL_META });
    await proc.process(makeJob());
    expect(totals.accrued).toEqual([
      {
        workerId: JOB.workerId,
        sessionId: SESSION_ID,
        provider: "sarvam",
        taskType: "stt_transcription",
        costInr: 0.25,
        realCall: true,
      },
    ]);
  });

  it("the mock path accrues NOTHING — no metadata, no money, no row", async () => {
    const { proc, totals } = make();
    await proc.process(makeJob());
    expect(totals.accrued).toHaveLength(0);
    expect(totals.transactions).toBe(0);
  });
});
