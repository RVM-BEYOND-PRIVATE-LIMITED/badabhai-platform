import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import type { CompanionModelLine } from "../companion-history.repository";
import type { HistoryRead } from "../companion-history.service";
import {
  CompanionSummaryService,
  companionSummaryTurnsOf,
  planCompanionFold,
} from "./companion-summary.service";

/**
 * #2297 (ADR-0056) — THE BADA BHAI CHAT'S ROLLING SUMMARY: when a fold runs and what it sends
 * (only the model-context lines that aged out of the reply's six-turn window, past the watermark),
 * what it stores (the API's validation of the model's notes, the ADR-0051 §8 rules), what it
 * records, and which summary the reply reads.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T10:00:00.000Z");
const JOB = {
  workerId: WORKER,
  correlationId: "33333333-3333-4333-8333-333333333333",
  requestId: "req-fold",
  at: NOW,
};
const NOTES = "- Worker asks about welding pay in Pune.";

const REAL_META = {
  ai_call_id: "call-summary",
  task_type: "profiling_free_summary",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 100,
  output_tokens: 30,
  estimated_cost_inr: 0.01,
  latency_ms: 400,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
};

/** `n` model-context lines, one second apart, ending a minute before NOW — oldest first. */
function lines(n: number): CompanionModelLine[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("worker" as const) : ("bada_bhai" as const),
    text: `line ${i}`,
    createdAt: new Date(NOW.getTime() - 60_000 - (n - i) * 1_000),
  }));
}

function setup(
  opts: {
    brain?: boolean;
    window?: HistoryRead<CompanionModelLine[]>;
    live?: HistoryRead<{ summary: string | null; foldedThrough: Date } | undefined>;
    out?: unknown;
    lock?: string | null;
    name?: string | null | "throws";
    profiling?: string | null;
  } = {},
) {
  const history = {
    liveSummary: vi.fn(async (..._args: unknown[]) => opts.live ?? { ok: true, value: undefined }),
    modelLines: vi.fn(async (..._args: unknown[]) => opts.window ?? { ok: true, value: lines(10) }),
    storeSummary: vi.fn(async (..._args: unknown[]) => true),
  };
  const profiling = { latestText: vi.fn(async () => opts.profiling ?? null) };
  const ai = {
    freeChatSummarize: vi.fn(async (..._args: unknown[]) =>
      "out" in opts ? opts.out : { summary: NOTES, ai_metadata: REAL_META },
    ),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const lock = {
    acquireCompanion: vi.fn(async () => (opts.lock === undefined ? "token" : opts.lock)),
    releaseCompanion: vi.fn(async () => undefined),
  };
  const names = {
    sourcesFor: vi.fn(() => ({
      knownName: async () => {
        if (opts.name === "throws") throw new Error("decrypt");
        return opts.name ?? null;
      },
      ownName: async () => null,
    })),
  };
  const config = {
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_FREE_CHAT_DISABLED: opts.brain === false,
  };
  const service = new CompanionSummaryService(
    config as never,
    history as never,
    profiling as never,
    ai as never,
    cost as never,
    events as never,
    lock as never,
    names as never,
  );
  const emitted = () =>
    events.emit.mock.calls.map(
      (c) => c[0] as { event_name: string; payload: Record<string, unknown> },
    );
  return { service, history, profiling, ai, cost, events, lock, names, emitted };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("planCompanionFold — only lines that aged out of the reply's window, past the watermark", () => {
  it("the newest six are the reply's own and are never folded; fewer than four pending → no fold", () => {
    expect(planCompanionFold(lines(9), null)).toBeNull(); // 3 aged out
    const plan = planCompanionFold(lines(10), null)!;
    expect(plan.batch.map((l) => l.text)).toEqual(["line 0", "line 1", "line 2", "line 3"]);
    expect(plan.foldedThrough).toEqual(plan.batch[3]!.createdAt);
  });

  it("skips what the watermark already covers", () => {
    const all = lines(14); // 8 aged out
    expect(planCompanionFold(all, all[4]!.createdAt)).toBeNull(); // 3 past the watermark
    const plan = planCompanionFold(all, all[3]!.createdAt)!;
    expect(plan.batch.map((l) => l.text)).toEqual(["line 4", "line 5", "line 6", "line 7"]);
  });

  it("folds at most 24 lines, the OLDEST, and leaves the rest for the next fold", () => {
    const plan = planCompanionFold(lines(40), null)!;
    expect(plan.batch).toHaveLength(24);
    expect(plan.batch[0]!.text).toBe("line 0");
  });
});

describe("companionSummaryTurnsOf — what the summarizer is sent", () => {
  it("redacts the worker's own name and drops a line carrying a hard identifier (G1)", () => {
    const turns = companionSummaryTurnsOf(
      [
        { role: "worker", text: "main Ramesh hoon, welder", createdAt: NOW },
        { role: "worker", text: "mera number 9876543210 hai", createdAt: NOW },
        { role: "bada_bhai", text: "Welding achha kaam hai.", createdAt: NOW },
      ],
      "Ramesh",
    );
    expect(turns.map((t) => t.role)).toEqual(["worker", "bada_bhai"]);
    expect(turns[0]!.text).not.toContain("Ramesh");
    expect(JSON.stringify(turns)).not.toContain("9876543210");
  });
});

describe("the fold", () => {
  it("UPDATED: the screened notes are stored with the batch's watermark; spend and a counts-only event", async () => {
    const h = setup();
    await h.service.fold(JOB);
    const plan = planCompanionFold(lines(10), null)!;
    expect(h.ai.freeChatSummarize).toHaveBeenCalledTimes(1);
    const [input] = h.ai.freeChatSummarize.mock.calls[0]! as [
      { previous_summary: unknown; turns: unknown[] },
    ];
    expect(input.previous_summary).toBeNull();
    expect(input.turns).toHaveLength(4);
    expect(h.history.storeSummary).toHaveBeenCalledWith(
      WORKER,
      { summary: NOTES, foldedThrough: plan.foldedThrough },
      true, // no live record: whatever row exists belongs to an expired conversation
    );
    expect(h.cost.record).toHaveBeenCalledWith(
      REAL_META,
      "profiling_free_summary",
      null,
      JOB.correlationId,
      JOB.requestId,
      { workerId: WORKER, sessionId: null },
    );
    const [event] = h.emitted();
    expect(event).toMatchObject({
      event_name: "chat.companion_summary_updated",
      payload: {
        worker_id: WORKER,
        outcome: "updated",
        folded_messages: 4,
        summary_chars: NOTES.length,
      },
    });
    expect(
      EVENT_REGISTRY["chat.companion_summary_updated"].payload.safeParse(event!.payload).success,
    ).toBe(true);
    expect(h.lock.releaseCompanion).toHaveBeenCalledWith(WORKER, "token");
  });

  it("builds on the LIVE summary: its text is the previous summary, its watermark the place", async () => {
    const all = lines(14);
    const h = setup({
      window: { ok: true, value: all },
      live: { ok: true, value: { summary: "- Earlier notes.", foldedThrough: all[3]!.createdAt } },
    });
    await h.service.fold(JOB);
    const [input] = h.ai.freeChatSummarize.mock.calls[0]! as [{ previous_summary: unknown }];
    expect(input.previous_summary).toBe("- Earlier notes.");
    expect(h.history.storeSummary.mock.calls[0]![2]).toBe(false); // monotonic over the live row
  });

  it("REJECTED: notes carrying an identifier are refused; the batch is consumed, the previous text kept", async () => {
    const h = setup({ out: { summary: "- Call him on 9876543210.", ai_metadata: REAL_META } });
    await h.service.fold(JOB);
    const plan = planCompanionFold(lines(10), null)!;
    expect(h.history.storeSummary).toHaveBeenCalledWith(
      WORKER,
      { summary: null, foldedThrough: plan.foldedThrough },
      true,
    );
    expect(h.emitted()[0]!.payload).toMatchObject({ outcome: "rejected", summary_chars: null });
  });

  it("a REAL call with no notes consumes the batch (the previous text kept)", async () => {
    const h = setup({ out: { summary: null, ai_metadata: REAL_META } });
    await h.service.fold(JOB);
    expect(h.history.storeSummary).toHaveBeenCalledTimes(1);
    expect(h.emitted()[0]!.payload).toMatchObject({ outcome: "unavailable" });
  });

  it.each([
    ["a mock", { summary: NOTES, ai_metadata: { ...REAL_META, real_call: false } }],
    ["a failed call", { summary: NOTES, ai_metadata: { ...REAL_META, success: false } }],
    ["no answer", null],
  ])("a TRANSPORT failure (%s) stores nothing: the same lines retry", async (_why, out) => {
    const h = setup({ out });
    await h.service.fold(JOB);
    expect(h.history.storeSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["another fold holds the lock", { lock: null }],
    ["the worker's name cannot be read (fail closed, G2)", { name: "throws" as const }],
    ["the summary is unreadable", { live: { ok: false } as const }],
    ["the window is unreadable", { window: { ok: false } as const }],
    ["fewer than four lines aged out", { window: { ok: true, value: lines(9) } as const }],
  ])("no model call when %s", async (_why, over) => {
    const h = setup(over);
    await h.service.fold(JOB);
    expect(h.ai.freeChatSummarize).not.toHaveBeenCalled();
    expect(h.history.storeSummary).not.toHaveBeenCalled();
  });

  it("the kill switch schedules nothing", async () => {
    const h = setup({ brain: false });
    h.service.schedule(JOB);
    await h.service.idle();
    expect(h.lock.acquireCompanion).not.toHaveBeenCalled();
  });

  it("schedule() returns at once and folds in the background", async () => {
    const h = setup();
    h.service.schedule(JOB);
    await h.service.idle();
    expect(h.ai.freeChatSummarize).toHaveBeenCalledTimes(1);
  });
});

describe("latestText — the summary the brain's reply carries", () => {
  it("the companion's own while its conversation is alive", async () => {
    const h = setup({
      live: { ok: true, value: { summary: "- Own notes.", foldedThrough: NOW } },
      profiling: "- Profiling notes.",
    });
    expect(await h.service.latestText(WORKER)).toBe("- Own notes.");
    expect(h.profiling.latestText).not.toHaveBeenCalled();
  });

  it.each([
    ["none (or expired)", { ok: true, value: undefined } as const],
    [
      "a watermark-only record",
      { ok: true, value: { summary: null, foldedThrough: NOW } } as const,
    ],
    ["an unreadable store", { ok: false } as const],
  ])(
    "falls back to the profiling chat's when the companion has %s (#2284 R4)",
    async (_why, live) => {
      const h = setup({ live, profiling: "- Profiling notes." });
      expect(await h.service.latestText(WORKER)).toBe("- Profiling notes.");
    },
  );
});
