import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { AICallMetadata } from "@badabhai/ai-contracts";

import { AiTraceRecorder } from "./ai-trace-recorder.service";
import type { AiTraceInsert, AiTracesRepository } from "./ai-traces.repository";

/**
 * `AiTraceRecorder` — the writer of `ai_call_traces` (migration 0083).
 *
 * ── THE PROPERTIES WORTH TESTING HERE ARE THE ONES THAT FAIL SILENTLY ───────────────────
 * This class swallows every error by design, so nothing about it announces itself when it goes
 * wrong. A recorder that stored plaintext, attributed a payer's turn to a worker, or threw into
 * an interview turn would all be discovered the same way — much later, by someone else. So each
 * case below pins one of those, against the real class rather than a stub.
 */

const AI_CALL_ID = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

const meta = (over: Partial<AICallMetadata> = {}): AICallMetadata =>
  ({
    ai_call_id: AI_CALL_ID,
    task_type: "profiling_chat_turn",
    model_name: "gemini-2.5-flash",
    provider: "google",
    real_call: true,
    input_tokens: 10,
    output_tokens: 20,
    estimated_cost_inr: 0.5,
    latency_ms: 900,
    success: true,
    error_code: null,
    cost_alert: false,
    above_target: false,
    attempt_count: 1,
    candidates_tried: [],
    failure_reason: null,
    // THE TEXT LIVES HERE NOW, and every assertion below reads it from here rather than from a
    // call-site thunk — because that is the only place the recorder will take it from. See
    // `AiTraceText`: the thunk is what put a worker's raw name, phone and address into
    // `prompt_enc`, and removing it is the fix, so the tests must not keep one alive.
    prompt_text: null,
    response_text: null,
    created_at: new Date().toISOString(),
    ...over,
  }) as AICallMetadata;

/** `meta()` carrying the ai-service's masked prompt/completion pair. */
const withText = (prompt: string | null, response: string | null, over: Partial<AICallMetadata> = {}) =>
  meta({ prompt_text: prompt, response_text: response, ...over });

/**
 * A recorder over an in-memory repository and a crypto double.
 *
 * The crypto double PREFIXES rather than no-ops, so "the repository received a token" and "the
 * repository received the plaintext" are distinguishable. A pass-through stub would make the
 * central privacy assertion below pass against a recorder that never encrypted anything.
 */
function make(over: { insertThrows?: boolean; deduped?: boolean; encryptThrows?: boolean } = {}) {
  const inserted: AiTraceInsert[] = [];
  const insert = vi.fn(async (row: AiTraceInsert) => {
    if (over.insertThrows) throw new Error("relation \"ai_call_traces\" does not exist");
    inserted.push(row);
    return !over.deduped;
  });
  const encrypt = vi.fn((plaintext: string) => {
    if (over.encryptThrows) throw new Error("no key");
    return `enc(${plaintext})`;
  });
  const recorder = new AiTraceRecorder(
    { insert } as unknown as AiTracesRepository,
    { encrypt } as never,
  );
  return { recorder, inserted, insert, encrypt };
}

describe("rule 1 — no metadata, no trace", () => {
  it("does not insert when there was no call to describe (unreachable / off-contract)", async () => {
    const { recorder, insert } = make();
    await recorder.capture(null, "profiling_chat_turn", null, CORRELATION, {
      workerId: WORKER,
    });
    expect(insert).not.toHaveBeenCalled();
    // ...and it is NOT counted as a drop. A drop means "we had a call and refused to store it";
    // this means "there was no call". Conflating them would make the drop counter useless as the
    // thing it exists to be — a measure of the telemetry gap the NOT NULL worker_id creates.
    expect(recorder.droppedCount).toBe(0);
  });

  it("DOES fire on a mocked call, because the mock posture still returns metadata", async () => {
    // The comment this replaces claimed rule 1 fires "on EVERY call in the default mock posture".
    // It does not: `apps/ai-service/app/ai/router.py` builds `AICallMetadata` on its terminal
    // path unconditionally (`real_call=False, success=True`), so a mocked call comes back WITH
    // metadata and IS traced — measured against the real service on `/profile/extract`. Pinning
    // it here means the next reader of the rule reads what happens, not what was assumed.
    const { recorder, inserted } = make();
    await recorder.capture(withText("ask", "reply", { real_call: false }), "profile_extraction",
      null, CORRELATION, { workerId: WORKER });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.realCall).toBe(false);
  });
});

describe("rule 2 — an unattributable call is DROPPED, and counted", () => {
  it("stores nothing when there is no worker (the payer surfaces)", async () => {
    // The DSAR design, at the writer. `ai_call_traces.worker_id` is NOT NULL because the cascade
    // from `workers` IS the erasure coverage; a faceless row would be prompt text that survives a
    // deletion request forever. Losing an unattributable trace is a telemetry gap. Keeping one is
    // an un-erasable record of somebody's words.
    const { recorder, insert } = make();
    await recorder.capture(withText("phrase", "id"), "skill_embedding", null, CORRELATION);
    expect(insert).not.toHaveBeenCalled();
    expect(recorder.droppedCount).toBe(1);
  });

  it("counts every drop, so the gap is a number rather than a silence", async () => {
    const { recorder } = make();
    for (let i = 0; i < 5; i += 1) {
      await recorder.capture(withText("a", "b"), "job_posting_chat_turn", null, CORRELATION);
    }
    expect(recorder.droppedCount).toBe(5);
  });

  it("logs the drop WITHOUT any text, and not once per call", async () => {
    // A line per drop would be a permanent, high-volume log of the system working correctly —
    // `skill_embedding` fans out one call per skill phrase on every posting write — which is how
    // a real signal ends up filtered out. The schedule is 1, 10, 100…
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { recorder } = make();
      for (let i = 0; i < 12; i += 1) {
        await recorder.capture(withText("SECRET", "S2"), "skill_embedding", null, CORRELATION);
      }
      expect(log).toHaveBeenCalledTimes(2); // the 1st and the 10th
      const lines = log.mock.calls.map((c) => String(c[0]));
      for (const line of lines) {
        expect(line).not.toContain("SECRET");
        expect(line).not.toContain(WORKER);
        expect(line).toContain("skill_embedding");
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("rule 3 — what actually reaches the repository", () => {
  it("hands over CIPHERTEXT, never the plaintext", async () => {
    // The single most important assertion in this file. The column has a CHECK that refuses
    // prose, so a recorder that skipped the encrypt would fail every insert with 23514 — and
    // this class catches, so the only symptom would be a table that stays empty.
    const { recorder, inserted } = make();
    await recorder.capture(withText("ASK", "REPLY"), "profiling_chat_turn", JOB, CORRELATION, {
      workerId: WORKER,
      sessionId: SESSION,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.promptEnc).toBe("enc(ASK)");
    expect(inserted[0]!.responseEnc).toBe("enc(REPLY)");
    // No field on the row carries the plaintext under another name.
    expect(JSON.stringify(inserted[0])).not.toMatch(/"ASK"|"REPLY"/);
  });

  it("counts CHARACTERS of the PLAINTEXT, before encryption", async () => {
    // Measured after encryption these would be base64 lengths, which describe our storage rather
    // than the call — and `prompt_chars` is what the ungated list serves so a size question can
    // be answered without decrypting anything.
    const { recorder, inserted } = make();
    await recorder.capture(withText("abcde", "xy"), "profile_parse", null, CORRELATION, {
      workerId: WORKER,
    });
    expect(inserted[0]!.promptChars).toBe(5);
    expect(inserted[0]!.responseChars).toBe(2);
  });

  it("counts CODE POINTS, not UTF-16 units — the number Postgres would report", async () => {
    // Postgres `char_length` counts code points; JS `.length` counts UTF-16 code units, so one
    // astral character (an emoji) is 1 to Postgres and 2 to `.length`. The two agree for all of
    // Hindi and all of Latin, so this only ever shows up on emoji — and a length that is off by
    // a factor for some inputs is a worse number than one that is simply correct.
    //
    // The character is written as an ESCAPE rather than pasted, so the assertion cannot be
    // quietly defeated by an editor, a lint autofix or a pipe that normalises the file's bytes.
    const emoji = "a\u{1F600}b"; // 3 code points, 4 UTF-16 units
    expect(emoji.length).toBe(4);
    const { recorder, inserted } = make();
    await recorder.capture(withText(emoji, null), "profile_parse", null, CORRELATION, {
      workerId: WORKER,
    });
    expect(inserted[0]!.promptChars).toBe(3);
    expect(inserted[0]!.responseChars).toBeNull();
  });

  it("passes the ids through unchanged and defaults prompt_name/version to null", async () => {
    const { recorder, inserted } = make();
    await recorder.capture(withText("a", "b"), "stt_transcription", JOB, CORRELATION, {
      workerId: WORKER,
      sessionId: SESSION,
    });
    expect(inserted[0]).toMatchObject({
      aiCallId: AI_CALL_ID,
      workerId: WORKER,
      sessionId: SESSION,
      aiJobId: JOB,
      correlationId: CORRELATION,
      taskType: "stt_transcription",
      modelName: "gemini-2.5-flash",
      realCall: true,
      success: true,
      // The ai-service owns the template and returns neither on the wire. Null is the honest
      // value; inventing one would answer "which prompt wrote this?" wrongly.
      promptName: null,
      promptVersion: null,
      errorCode: null,
    });
  });

  it("turns an EMPTY model name into null, because the CHECK refuses an empty string", async () => {
    // `AICallMetadata.model_name` is `z.string()` with no `.min(1)`, and the column's CHECK is
    // `BETWEEN 1 AND 128`. `?? null` would have left `""` in place and made every unlabelled
    // call a 23514 — a whole class of traces silently lost to a nullish-coalescing operator.
    const { recorder, inserted } = make();
    await recorder.capture(withText("a", "b", { model_name: "" }), "profile_parse", null,
      CORRELATION, { workerId: WORKER });
    expect(inserted[0]!.modelName).toBeNull();
  });

  it("turns an EMPTY correlation id into null, for the SAME reason and a bigger loss", async () => {
    // `ProfileExtractionProcessor` passes `job.correlationId ?? ""` at both of its queue-driven
    // call sites, and `correlation_id`'s CHECK is `BETWEEN 1 AND 128`. `""` fails it with 23514 —
    // and because the insert is ONE statement, that does not lose the correlation id, it loses the
    // WHOLE ROW: the `profile_parse` and Phase-C `profile_extraction` traces, the two the
    // processor's own comments call the most valuable in the system. Confirmed against a live
    // Postgres before the fix: `correlation_id = ''` → SQLSTATE 23514, zero rows, failedCount 1.
    const { recorder, inserted } = make();
    await recorder.capture(withText("a", "b"), "profile_parse", null, "", { workerId: WORKER });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.correlationId).toBeNull();
    expect(recorder.failedCount).toBe(0);
  });

  it("truncates an over-long correlation id to the column's 128-char bound", async () => {
    const { recorder, inserted } = make();
    await recorder.capture(withText("a", "b"), "profile_parse", null, "x".repeat(300), {
      workerId: WORKER,
    });
    expect(inserted[0]!.correlationId).toHaveLength(128);
  });
});

describe("the error code is a CLOSED SET, never a provider message", () => {
  const codeFor = async (over: Partial<AICallMetadata>) => {
    const { recorder, inserted } = make();
    await recorder.capture(withText("a", null, { success: false, ...over }), "profile_parse", null,
      CORRELATION, { workerId: WORKER });
    return inserted[0]!.errorCode;
  };

  it("keeps a code the allow-list knows", async () => {
    expect(await codeFor({ error_code: "daily_cap_exceeded" })).toBe("daily_cap_exceeded");
    expect(await codeFor({ error_code: "stt_call_failed" })).toBe("stt_call_failed");
  });

  it("DISCARDS anything else and substitutes a constant of our own", async () => {
    // The property that matters: an SDK exception message routinely echoes the request back, so
    // an unrecognised string is not a diagnostic — it is an unencrypted channel for prompt text
    // sitting beside the two columns this schema exists to encrypt. The signal kept is "it
    // failed on the far side"; the string is dropped.
    const leak = "Invalid request: Main Pune mein CNC operator hoon";
    expect(await codeFor({ error_code: leak })).toBe("provider_error");
    expect(await codeFor({ error_code: "TimeoutError" })).toBe("provider_error");
    expect(await codeFor({ error_code: "429 Too Many Requests" })).toBe("provider_error");
  });

  it("records a failure with NO code as unknown_error, not as null", async () => {
    // null on this column means "did not fail". "It failed and told us nothing" is a different,
    // real state, and collapsing the two would make `WHERE error_code IS NULL` a lie.
    expect(await codeFor({ error_code: null })).toBe("unknown_error");
    expect(await codeFor({ error_code: "" })).toBe("unknown_error");
  });

  it("records null on SUCCESS even when the metadata carries a stale code", async () => {
    const { recorder, inserted } = make();
    await recorder.capture(
      withText("a", "b", { success: true, error_code: "stt_call_failed" }),
      "stt_transcription",
      null,
      CORRELATION,
      { workerId: WORKER },
    );
    expect(inserted[0]!.errorCode).toBeNull();
  });
});

describe("rule 4 — best effort: nothing escapes into the caller", () => {
  it("does not throw when the INSERT fails (an unmigrated database)", async () => {
    // The apply-before-deploy window. Every AI call must still succeed; every trace is dropped.
    const { recorder } = make({ insertThrows: true });
    await expect(
      recorder.capture(withText("a", "b"), "profiling_chat_turn", null, CORRELATION, {
        workerId: WORKER,
      }),
    ).resolves.toBeUndefined();
    expect(recorder.failedCount).toBe(1);
  });

  it("does not throw when the ENCRYPT fails", async () => {
    const { recorder, insert } = make({ encryptThrows: true });
    await expect(
      recorder.capture(withText("a", "b"), "profiling_chat_turn", null, CORRELATION, {
        workerId: WORKER,
      }),
    ).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
    expect(recorder.failedCount).toBe(1);
  });

  it("stores NO TEXT rather than falling back to anything, when the service supplied none", async () => {
    // FAIL CLOSED TO NO TEXT, NEVER TO RAW TEXT. `AI_CALL_TRACE_TEXT_ENABLED` is default OFF,
    // and the surfaces that do not route through `AIRouter` (embeddings, STT, translate) never
    // populate these fields at all — so this is the ORDINARY case, not an edge one. The row is
    // still written, because its metadata answers real questions; it simply carries no words.
    const { recorder, inserted, encrypt } = make();
    await recorder.capture(meta(), "stt_transcription", JOB, CORRELATION, { workerId: WORKER });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.promptEnc).toBeNull();
    expect(inserted[0]!.responseEnc).toBeNull();
    expect(inserted[0]!.promptChars).toBeNull();
    expect(inserted[0]!.responseChars).toBeNull();
    // Nothing was encrypted, which is the difference between "no text" and "the empty string".
    expect(encrypt).not.toHaveBeenCalled();
    expect(recorder.failedCount).toBe(0);
  });

  it("does not throw on a DEDUPED write (the retry path is not an error)", async () => {
    // A redelivered BullMQ job reaches the recorder again as a matter of routine. `ON CONFLICT DO
    // NOTHING` reports "stored nothing", which is the correct outcome and must not be counted as
    // a failure — a retry storm would otherwise look identical to a broken recorder.
    const { recorder } = make({ deduped: true });
    await expect(
      recorder.capture(withText("a", "b"), "profiling_chat_turn", null, CORRELATION, {
        workerId: WORKER,
      }),
    ).resolves.toBeUndefined();
    expect(recorder.failedCount).toBe(0);
  });

  it("logs a failure WITHOUT the text, and not once per call", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { recorder } = make({ insertThrows: true });
      for (let i = 0; i < 12; i += 1) {
        await recorder.capture(withText("SECRET", "S2"), "profile_parse", null, CORRELATION, {
          workerId: WORKER,
        });
      }
      expect(warn).toHaveBeenCalledTimes(2); // the 1st and the 10th
      for (const call of warn.mock.calls) {
        const line = String(call[0]);
        expect(line).not.toContain("SECRET");
        expect(line).not.toContain(WORKER);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
