import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { V2_FALTU_REDIRECT } from "../companion-replies";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import type { CompanionEditService } from "./companion-edit.service";

/**
 * ADR-0046 P2 (O11) — the abusive message never leaves the request:
 *   - the LEXICON answers it locally: no gateway call, no classifier, no model;
 *   - abuse the lexicon MISSES reaches the classifier (masked), and when the classifier calls it
 *     `faltu` it is not stored either — pseudonymizing masks PII, not abuse;
 *   - it is never appended to memory (the orchestrator passes no memory pair on either path);
 *   - the only trace is `chat.companion_faltu_strike`, which carries a count and a boolean;
 *   - no log line contains it, even when the strike event itself fails to write.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-09-29T10:00:00.000Z");
const PROFILE = { id: "p1", workerId: WORKER } as never;
/** A phrase the abuse lexicon matches (packages/profiling-lexicon predicates). */
const ABUSIVE = "chutiya bhai kya kar raha hai";
/** Abuse the lexicon does NOT match — only the classifier can call it faltu. */
const ABUSIVE_MISSED = "tumhari shakal gadhe jaisi hai";

function setup(
  opts: { emitThrows?: boolean; classifyConfidence?: number; faltuEnabled?: boolean } = {},
) {
  const ai = {
    // The gateway masks PII, not abuse: the masked text still carries the insult.
    pseudonymize: vi.fn(async (text: string) => ({ pseudonymized_text: text, blocked: false })),
    companionClassify: vi.fn(async () => ({
      intent: "faltu",
      confidence: opts.classifyConfidence ?? 0.9,
      blocked: false,
    })),
  };
  const memory = { read: vi.fn(async () => []), append: vi.fn(async () => undefined) };
  const edits = { propose: vi.fn() };
  const events = {
    emit: vi.fn(async (params: unknown) => {
      if (opts.emitThrows) throw new Error("spine down");
      return params;
    }),
  };
  const faltuStore = {
    countStrike: vi.fn(async () => 1),
    startCooldown: vi.fn(async () => "2026-09-29T10:30:00.000Z"),
    cooldownUntil: vi.fn(async () => null),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: opts.faltuEnabled ?? true,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
  } as unknown as ServerConfig;
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, {
      findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
    } as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(config, ai as never, { record: vi.fn() } as never, events as never),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    { record: vi.fn(async () => undefined) } as never,
    faltuStore as never,
    { read: vi.fn(async () => null), remember: vi.fn(async () => undefined) } as never,
  );
  return { orchestrator, ai, memory, events, faltuStore };
}

/** Every emitted event, serialized — the haystack a message must never appear in. */
const serializedEvents = (events: { emit: { mock: { calls: unknown[][] } } }): string =>
  events.emit.mock.calls.map((c) => JSON.stringify(c[0])).join("\n");

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

describe("faltu privacy (ADR-0046 P2) — the abusive message never leaves the request", () => {
  it("the lexicon answers locally: no gateway, no classifier, no memory, no text anywhere", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: ABUSIVE }, CTX, NOW);

    expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
    expect(h.faltuStore.countStrike).toHaveBeenCalled();

    // The turn event records the lexicon as the source, the intent, and nothing about the text.
    const turnEvent = h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_turn_served_v2")!;
    expect(turnEvent.payload).toMatchObject({ intent_source: "lexicon", v2_intent: "faltu" });
    for (const call of h.events.emit.mock.calls) {
      const serialized = JSON.stringify(call[0]);
      expect(serialized).not.toContain("chutiya");
      expect(serialized).not.toContain(ABUSIVE);
    }

    // The strike event is a count and a boolean — nothing else.
    const strike = h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_faltu_strike")!;
    expect(Object.keys(strike.payload).sort()).toEqual(["cooldown_started", "strike_count"]);
  });

  it("no log line contains the message, even when the strike event fails to write", async () => {
    const logs = await withCapturedLogs(async () => {
      const h = setup({ emitThrows: true });
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: ABUSIVE }, CTX, NOW);
    });
    expect(logs).not.toContain("chutiya");
    expect(logs).not.toContain(ABUSIVE);
  });

  it("non-abusive text is untouched by the lexicon — the gateway and classifier still run", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "welding add karo" }, CTX, NOW);
    expect(h.ai.pseudonymize).toHaveBeenCalledWith("welding add karo", CTX);
    expect(h.ai.companionClassify).toHaveBeenCalled();
  });

  describe("the CLASSIFIER path — abuse the lexicon missed", () => {
    it("the fixture is real: the lexicon misses it, so only the classifier can call it faltu", async () => {
      const h = setup();
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: ABUSIVE_MISSED }, CTX, NOW);
      expect(h.ai.pseudonymize).toHaveBeenCalledWith(ABUSIVE_MISSED, CTX);
      expect(h.ai.companionClassify).toHaveBeenCalled();
    });

    it("classified faltu: a strike and the redirect — never memory, never an event, never a log", async () => {
      // The spine refuses both writes, so every error-log path runs too.
      const h = setup({ emitThrows: true });
      const logs = await withCapturedLogs(async () => {
        const turn = await h.orchestrator.handleMessage(
          WORKER,
          PROFILE,
          { text: ABUSIVE_MISSED },
          CTX,
          NOW,
        );
        expect(turn.reply).toBe(V2_FALTU_REDIRECT.latin);
      });

      expect(h.faltuStore.countStrike).toHaveBeenCalled();
      // THE FIX: the classifier path passes no memory pair for faltu, exactly like the lexicon.
      expect(h.memory.append).not.toHaveBeenCalled();
      expect(serializedEvents(h.events)).not.toContain("gadhe");
      expect(logs).not.toContain("gadhe");
      const turnEvent = h.events.emit.mock.calls
        .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
        .find((e) => e.event_name === "chat.companion_turn_served_v2")!;
      expect(turnEvent.payload).toMatchObject({ intent_source: "llm", v2_intent: "faltu" });
    });

    it("classified faltu BELOW the confidence floor (served as unclear) is not stored either", async () => {
      const h = setup({ classifyConfidence: 0.4 });
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: ABUSIVE_MISSED }, CTX, NOW);
      expect(h.faltuStore.countStrike).not.toHaveBeenCalled();
      expect(h.memory.append).not.toHaveBeenCalled();
    });

    it("classified faltu with the FALTU phase off (the phase-off line) is not stored either", async () => {
      const h = setup({ faltuEnabled: false });
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: ABUSIVE_MISSED }, CTX, NOW);
      expect(h.faltuStore.countStrike).not.toHaveBeenCalled();
      expect(h.memory.append).not.toHaveBeenCalled();
    });
  });
});
