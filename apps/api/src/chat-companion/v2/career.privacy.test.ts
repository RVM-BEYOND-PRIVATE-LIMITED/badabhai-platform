import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import {
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import type { Queue } from "bullmq";
import type { CompanionEditService } from "./companion-edit.service";
import { CompanionTurnReplayStore } from "./turn-replay.store";

/**
 * ADR-0046 P3 privacy — the career turn's text boundaries:
 *   - the QUESTION is pseudonymized before the model, like every worker-text route;
 *   - the ANSWER reaches the worker and nothing else: no event, no log line, no memory entry
 *     beyond the (already-allowed) masked turn pair the orchestrator writes;
 *   - the worker_context carries only the trade label and the experience bucket;
 *   - a rejected answer logs its REASON, never a line of the answer.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-09-29T10:00:00.000Z");
const PROFILE = { id: "p1", workerId: WORKER, canonicalTradeId: null, experience: null } as never;
const QUESTION = "Tata Motors chhod diya, aage kya karun";
const ANSWER_LINE = "Pehle welding ka certificate kariye aur 6G test ki tayari kariye.";

function setup(opts: { career?: unknown; classifyThrows?: boolean } = {}) {
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: "masked question", blocked: false })),
    companionClassify: vi.fn(async () =>
      opts.classifyThrows
        ? (() => {
            throw new Error("classifier boom");
          })()
        : { intent: "career_talk", confidence: 0.9, blocked: false },
    ),
    companionCareer: vi.fn(async () =>
      opts.career === undefined
        ? {
            status: "answer",
            lines: [ANSWER_LINE],
            followup_chips: ["Course kahan milega"],
            ai_metadata: null,
          }
        : opts.career,
    ),
  };
  const memory = { read: vi.fn(async () => []), append: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const faltuStore = { cooldownUntil: vi.fn(async () => null) };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
  } as unknown as ServerConfig;
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler({ propose: vi.fn() } as unknown as CompanionEditService),
    new NewResumeHandler(config, {
      findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
    } as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(
      config,
      ai as never,
      cost as never,
      events as never,
      { isKnownEmployer: vi.fn(async () => false) } as never,
    ),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  // The REAL replay store over a fake Redis, so what it would write is what the tests read.
  const replayRedis = {
    get: vi.fn(async (_key: string) => null as string | null),
    set: vi.fn(async (_key: string, _value: string, _mode: "EX", _seconds: number) => "OK"),
  };
  const replays = new CompanionTurnReplayStore({
    client: Promise.resolve(replayRedis),
  } as unknown as Queue);
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
    faltuStore as never,
    replays,
    { set: vi.fn(async () => undefined), take: vi.fn(async () => null), clear: vi.fn(async () => undefined) } as never,
  );
  return { orchestrator, ai, memory, events, cost, replayRedis };
}

async function withCapturedLogs(run: () => Promise<unknown>): Promise<string> {
  const sink: string[] = [];
  const methods = ["log", "warn", "error", "debug", "verbose"] as const;
  const spies = methods.map((m) =>
    vi.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    }),
  );
  try {
    await run();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return sink.join("\n");
}

describe("career privacy (ADR-0046 P3)", () => {
  it("the question is masked before the model; the context is label+bucket only", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: QUESTION }, CTX, NOW);

    expect(h.ai.pseudonymize).toHaveBeenCalledWith(QUESTION, CTX);
    expect(h.ai.companionCareer).toHaveBeenCalledWith(
      {
        text: "masked question",
        recent_turns: [],
        worker_context: { trade_label: null, experience_bucket: null },
      },
      CTX,
    );
  });

  it("the answer's text reaches no event — only the closed disposition", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: QUESTION }, CTX, NOW);
    expect(turn.reply).toBe(ANSWER_LINE);
    expect(turn.read_aloud).toBe(false);

    const career = h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_career_answered")!;
    expect(Object.keys(career.payload).sort()).toEqual([
      "outcome",
      "refusal_topic",
      "turns_in_memory",
    ]);
    for (const call of h.events.emit.mock.calls) {
      const serialized = JSON.stringify(call[0]);
      expect(serialized).not.toContain("welding ka certificate");
      expect(serialized).not.toContain(QUESTION);
    }
  });

  it("a REJECTED answer logs its reason, never a line of the answer", async () => {
    const logs = await withCapturedLogs(async () => {
      const h = setup({
        career: {
          status: "answer",
          lines: ["Salary 25000 pakki mil jayegi."],
          followup_chips: [],
          ai_metadata: null,
        },
      });
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: QUESTION }, CTX, NOW);
    });
    // The reason is a closed enum value...
    expect(logs).toContain("money");
    // ...and none of the rejected text rides along.
    expect(logs).not.toContain("25000");
    expect(logs).not.toContain("pakki mil jayegi");
  });

  it("a DROPPED over-long chip reaches no log, no event and not the replay cache", async () => {
    const DROPPED = "Pipe welding ka course kahan";
    const SID = "55555555-5555-4555-8555-555555555555";
    let h!: ReturnType<typeof setup>;
    let turn!: Awaited<ReturnType<CompanionV2Orchestrator["handleMessage"]>>;
    const logs = await withCapturedLogs(async () => {
      h = setup({
        career: {
          status: "answer",
          lines: [ANSWER_LINE],
          followup_chips: ["Course kahan milega", DROPPED],
          ai_metadata: null,
        },
      });
      turn = await h.orchestrator.handleMessage(
        WORKER,
        PROFILE,
        { text: QUESTION, submission_id: SID },
        CTX,
        NOW,
      );
    });
    expect(turn.reply).toBe(ANSWER_LINE);
    expect(turn.suggested_followups).toEqual(["Course kahan milega"]);
    // The drop is logged as a count and a closed reason...
    expect(logs).toContain("1 follow-up chip(s) dropped (reason=chip_too_long)");
    // ...and the dropped text is nowhere: not in a log, an event, memory or the cached turn.
    expect(logs).not.toContain("Pipe welding");
    for (const call of h.events.emit.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("Pipe welding");
    }
    expect(JSON.stringify(h.memory.append.mock.calls)).not.toContain("Pipe welding");
    expect(h.replayRedis.set).toHaveBeenCalledTimes(1);
    expect(h.replayRedis.set.mock.calls[0]![1]).not.toContain("Pipe welding");
  });
});

/**
 * THE REPLAY CACHE on the career path (contracts §7): what is kept for a retry is the validated
 * answer the worker was served — never the question, raw or masked.
 */
describe("career privacy — the replay cache holds the served answer, never the question", () => {
  it("the SET value is the served turn and nothing of the question", async () => {
    const SID = "44444444-4444-4444-8444-444444444444";
    const h = setup();
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: QUESTION, submission_id: SID },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(ANSWER_LINE);
    expect(h.replayRedis.set).toHaveBeenCalledTimes(1);
    const [key, value] = h.replayRedis.set.mock.calls[0]!;
    expect(key).toBe(`companion:v2:turn:${WORKER}:${SID}`);
    expect(JSON.parse(value)).toEqual(turn);
    for (const secret of [QUESTION, "Tata Motors", "masked question"]) {
      expect(value).not.toContain(secret);
    }
  });
});
