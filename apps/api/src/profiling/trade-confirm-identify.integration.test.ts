/**
 * The trade-confirm gate's Haan, through the REAL `IdentifyService` (#2346).
 *
 * WHY THIS FILE EXISTS SEPARATELY, for the reason `identify-offer-liveness.integration.test.ts`
 * gives: the LLM-led suites stub `identify` as a no-op, so the defect is invisible to them. The
 * gate (`orchestrator.service.ts`) lets its Haan fall through into identification by design, and
 * `identify.service.ts` decided what to do with the word "Haan" — only with both real does the
 * worker see the chips.
 *
 * THE SESSION, FROM A DEVICE. The opener named carpentry in a long sentence the ladder could not
 * pin; the model inferred "Carpenter"; the gate asked "Carpenter — kya aap yahi kaam karna chahte
 * hain?"; the worker tapped Haan; and the next bubble was "Aap in mein se kaun sa kaam karte
 * hain?" over dhaan / hastshilp / Pressman — the ladder had run on "Haan" and reached the paddy
 * alias "dhaan".
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
import { tradeConfirmPrompt } from "./trade-confirm";

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

const OPENER =
  "mujhe achi salary chaiye abhi mai kuch nahi karta phele carpenter ka kaam kiya hai " +
  "abhi mai kya chiz mai resume banau";

/** The model's turn: it has inferred the trade and asks its next question. */
const CARPENTER_ASK: LlmTurnResult = {
  kind: "ask",
  reply: "Aap kitne saal se carpenter ka kaam kar rahe hain?",
  chips: [],
  inputMode: "text",
  patch: {
    llmStage: "skills",
    llmAsks: 1,
    llmLedTurns: 1,
    llmDraft: { domain_label: "Carpentry", role_label: "Carpenter", skills: [], experiences: [] },
  },
};

/** Retrieval as measured: the opener reaches nothing, "Haan" reaches the paddy alias and two rivals. */
function resolveFor(text: string) {
  const base = {
    catalogVersion: "cat_2026_10",
    pinned: null,
    candidates: [],
    embedSpent: false,
  };
  if (text.trim().toLowerCase() === "haan") {
    return {
      ...base,
      status: "disambiguate" as const,
      needsDisambiguation: true,
      disambiguationOptions: [
        { jobDomainId: "jd_nco_6111_0101", familyId: "fam_agriculture", label: "dhaan" },
        { jobDomainId: "jd_handicraft", familyId: "fam_handicraft", label: "hastshilp" },
        { jobDomainId: "jd_pressman", familyId: "fam_printing", label: "Pressman" },
      ],
      reason: "L2 trigram: three families within the margin",
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

function makeWorld() {
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
  const llm = {
    // `LlmTurnService.leads` minus the flag, as `llm-interview.orchestrator.test.ts` stubs it.
    leads: vi.fn((envelope: ProfilingEnvelope) => envelope.llmStage !== "done"),
    take: vi.fn(async () => CARPENTER_ASK),
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
  return { orchestrator, store, occupation };
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

describe("Haan to the trade-confirm gate never re-asks the trade (#2346)", () => {
  it("serves the model's next question, not 'Aap in mein se kaun sa kaam karte hain?'", async () => {
    const { orchestrator, store, occupation } = makeWorld();

    const gate = await orchestrator.takeTurn(say(OPENER, T0));
    expect(gate.reply).toContain(tradeConfirmPrompt("Carpenter"));

    const afterHaan = await orchestrator.takeTurn(say("Haan", new Date(T0.getTime() + MINUTE)));

    expect(afterHaan.kind).not.toBe("disambiguate");
    expect(afterHaan.reply).not.toContain(DISAMBIGUATION_PROMPT);
    expect(afterHaan.options.map((o) => o.label_text)).not.toContain("dhaan");
    // The ladder ran on the opener (it is how the gate's trade could have been pinned) and never
    // on the word that answered the gate.
    expect(occupation.resolve.mock.calls.map(([text]) => text)).toEqual([OPENER]);

    const saved = store.get(SESSION)?.profiling;
    expect(saved?.tradeConfirm.confirmed).toBe(true);
    expect(saved?.needsDisambiguation).toBe(false);
    expect(saved?.disambiguationOffer).toEqual([]);
  });

  it("stays off for the rest of the interview — a later 'haan' re-asks nothing either", async () => {
    const { orchestrator, occupation } = makeWorld();
    await orchestrator.takeTurn(say(OPENER, T0));
    await orchestrator.takeTurn(say("Haan", new Date(T0.getTime() + MINUTE)));

    const later = await orchestrator.takeTurn(say("haan", new Date(T0.getTime() + 2 * MINUTE)));

    expect(later.kind).not.toBe("disambiguate");
    expect(later.reply).not.toContain(DISAMBIGUATION_PROMPT);
    expect(occupation.resolve).toHaveBeenCalledTimes(1);
  });
});
