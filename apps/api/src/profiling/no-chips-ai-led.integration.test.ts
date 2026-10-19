/**
 * No trade-disambiguation chips in an AI-led session (#2353).
 *
 * WHY THIS FILE EXISTS SEPARATELY, for the reason `identify-offer-liveness.integration.test.ts`
 * gives: the LLM-led suites stub `identify` as a no-op, so the defect is invisible to them. The
 * orchestrator passes `offerChips` from `leads() || llmLedTurns > 0`, and `identify.service.ts`
 * decides what a `disambiguate` becomes — only with both real does the worker stop seeing the
 * chips.
 *
 * THE SESSION, FROM A DEVICE. The worker typed "Carpenter" and got "Aap in mein se kaun sa kaam
 * karte hain?" with chips badhai / shuttering helper / Kuch aur; in a second chat the chips came
 * AND THEN the trade-confirm question too, so the trade was asked twice. Owner ruling 2026-10-19:
 * these chips are old fixed-interview behaviour — the trade-confirm gate settles the trade, so an
 * interview the model leads takes the trade directly and starts.
 *
 * STUBBED AT THE BOUNDARIES ONLY: `OccupationService` (retrieval), `AiService.pseudonymize`, and
 * the model (`LlmTurnService`'s own `ask` contract). `IdentifyService` and `ProfilingOrchestrator`
 * are real, wired as `ProfilingModule` wires them.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import { narrowProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";
import { DISAMBIGUATION_PROMPT, IdentifyService } from "./identify.service";
import type { LlmTurnResult } from "./llm-turn.service";
import { ProfilingOrchestrator } from "./orchestrator.service";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-19T05:30:00.000Z");
const MINUTE = 60_000;

const CITY: QuestionPackItem = {
  question_key: "q_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  display_order: 0,
  target_kind: "rfs",
  target_field: "current_city",
  target_skill_id: null,
  answer_type: "text",
  is_mandatory: true,
  is_core: false,
  max_asks: 2,
  min_turn: null,
  max_turn: null,
  ask_if: null,
  skip_if: null,
  parent_item_key: null,
  retry_text: null,
  why_text: null,
  options: [],
};
const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 1,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [CITY],
};

const OPENER = "mujhe kaam chahiye";

/** The model's turn: a plain next question naming NO trade, so no gate fires. */
function modelAsk(n: number): LlmTurnResult {
  return {
    kind: "ask",
    reply: `Model question ${n}: aap kitne saal se kaam kar rahe hain?`,
    chips: [],
    inputMode: "text",
    patch: {
      llmStage: "skills",
      llmAsks: n,
      llmLedTurns: n,
      llmDraft: { domain_label: null, role_label: null, skills: [], experiences: [] },
    },
  };
}

/** Retrieval as measured: "Carpenter" reaches badhai and the shuttering helper, two families. */
function resolveFor(text: string) {
  const base = {
    catalogVersion: "cat_2026_10",
    pinned: null,
    candidates: [],
    embedSpent: false,
  };
  if (text.trim().toLowerCase() === "carpenter") {
    return {
      ...base,
      status: "disambiguate" as const,
      needsDisambiguation: true,
      disambiguationOptions: [
        { jobDomainId: "jd_nco_7115_0100", familyId: "fam_carpentry", label: "badhai" },
        {
          jobDomainId: "jd_nco_9313_0401",
          familyId: "fam_helpers",
          label: "shuttering helper",
        },
      ],
      reason: "two families, no family margin",
    };
  }
  return {
    ...base,
    status: "unresolved" as const,
    needsDisambiguation: false,
    disambiguationOptions: [],
    reason: "nothing cleared the floor",
  };
}

function makeWorld(opts: { aiLed: boolean }) {
  const store = new Map<string, TranscriptBuffer>();
  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      const current = store.get(id)?.profiling?.rev ?? 0;
      if (current !== expectedRev) return false;
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
  };
  const registry = {
    loadUniversal: vi.fn(async () => UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const occupation = {
    resolve: vi.fn(async (text: string) => resolveFor(text)),
    recordUnresolved: vi.fn(async () => ({ count: 1 })),
    describeDomain: vi.fn(() => null),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: "stub", blocked: false })),
  };
  const identify = new IdentifyService(occupation as never, events as never, ai as never);
  let asks = 0;
  const llm = {
    // AI-led: the model leads every turn. Fixed: it never led — the deterministic interview.
    leads: vi.fn((_envelope: ProfilingEnvelope) => opts.aiLed),
    take: vi.fn(async () => {
      asks += 1;
      return modelAsk(asks);
    }),
  };
  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify,
    { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) } as never,
    events as never,
    llm as never,
    {
      pendingForChat: async () => null,
      forImport: async () => new Map(),
      identityForChat: async () => null,
    } as never,
    { findCurrentCity: async () => null } as never,
  );
  return { orchestrator, store, occupation, events };
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };
const say = (text: string, at: Date) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId: null,
  voiceNoteId: null,
  knownName: async () => null,
  ctx: CTX as never,
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("no trade chips in an AI-led session (#2353)", () => {
  it("an ambiguous 'Carpenter' is answered by the model, not by chips", async () => {
    const { orchestrator, store, occupation, events } = makeWorld({ aiLed: true });

    const first = await orchestrator.takeTurn(say(OPENER, T0));
    expect(first.reply).toBe("Model question 1: aap kitne saal se kaam kar rahe hain?");

    const second = await orchestrator.takeTurn(say("Carpenter", new Date(T0.getTime() + MINUTE)));

    // THE DEVICE DEFECT, asserted absent: no disambiguation turn, no chips, no prompt text.
    expect(second.kind).not.toBe("disambiguate");
    expect(second.reply).not.toContain(DISAMBIGUATION_PROMPT);
    expect(second.options.map((o) => o.label_text)).not.toContain("badhai");
    // The model's turn is served instead.
    expect(second.reply).toBe("Model question 2: aap kitne saal se kaam kar rahe hain?");
    // The ladder ran once on the word, and the suppressed offer spent nothing and emitted
    // nothing — only the opener's miss sits on the attempt counter.
    expect(occupation.resolve.mock.calls.map(([text]) => text)).toEqual([OPENER, "Carpenter"]);
    expect(events.emit).not.toHaveBeenCalled();
    expect(store.get(SESSION)?.profiling?.identifyAttempts).toBe(1);
    expect(store.get(SESSION)?.profiling?.needsDisambiguation).toBe(false);
  });

  it("Haan continues the interview — nothing re-asks the trade", async () => {
    const { orchestrator } = makeWorld({ aiLed: true });
    await orchestrator.takeTurn(say(OPENER, T0));
    await orchestrator.takeTurn(say("Carpenter", new Date(T0.getTime() + MINUTE)));

    const third = await orchestrator.takeTurn(say("Haan", new Date(T0.getTime() + 2 * MINUTE)));

    expect(third.kind).not.toBe("disambiguate");
    expect(third.reply).not.toContain(DISAMBIGUATION_PROMPT);
    expect(third.reply).toBe("Model question 3: aap kitne saal se kaam kar rahe hain?");
  });

  it("the fixed interview still gets the chips (decision A)", async () => {
    // AI off from the start: `leads()` false and `llmLedTurns` 0, so `offerChips` stays true.
    const { orchestrator } = makeWorld({ aiLed: false });

    const turn = await orchestrator.takeTurn(say("Carpenter", T0));

    expect(turn.kind).toBe("disambiguate");
    expect(turn.reply).toContain(DISAMBIGUATION_PROMPT);
    expect(turn.options.map((o) => o.label_text)).toEqual(
      expect.arrayContaining(["badhai", "shuttering helper", "Kuch aur"]),
    );
  });
});
