import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { V2_FALTU_REDIRECT } from "../companion-replies";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import type { CompanionEditService } from "./companion-edit.service";

/**
 * ADR-0046 P2 (O11) — the abusive message never leaves the request:
 *   - the LEXICON answers it locally: no gateway call, no classifier, no model;
 *   - it is never appended to memory (the orchestrator passes no memory pair);
 *   - the only trace is `chat.companion_faltu_strike`, which carries a count and a boolean;
 *   - no log line contains it, even when the strike event itself fails to write.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-09-29T10:00:00.000Z");
const PROFILE = { id: "p1", workerId: WORKER } as never;
/** A phrase the abuse lexicon matches (packages/profiling-lexicon predicates). */
const ABUSIVE = "chutiya bhai kya kar raha hai";

function setup(opts: { emitThrows?: boolean } = {}) {
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: "masked", blocked: false })),
    companionClassify: vi.fn(async () => ({ intent: "faltu", confidence: 0.9, blocked: false })),
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
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
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
  );
  return { orchestrator, ai, memory, events, faltuStore };
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
});
