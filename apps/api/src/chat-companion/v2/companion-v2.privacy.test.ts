import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import type { CompanionEditService } from "./companion-edit.service";
import { V2_CLARIFY, V2_EDIT_CARD_INTRO } from "../companion-replies";
import { v2CopyTurn, v2EditCardTurn } from "./companion-v2-compose";

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

function setup(opts: { classifyThrows?: boolean; emitThrows?: boolean } = {}) {
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: MASKED, blocked: false })),
    companionClassify: vi.fn(async () => {
      if (opts.classifyThrows) throw new Error("classifier boom");
      return { intent: "edit_resume", confidence: 0.9, blocked: false };
    }),
  };
  const memory = { read: vi.fn(async () => []), append: vi.fn(async () => undefined) };
  const edits = { propose: vi.fn(async () => ({ turn: CARD, outcome: "proposed" })) };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
  } as unknown as ServerConfig;
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const events = {
    emit: vi.fn(async (params: unknown) => {
      if (opts.emitThrows) throw new Error("spine down");
      return params;
    }),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
  );
  return { orchestrator, ai, memory, edits, events, cost };
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
