import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import type { Queue } from "bullmq";
import type { CompanionEditService } from "./companion-edit.service";
import { V2_CLARIFY, V2_EDIT_CARD_INTRO, V2_JOBS_DEFERRED } from "../companion-replies";
import { v2CopyTurn, v2EditCardTurn } from "./companion-v2-compose";
import { CompanionTurnReplayStore } from "./turn-replay.store";

/**
 * ADR-0046 §3 (privacy) — the RAW worker text never leaves the request:
 *   - no event payload contains it (events carry ids, counts and closed enums only);
 *   - no log line contains it, on any failure path (the Logger is spied for real);
 *   - the classifier and Redis memory only ever see the PSEUDONYMIZED text the gateway returned.
 *
 * The gateway itself is the AI service's (proven by its own suite); this file proves the API
 * hands it the raw text exactly once and then only ever passes the masked result onward.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-09-29T10:00:00.000Z");
const PROFILE = { id: "p1", workerId: WORKER } as never;
/** The raw message — the thing that must never appear anywhere downstream. */
const RAW = "Tata Motors mein welder tha, mera number 9876543210 hai";
/** What the gateway returns for it. */
const MASKED = "[EMPLOYER_1] mein welder tha, mera number [PHONE_1] hai";

const CARD = v2EditCardTurn(V2_EDIT_CARD_INTRO, {
  proposal_id: "22222222-2222-4222-8222-222222222222",
  expires_at: "2026-09-29T10:10:00.000Z",
  rows: [
    {
      row_id: "33333333-3333-4333-8333-333333333333",
      section_label: "Kaam",
      op: "edit",
      before: "[EMPLOYER_1]",
      after: "Mahindra",
    },
  ],
});

function setup(
  opts: {
    classifyThrows?: boolean;
    emitThrows?: boolean;
    classify?: { intent: string; confidence: number; blocked: false };
    replaySetThrows?: boolean;
    /** `AI_RAW_PII_ENABLED` (ADR-0047). Omitted = the key is absent, which must read as OFF. */
    rawPii?: boolean;
  } = {},
) {
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: MASKED, blocked: false })),
    companionClassify: vi.fn(async () => {
      if (opts.classifyThrows) throw new Error("classifier boom");
      return opts.classify ?? { intent: "edit_resume", confidence: 0.9, blocked: false };
    }),
  };
  const memory = { read: vi.fn(async () => []), append: vi.fn(async () => undefined) };
  const edits = { propose: vi.fn(async () => ({ turn: CARD, outcome: "proposed" })) };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    ...(opts.rawPii === undefined ? {} : { AI_RAW_PII_ENABLED: opts.rawPii }),
  } as unknown as ServerConfig;
  const events = {
    emit: vi.fn(async (params: unknown) => {
      if (opts.emitThrows) throw new Error("spine down");
      return params;
    }),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const faltuStore = { cooldownUntil: vi.fn(async () => null) };
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, {
      findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
    } as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(config, ai as never, cost as never, events as never),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  // The REAL replay store over a fake Redis, so what it would write is what the tests read.
  const replayRedis = {
    get: vi.fn(async (_key: string) => null as string | null),
    set: vi.fn(async (_key: string, _value: string, _mode: "EX", _seconds: number) => {
      if (opts.replaySetThrows) throw new Error("redis down");
      return "OK";
    }),
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
  );
  return { orchestrator, ai, memory, edits, events, cost, faltuStore, replayRedis };
}

/** Every line every Nest Logger wrote during `run`. */
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

describe("CompanionV2Orchestrator — the raw worker text never leaves the request", () => {
  it("no event payload contains the raw text — on a card, a clarify or a failure", async () => {
    const runs = [
      setup(),
      setup({ classifyThrows: false }),
      setup({ emitThrows: false }),
    ];
    for (const h of runs) {
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW).catch(() => undefined);
      for (const call of h.events.emit.mock.calls) {
        const payload = (call[0] as { payload: unknown }).payload;
        expect(JSON.stringify(payload)).not.toContain(RAW);
        expect(JSON.stringify(payload)).not.toContain("Tata Motors");
        expect(JSON.stringify(payload)).not.toContain("9876543210");
      }
    }
  });

  it("no log line contains the raw text, even when the classifier and the spine fail", async () => {
    const logs = await withCapturedLogs(async () => {
      // Classifier throws, event emit throws: both failure paths log.
      const h = setup({ classifyThrows: true, emitThrows: true });
      await h.orchestrator
        .handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW)
        .catch(() => undefined);
    });
    expect(logs).not.toContain("Tata Motors");
    expect(logs).not.toContain("9876543210");
    expect(logs).not.toContain(RAW);
  });

  it("the classifier and memory only ever see the MASKED text", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);

    // The gateway got the raw text exactly once...
    expect(h.ai.pseudonymize).toHaveBeenCalledWith(RAW, CTX);
    // ...and everything downstream got only its output.
    expect(h.ai.companionClassify).toHaveBeenCalledWith(
      { text: MASKED, recent_turns: [] },
      CTX,
    );
    expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, { role: "worker", text: MASKED });
    for (const call of h.memory.append.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("Tata Motors");
      expect(JSON.stringify(call)).not.toContain("9876543210");
    }
  });

  it("a blocked message is never classified and never stored", async () => {
    const h = setup();
    h.ai.pseudonymize.mockResolvedValue({ pseudonymized_text: "", blocked: true } as never);
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
  });

  it("the card's before/after values are the worker's own masked values — and no event carries them", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(turn).toBe(CARD);
    for (const call of h.events.emit.mock.calls) {
      const serialized = JSON.stringify(call[0]);
      expect(serialized).not.toContain("Mahindra");
      expect(serialized).not.toContain("[EMPLOYER_1]");
    }
    // Sanity: the fixed clarify turn used elsewhere in this file is a valid turn.
    expect(v2CopyTurn(V2_CLARIFY).reply).toBe(V2_CLARIFY.latin);
  });
});

/**
 * THE REPLAY CACHE (contracts §7) is a per-worker Redis write on the message path, so it gets the
 * same proof as memory: the REAL store over a fake Redis, a message carrying a name, an employer
 * and a phone number, and every path that writes. The stored value is the turn the worker was
 * sent — never the message, raw or masked — and no log line carries either, even when the write
 * fails.
 */
describe("the replay cache never holds the message or its PII", () => {
  const SID = "44444444-4444-4444-8444-444444444444";
  const KEY = `companion:v2:turn:${WORKER}:${SID}`;
  const RAW_WITH_NAME = "Main Ramesh Kumar hoon, Tata Motors mein welder tha, mera number 9876543210 hai";
  const SECRETS = [RAW_WITH_NAME, RAW, MASKED, "Ramesh", "Kumar", "Tata Motors", "9876543210"];

  const storedTurn = (h: ReturnType<typeof setup>): string => {
    expect(h.replayRedis.set).toHaveBeenCalledTimes(1);
    const [key, value] = h.replayRedis.set.mock.calls[0]!;
    expect(key).toBe(KEY);
    return value;
  };

  it.each([
    ["the classifier path (a fixed line)", { intent: "jobs_talk", confidence: 0.9, blocked: false as const }],
    ["the classifier path (below the floor)", { intent: "edit_resume", confidence: 0.3, blocked: false as const }],
    ["the edit-card path", { intent: "edit_resume", confidence: 0.9, blocked: false as const }],
  ])("%s: the SET value is the served turn and nothing of the message", async (_label, classify) => {
    const h = setup({ classify });
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: RAW_WITH_NAME, submission_id: SID },
      CTX,
      NOW,
    );
    const value = storedTurn(h);
    for (const secret of SECRETS) expect(value).not.toContain(secret);
    expect(JSON.parse(value)).toEqual(turn);
  });

  it("the paths really differ: a fixed line, the clarify line and the card", async () => {
    const replies = [];
    for (const classify of [
      { intent: "jobs_talk", confidence: 0.9, blocked: false as const },
      { intent: "edit_resume", confidence: 0.3, blocked: false as const },
      { intent: "edit_resume", confidence: 0.9, blocked: false as const },
    ]) {
      const h = setup({ classify });
      replies.push(
        (await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW_WITH_NAME, submission_id: SID }, CTX, NOW))
          .reply,
      );
    }
    expect(replies).toEqual([V2_JOBS_DEFERRED.latin, V2_CLARIFY.latin, CARD.reply]);
  });

  it("no log line carries the message when the replay write fails", async () => {
    const logs = await withCapturedLogs(async () => {
      const h = setup({ replaySetThrows: true });
      await h.orchestrator.handleMessage(
        WORKER,
        PROFILE,
        { text: RAW_WITH_NAME, submission_id: SID },
        CTX,
        NOW,
      );
      expect(h.replayRedis.set).toHaveBeenCalledTimes(1);
    });
    expect(logs).toContain("companion turn replay not stored");
    for (const secret of SECRETS) expect(logs).not.toContain(secret);
  });
});

/**
 * `AI_RAW_PII_ENABLED` (owner decision 2026-09-30, ADR-0047) lifts the PROMPT half of the
 * rule above and nothing else: the classifier and the TTL-bound Redis memory get the raw text on
 * purpose, while the event spine and the log lines stay exactly as text-free as with it off.
 */
describe("CompanionV2Orchestrator — AI_RAW_PII_ENABLED lifts the prompt masking, never the spine", () => {
  it("ON: the raw text reaches the classifier and memory, with no gateway hop", async () => {
    const h = setup({ rawPii: true });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).toHaveBeenCalledWith({ text: RAW, recent_turns: [] }, CTX);
    expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, { role: "worker", text: RAW });
  });

  it("ON: still no event payload carries the text", async () => {
    const h = setup({ rawPii: true });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(h.events.emit).toHaveBeenCalled();
    for (const call of h.events.emit.mock.calls) {
      const serialized = JSON.stringify((call[0] as { payload: unknown }).payload);
      expect(serialized).not.toContain("Tata Motors");
      expect(serialized).not.toContain("9876543210");
    }
  });

  // The classifier SUCCEEDS here on purpose. A throwing fake escapes `handleMessage` before the
  // memory append and the spine are reached, so the emit-failure log line never runs and every
  // absence check passes on an empty sink (the real `companionClassify` returns null, never
  // throws). The `toContain` first proves the log path ran; only then do the absences mean much.
  it.each([
    ["ON", true],
    ["OFF", false],
  ] as const)(
    "%s: the spine-failure log line runs and carries none of the text",
    async (_mode, rawPii) => {
      const logs = await withCapturedLogs(async () => {
        const h = setup({ rawPii, emitThrows: true });
        await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
        expect(h.memory.append).toHaveBeenCalled();
      });
      expect(logs).toContain("chat.companion_turn_served_v2 not recorded for worker");
      expect(logs).not.toContain(RAW);
      expect(logs).not.toContain("Tata Motors");
      expect(logs).not.toContain("9876543210");
    },
  );

  it("OFF, explicitly: only the masked text travels — the rule above, unchanged", async () => {
    const h = setup({ rawPii: false });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(h.ai.pseudonymize).toHaveBeenCalledWith(RAW, CTX);
    expect(h.ai.companionClassify).toHaveBeenCalledWith({ text: MASKED, recent_turns: [] }, CTX);
    for (const call of h.memory.append.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("9876543210");
    }
  });

  it("ON: the replay cache still holds only the served turn — memory is the one raw copy", async () => {
    const SID = "44444444-4444-4444-8444-444444444444";
    const h = setup({ rawPii: true });
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: RAW, submission_id: SID },
      CTX,
      NOW,
    );
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.replayRedis.set).toHaveBeenCalledTimes(1);
    const value = h.replayRedis.set.mock.calls[0]![1];
    expect(JSON.parse(value)).toEqual(turn);
    for (const secret of [RAW, "Tata Motors", "9876543210"]) expect(value).not.toContain(secret);
  });
});
