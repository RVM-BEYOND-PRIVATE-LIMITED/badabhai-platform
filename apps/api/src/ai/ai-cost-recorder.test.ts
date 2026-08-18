import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { AICallMetadata } from "@badabhai/ai-contracts";
import { validateEvent } from "@badabhai/event-schema";

import { AiCostRecorder } from "./ai-cost-recorder.service";
import { fakeAiCostTotals, FAKE_TX } from "./ai-cost-totals.fake";

/**
 * `AiCostRecorder` — the one emitter, and now the one WRITER of the running totals.
 *
 * WHAT MAKES THIS SUITE NECESSARY RATHER THAN NICE. This service swallows every failure by
 * design: cost observability must not be able to fail the transcription or extraction it
 * observes. That means a recorder that silently accrued nothing, accrued twice on a redelivery,
 * or accrued off a different transaction than the event would produce EXACTLY the same
 * behaviour from every caller's point of view — no exception, no failed request, just numbers
 * that are quietly wrong. Silence is the failure mode, so the guard has to be direct.
 */

const CALL_ID = "55555555-5555-4555-8555-555555555555";
const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CORRELATION = "44444444-4444-4444-8444-444444444444";

const META: AICallMetadata = {
  ai_call_id: CALL_ID,
  task_type: "profiling_chat_turn",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 897,
  output_tokens: 112,
  estimated_cost_inr: 0.157,
  latency_ms: 2863,
  success: true,
  error_code: null,
  failure_reason: null,
  cost_alert: false,
  above_target: false,
  created_at: "2026-08-18T05:04:02.270Z",
} as unknown as AICallMetadata;

/**
 * @param written what the events table reports: `true` = a row was inserted, `false` = the
 * idempotency key deduped it (an at-least-once redelivery of the same `ai_call_id`).
 */
function make(opts: { written?: boolean; emitThrows?: boolean } = {}) {
  const emitOnce = opts.emitThrows
    ? vi.fn().mockRejectedValue(new Error("events table unreachable"))
    : vi.fn(async (params: { payload: unknown; tx: unknown }) => ({
        event: params,
        written: opts.written ?? true,
      }));
  const events = { emit: vi.fn(), emitOnce };
  const totals = fakeAiCostTotals();
  return { rec: new AiCostRecorder(events as never, totals.repo), events, totals, emitOnce };
}

/** The payload as it reached `emitOnce` on call `n`. */
function payloadOf(emitOnce: { mock: { calls: unknown[][] } }, n = 0): Record<string, unknown> {
  return (emitOnce.mock.calls[n]![0] as { payload: Record<string, unknown> }).payload;
}

describe("AiCostRecorder — attribution on the event", () => {
  it("puts the caller's worker_id + session_id on the payload", async () => {
    const { rec, emitOnce } = make();
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    const payload = payloadOf(emitOnce);
    expect(payload.worker_id).toBe(WORKER);
    expect(payload.session_id).toBe(SESSION);
    // The whole reason the fields exist: this surface has NO ai_jobs row to join through.
    expect(payload.ai_job_id).toBeNull();
  });

  it("defaults BOTH to null when the caller passes no attribution at all", async () => {
    // The payer-side surfaces (`skill_embedding` on a posting write, `job_posting_chat_turn`)
    // call with five arguments and genuinely have no worker. Nulls, never omitted keys — the
    // ledger query stays one shape.
    const { rec, emitOnce } = make();
    await rec.record(META, "skill_embedding", null, CORRELATION, "req-1");
    const payload = payloadOf(emitOnce);
    expect(payload.worker_id).toBeNull();
    expect(payload.session_id).toBeNull();
  });

  it("emits an event that the registry actually accepts", async () => {
    // Guards against a payload that this file's own fakes are happy with and the real
    // `createEvent` would reject — the emit is inside a try/catch, so a schema failure here
    // would be a warning nobody reads rather than a test failure.
    const { rec, emitOnce } = make();
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    const sent = emitOnce.mock.calls[0]![0] as { payload: Record<string, unknown> };
    const result = validateEvent({
      event_id: CALL_ID,
      event_name: "ai.cost_recorded",
      event_version: 1,
      occurred_at: "2026-08-18T05:04:02.270Z",
      actor: { actor_type: "ai_service", actor_id: null },
      subject: { subject_type: "ai_job", subject_id: null },
      correlation_id: CORRELATION,
      causation_id: null,
      source: "api",
      metadata: { environment: "test", service: "api", request_id: "req-1" },
      payload: sent.payload,
    });
    expect(result.success).toBe(true);
  });

  it("§2: the payload carries ids and numbers only — nothing a worker said", async () => {
    const { rec, emitOnce } = make();
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    const keys = Object.keys(payloadOf(emitOnce)).sort();
    // PINNED, not "does not contain a name". A closed key list is what fails when someone adds
    // `prompt`, `reply_text` or `worker_name` "just for debugging" — an allow-list cannot be
    // satisfied by a value that merely looks harmless in one test fixture.
    expect(keys).toEqual([
      "above_target",
      "ai_call_id",
      "ai_job_id",
      "cost_alert",
      "error_code",
      "estimated_cost_inr",
      "failure_reason",
      "latency_ms",
      "model",
      "provider",
      "real_call",
      "session_id",
      "success",
      "task_type",
      "tokens_in",
      "tokens_out",
      "worker_id",
    ]);
  });
});

describe("AiCostRecorder — the running totals", () => {
  it("accrues exactly once for a call whose event was written", async () => {
    const { rec, totals } = make({ written: true });
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    expect(totals.accrued).toEqual([
      {
        workerId: WORKER,
        sessionId: SESSION,
        provider: "anthropic",
        taskType: "profiling_chat_turn",
        costInr: 0.157,
        realCall: true,
      },
    ]);
  });

  it("accrues NOTHING when the event was deduped — a redelivery must not double-count", async () => {
    // THE DEFECT THIS LOCKS. BullMQ redelivers a stalled job; the handler re-runs and re-emits
    // the same `ai_call_id`. The events table's `ON CONFLICT DO NOTHING` stores nothing, so
    // the money is already counted — and a total incremented on "we reached this line" would
    // charge the same rupees again, every retry, forever.
    const { rec, totals } = make({ written: false });
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    expect(totals.accrued).toHaveLength(0);
    // The transaction still opened — the dedupe is decided by the insert, not before it.
    expect(totals.transactions).toBe(1);
  });

  it("N distinct calls accrue N times — the fan-out is not collapsed", async () => {
    // A 3-skill posting is 3 embeds. Recording once per write would under-report the surface
    // by an order of magnitude, which is why the event is keyed on `ai_call_id`.
    const { rec, totals } = make();
    for (const id of [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    ]) {
      await rec.record(
        { ...META, ai_call_id: id, estimated_cost_inr: 0.5 },
        "skill_embedding",
        null,
        CORRELATION,
        "req-1",
      );
    }
    expect(totals.accrued).toHaveLength(3);
    expect(totals.accrued.reduce((sum, a) => sum + a.costInr, 0)).toBeCloseTo(1.5, 10);
  });

  it("accrues in a SAVEPOINT on the transaction the event insert rode", async () => {
    // The fake throws if the savepoint is opened on any other handle, or if `accrue` arrives
    // on anything but that savepoint. Both halves matter: same transaction is why a successful
    // total cannot disagree with its ledger row, and the savepoint is why a FAILED total
    // cannot delete that ledger row (see ai-cost-recorder.atomicity.test.ts).
    const { rec, emitOnce, totals } = make();
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });
    expect((emitOnce.mock.calls[0]![0] as { tx: unknown }).tx).toBe(FAKE_TX);
    expect(totals.transactions).toBe(1);
    expect(totals.savepoints).toBe(1);
    expect(totals.accrued).toHaveLength(1);
  });

  it("records nothing at all — no event, no total, no transaction — on null metadata", async () => {
    // The mock posture, a tripped spend cap, an unreachable ai-service. No call, no money.
    const { rec, totals, emitOnce } = make();
    await rec.record(null, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });
    expect(emitOnce).not.toHaveBeenCalled();
    expect(totals.transactions).toBe(0);
  });

  it("defaults an unlabelled provider to the SAME literal the payload uses", async () => {
    // Otherwise the totals table drops a call the event counted, and the two disagree about
    // spend nobody labelled — the worst kind of discrepancy to debug later.
    const { rec, totals, emitOnce } = make();
    await rec.record({ ...META, provider: "" }, "profile_parse", null, CORRELATION, "req-1");
    expect(payloadOf(emitOnce).provider).toBe("unknown");
    expect(totals.accrued[0]!.provider).toBe("unknown");
  });
});

describe("AiCostRecorder — it never fails the work it observes", () => {
  it("swallows a failed emit and accrues nothing", async () => {
    const { rec, totals } = make({ emitThrows: true });
    await expect(
      rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", { workerId: WORKER }),
    ).resolves.toBeUndefined();
    expect(totals.accrued).toHaveLength(0);
  });

  it("swallows a failed TOTALS write — a cost row must not take an interview down", async () => {
    // …and the event does NOT roll back with it: the accrual runs in a savepoint, so a totals
    // failure costs the derived number and leaves the ledger row committed. That the ROW
    // survives is a transaction property, proved in ai-cost-recorder.atomicity.test.ts; what
    // this asserts is the caller-visible half — no throw, and nothing accrued.
    const { rec, totals } = make();
    totals.failNext = true;
    await expect(
      rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", { workerId: WORKER }),
    ).resolves.toBeUndefined();
    expect(totals.accrued).toHaveLength(0);
    expect(totals.savepoints).toBe(1);
  });

  it("a failed totals write does not stop the NEXT call from accruing", async () => {
    // The degraded path must be per-call, not sticky: one FK violation or lock timeout may
    // cost one call's total, never the rest of the process's.
    const { rec, totals } = make();
    totals.failNext = true;
    await rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });
    totals.failNext = false;
    await rec.record(
      { ...META, ai_call_id: "66666666-6666-4666-8666-666666666666" },
      "profiling_chat_turn",
      null,
      CORRELATION,
      "req-2",
      { workerId: WORKER },
    );
    expect(totals.accrued).toHaveLength(1);
  });
});
