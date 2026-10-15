import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { FreeChatModelCalls } from "../../profiling/free-chat/free-chat-model-calls";
import { FREE_CHAT_COPY } from "../../profiling/free-chat/free-chat.copy";
import { WorkerNameReader } from "../../workers/worker-name-sources";
import { CompanionBrain } from "./companion-brain";
import type { CompanionEditService } from "./companion-edit.service";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import {
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./handlers/fixed-line.handlers";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { CompanionHandlerRegistry } from "./handlers/registry";

/**
 * ADR-0055 (#2275) — THE FREE-CHAT BRAIN'S PRIVACY, end to end through the REAL orchestrator, brain,
 * free-chat model calls and name reader; only the AI client, the stores, the workers row and the
 * crypto service are faked.
 *
 *   - OWN-NAME REDACTION (ADR-0051's invariant, ADR-0054 §4/§8 M1): the worker's own name never
 *     reaches the classify, reply or news input, whatever `AI_RAW_PII_ENABLED` says; a name that will
 *     not decrypt costs news its search (fail closed) and nothing else;
 *   - `AI_RAW_PII_ENABLED` BOTH WAYS: off, the gateway masks and every model call carries its text;
 *     on, no gateway hop and the raw text goes on — still own-name redacted;
 *   - TEXT-FREE SPINE AND LOGS on the reject, fallback and throw paths, with a phone number and an
 *     employer name in the message.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-10-14T10:00:00.000Z");
const PROFILE = { id: "p1", canonicalTradeId: null, experience: { total_years: 4 } } as never;

const NAME = "Ramesh Yadav";
/** A news question with the worker's name and no identifier (an identifier is never searched, R9). */
const NEWS_MSG = "main Ramesh Yadav hoon, aaj ki khabar batao";
const NEWS_MSG_REDACTED = "main [NAME] hoon, aaj ki khabar batao";
/** A message carrying the name, a phone number and an employer — none of it may reach a log or the spine. */
const PII_MSG = "main Ramesh Yadav hoon, 9876543210 pe call karo, Tata Motors mein kaam karta tha";
const PII_WORDS = /Ramesh|Yadav|9876543210|Tata|Motors/;

/** The gateway's mask, as the ai-service pseudonymizer would write it. */
const mask = (text: string): string =>
  text
    .replace(NAME, "<PERSON_1>")
    .replace(/\d{10}/, "<PHONE_1>")
    .replace("Tata Motors", "<ORG_1>");

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_free_classify",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 1,
  output_tokens: 1,
  estimated_cost_inr: 0.01,
  latency_ms: 10,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
};
const CAREER = {
  category: "career",
  confidence: 0.92,
  blocked: false,
  ai_metadata: META,
  language: null,
  resume_action: null,
};
const NEWS_REFUSAL = { status: "refuse", topic: "news", ai_metadata: META };

interface Setup {
  rawPii: boolean;
  reply?: unknown;
  /** What `workers.full_name` holds: a decryptable token (default), none, or one that will not decrypt. */
  name?: "on_file" | "none" | "undecryptable";
}

function setup(opts: Setup) {
  const config = {
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
    AI_RAW_PII_ENABLED: opts.rawPii,
  } as unknown as ServerConfig;
  const ai = {
    pseudonymize: vi.fn(async (text: string) => ({
      pseudonymized_text: mask(text),
      blocked: false,
    })),
    companionClassify: vi.fn(async () => null),
    companionCareer: vi.fn(async () => null),
    freeChatClassify: vi.fn(async (..._args: unknown[]) => CAREER),
    freeChatReply: vi.fn(async (..._args: unknown[]) =>
      opts.reply === undefined ? NEWS_REFUSAL : opts.reply,
    ),
    freeChatNews: vi.fn(async (..._args: unknown[]) => null),
  };
  const memory = {
    read: vi.fn(async () => [{ role: "bada_bhai", text: "Namaste Ramesh ji, kaise hain?" }]),
    append: vi.fn(async () => undefined),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const faltuStore = {
    cooldownUntil: vi.fn(async () => null),
    countStrike: vi.fn(async () => 1),
    startCooldown: vi.fn(async () => null),
  };
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
      {
        isKnownEmployer: vi.fn(async () => false),
      } as never,
    ),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const newsCap = {
    reserve: vi.fn(async () => ({ ok: true, count: 1 })),
    release: vi.fn(async () => undefined),
  };
  const calls = new FreeChatModelCalls(ai as never, cost as never, newsCap as never);
  const name = opts.name ?? "on_file";
  const workers = {
    findFullNameToken: vi.fn(async () => (name === "none" ? null : "enc:token")),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (name === "undecryptable") throw new Error("bad auth tag");
      return NAME;
    }),
  };
  const reader = new WorkerNameReader(workers as never, pii as never);
  const brain = new CompanionBrain(
    config,
    calls,
    registry,
    { downloadOf: vi.fn(async () => "ready") } as never,
    reader,
    // ADR-0055 R4 — no rolling summary on file.
    { latestText: vi.fn(async () => null) } as never,
  );
  const route = vi.spyOn(brain, "route");
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
    faltuStore as never,
    {
      read: vi.fn(async () => null),
      remember: vi.fn(async () => undefined),
      claim: vi.fn(async () => "claimed"),
      release: vi.fn(async () => undefined),
    } as never,
    { set: vi.fn(), take: vi.fn(async () => null), clear: vi.fn() } as never,
    brain,
  );
  const send = (text: string) =>
    orchestrator.handleMessage(WORKER, PROFILE, { text, submission_id: SUBMISSION }, CTX, NOW);
  return { ai, events, newsCap, workers, pii, route, send };
}

const inputOf = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls[0]![0] as { text: string; recent_turns: { text: string }[] };

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("own-name redaction on the brain's model egress (ADR-0055 F1)", () => {
  it("classify, reply and news inputs carry [NAME] — the message AND the recent turns", async () => {
    const h = setup({ rawPii: true });
    const turn = await h.send(NEWS_MSG);
    for (const spy of [h.ai.freeChatClassify, h.ai.freeChatReply, h.ai.freeChatNews]) {
      const sent = inputOf(spy);
      expect(sent.text).toBe(NEWS_MSG_REDACTED);
      expect(sent.recent_turns.map((t) => t.text)).toEqual(["Namaste [NAME] ji, kaise hain?"]);
      expect(JSON.stringify(sent)).not.toMatch(/Ramesh|Yadav/);
    }
    // The news call ran (null answer → the unavailable line); the name was read ONCE for the turn.
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(h.workers.findFullNameToken).toHaveBeenCalledTimes(1);
    expect(h.pii.decrypt).toHaveBeenCalledTimes(1);
  });

  it("a name that will NOT decrypt: no news call, no slot, the unavailable line (M1 fails closed)", async () => {
    const h = setup({ rawPii: true, name: "undecryptable" });
    const turn = await h.send(NEWS_MSG);
    expect(h.ai.freeChatNews).not.toHaveBeenCalled();
    expect(h.newsCap.reserve).not.toHaveBeenCalled();
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    // Classify and reply still RAN, with the name read as none (the knownName view fails open).
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    expect(h.ai.freeChatReply).toHaveBeenCalledTimes(1);
    // The warning names the worker id only — never the token, never a name.
    const warning = logged
      .map((args) => String(args[0]))
      .find((l) => l.includes("could not decrypt"));
    expect(warning).toContain(WORKER);
    expect(warning).not.toMatch(/enc:token|Ramesh/);
  });

  it("no name on file: classify, reply AND news run — there is simply nothing to redact", async () => {
    const h = setup({ rawPii: true, name: "none" });
    await h.send(NEWS_MSG);
    expect(h.pii.decrypt).not.toHaveBeenCalled();
    expect(inputOf(h.ai.freeChatClassify).text).toBe(NEWS_MSG);
    expect(inputOf(h.ai.freeChatReply).text).toBe(NEWS_MSG);
    expect(h.ai.freeChatNews).toHaveBeenCalledTimes(1);
  });
});

describe.each([true, false])("AI_RAW_PII_ENABLED=%s on the brain path (ADR-0055 F2)", (rawPii) => {
  it(`the gateway runs ${rawPii ? "NEVER" : "FIRST"}; every model call carries ${
    rawPii ? "the raw text, own-name redacted" : "its masked text"
  }`, async () => {
    const h = setup({ rawPii });
    await h.send(NEWS_MSG);
    expect(h.ai.pseudonymize).toHaveBeenCalledTimes(rawPii ? 0 : 1);
    const expected = rawPii ? NEWS_MSG_REDACTED : mask(NEWS_MSG);
    for (const spy of [h.ai.freeChatClassify, h.ai.freeChatReply, h.ai.freeChatNews]) {
      expect(inputOf(spy).text).toBe(expected);
      expect(JSON.stringify(spy.mock.calls[0]![0])).not.toMatch(/Ramesh|Yadav/);
    }
  });

  const PATHS: Array<[string, Setup["reply"] | "throw"]> = [
    // The gate rejects a line ("!") → REPLY_FALLBACK and a closed-reason warning.
    [
      "reject",
      { status: "answer", lines: ["Call kariye!"], followup_chips: [], ai_metadata: META },
    ],
    // The reply call failed → REPLY_FALLBACK.
    ["fallback", null],
    // The brain itself throws, its error carrying the worker's words → the clarify line.
    ["throw", "throw"],
  ];
  it.each(PATHS)("%s path: the logs and the v4 event stay text-free", async (path, reply) => {
    const h = setup({ rawPii, reply: reply === "throw" ? undefined : reply });
    if (reply === "throw") h.route.mockRejectedValueOnce(new Error(`boom: ${PII_MSG}`));
    const turn = await h.send(PII_MSG);
    expect(turn.reply).not.toMatch(PII_WORDS);

    const events = h.events.emit.mock.calls.map(
      (c) => c[0] as { event_name: string; payload: unknown },
    );
    const v4 = events.find((e) => e.event_name === "chat.companion_turn_served_v4")!;
    expect(
      EVENT_REGISTRY["chat.companion_turn_served_v4"].payload.safeParse(v4.payload).success,
    ).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(PII_WORDS);
    expect(JSON.stringify(logged)).not.toMatch(PII_WORDS);
    if (path !== "throw") expect(v4.payload).toMatchObject({ outcome: "fallback" });
    else expect(v4.payload).toMatchObject({ intent_source: "fallback", outcome: "clarify" });
  });
});
