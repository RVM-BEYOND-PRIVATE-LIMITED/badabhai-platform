import type { AICallMetadata } from "@badabhai/ai-contracts";
import type { AiCostTaskType } from "@badabhai/event-schema";

import type {
  AiTraceAttribution,
  AiTraceRecorder,
  AiTraceText,
} from "./ai-trace-recorder.service";

/**
 * One `capture` call, as the fake saw it.
 *
 * `outcome` is what the REAL recorder would have done with it, not a flag the caller passed —
 * see {@link fakeAiTraceRecorder} for why the fake reproduces that decision instead of recording
 * every call identically.
 */
export interface CapturedTrace {
  readonly meta: AICallMetadata | null;
  readonly taskType: AiCostTaskType;
  readonly aiJobId: string | null;
  readonly correlationId: string;
  readonly attribution: AiTraceAttribution;
  /** `"stored"`, or why the trace was refused. */
  readonly outcome: "stored" | "no_metadata" | "no_worker";
  /**
   * The text the row would have carried — `null` unless `outcome` is `"stored"`.
   *
   * READ OFF `meta`, exactly as the real recorder reads it. It is deliberately NOT a value the
   * call site supplied: there is no longer any way for a call site to supply one, and this fake
   * must not be the last place in the codebase where it looks like there is.
   */
  readonly text: AiTraceText | null;
}

export interface FakeAiTraceRecorder {
  /** Every `capture` call, in order. The assertion surface. */
  readonly captured: CapturedTrace[];
  /** Only the ones that would actually have become a row. */
  readonly stored: CapturedTrace[];
  /** Only the ones refused for want of a worker id — the payer surfaces. */
  readonly dropped: CapturedTrace[];
  /** Pass this where an `AiTraceRecorder` is expected. */
  readonly recorder: AiTraceRecorder;
}

/**
 * An in-memory `AiTraceRecorder` for unit tests.
 *
 * NOT A NO-OP STUB, for the same reason `fakeAiCostTotals` is not: the real recorder swallows
 * every failure and drops every unattributable call by design, so a stub that accepted anything
 * would let a call site that traces nothing — or traces a payer's turn against a worker id —
 * pass every test in the suite. `captured` is what makes those assertable.
 *
 * ── IT REPRODUCES THE TWO SHORT-CIRCUITS, AND THAT IS THE POINT ─────────────────────────
 * `AiTraceRecorder.capture` discards a call with no metadata (rule 1) and a call with no worker
 * (rule 2) before it reads any text. A fake that reported text for those cases would report it
 * for the payer-side call sites, which store nothing — so a test asserting "the payer chat turn
 * traces the payer's words" would PASS against a production path that traces nothing at all.
 * Modelling the order is what keeps the two honest.
 *
 * ── WHAT THIS FAKE CANNOT SEE, STATED SO NOBODY TRUSTS IT TO ───────────────────────────
 * It reproduces rules 1 and 2 rather than delegating to them, so a regression IN the real
 * recorder's rules is invisible to every suite that uses this fake. `ai-trace-recorder.test.ts`
 * is the only thing standing behind the NOT NULL `worker_id` invariant, and the only thing
 * standing behind "the text comes off `meta`". Both were mutation-checked there; do not add a
 * privacy assertion here and believe it.
 *
 * Lives in `src/` beside its subject rather than in one test file so the six suites that build a
 * service with a recorder share ONE fake and cannot drift into six slightly different ones.
 */
export function fakeAiTraceRecorder(): FakeAiTraceRecorder {
  const captured: CapturedTrace[] = [];
  return {
    captured,
    get stored() {
      return captured.filter((c) => c.outcome === "stored");
    },
    get dropped() {
      return captured.filter((c) => c.outcome === "no_worker");
    },
    recorder: {
      async capture(
        meta: AICallMetadata | null,
        taskType: AiCostTaskType,
        aiJobId: string | null,
        correlationId: string,
        attribution: AiTraceAttribution = {},
      ): Promise<void> {
        const base = { meta, taskType, aiJobId, correlationId, attribution } as const;
        if (!meta) {
          captured.push({ ...base, outcome: "no_metadata", text: null });
          return;
        }
        if ((attribution.workerId ?? null) === null) {
          captured.push({ ...base, outcome: "no_worker", text: null });
          return;
        }
        captured.push({
          ...base,
          outcome: "stored",
          text: { prompt: meta.prompt_text ?? null, response: meta.response_text ?? null },
        });
      },
    } as unknown as AiTraceRecorder,
  };
}
