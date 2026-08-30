import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import type { LlmTurnResult } from "./llm-turn.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { TRADE_FORM_OFFERS } from "./trade-form-router";

/**
 * ═══ THE TRADE-FORM HANDOVER, END TO END THROUGH THE ORCHESTRATOR ═══
 *
 * `orchestrator.service.test.ts` states as an invariant that the LLM path is OFF in every test in
 * that file, and it is right to: everything it asserts is the deterministic engine, which must
 * behave identically whether Phase A exists or not. The handover is the opposite case — it only
 * happens on an LLM-led turn — so it gets its own world rather than weakening that one.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and what these tests are shaped around:
 *
 *   1. A worker who is NOT a turner must reach the engine completely unchanged. The handover is a
 *      new early return inside the hottest branch in the file, and every non-turner in the country
 *      goes through it.
 *   2. A worker who IS a turner must arrive at the form with their trade ALREADY SETTLED, or the
 *      form opens by asking them the one question they have just answered.
 *   3. The handover must survive a reload. It is stored state, not a per-turn re-derivation.
 *   4. The event must carry no labels. They are the model's free text about a named worker.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-08-29T10:00:00.000Z");
const CTX = { correlationId: "c1", requestId: "r1" };

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
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
    ...partial,
  };
}

const TRADE = item({
  question_key: "primary_trade",
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  is_mandatory: true,
});
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 2,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE, CITY],
};

/** What Phase A hands back on the turn it has named the trade. */
function led(
  domainLabel: string | null,
  roleLabel: string | null,
  kind: "ask" | "done" = "ask",
): LlmTurnResult {
  const patch: Partial<ProfilingEnvelope> = {
    llmStage: kind === "done" ? "done" : "role",
    llmLedTurns: 1,
    llmAsks: 1,
    llmDraft: {
      domain_label: domainLabel,
      role_label: roleLabel,
      skills: [],
      experiences: [],
    },
  };
  return kind === "done"
    ? { kind: "done", patch }
    : { kind: "ask", reply: "Aur kya kaam karte hain?", chips: [], inputMode: "text", patch };
}

function makeWorld(
  turn: LlmTurnResult | null,
  identifyPatch: Partial<ProfilingEnvelope> = {},
) {
  const store = new Map<string, TranscriptBuffer>();
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: { ...emptyProfilingEnvelope(), rev: 1 },
  } as TranscriptBuffer);

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through the REAL narrower, exactly as `ChatTranscriptBuffer.load` does — that is what
      // makes assertion 3 (the handover survives a reload) mean anything at all.
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
  const identify = {
    // DEFAULTS TO A NO-OP, which is what every pre-existing case here wants -- but it is now
    // overridable, because a permanent no-op meant no test in this file ever put a real
    // occupation pin in front of the router, and the pin is half the routing evidence.
    identify: vi.fn(async () => ({ patch: identifyPatch, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    // LEADS UNTIL THE STAGE SAYS OTHERWISE, which is the real `leads()` rule — gating on the
    // stage rather than a flag is what lets the handover switch Phase A off by writing `done`.
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done",
    take: vi.fn(async () => turn),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
  );
  return { orchestrator, store, events, llm, registry };
}

const say = (text: string) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

describe("the trade-form handover", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  describe("a CNC turner", () => {
    it("ends the interview and serves the form offer", async () => {
      const { orchestrator } = makeWorld(led("CNC Machining", "CNC Turner"));
      const result = await orchestrator.takeTurn(say("main cnc turner hoon"));

      expect(result.kind).toBe("close");
      expect(result.complete).toBe(true);
      expect(result.completionReason).toBe("form_handoff");
      expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_turner);
      // No chips and no question: the CTA is the only way forward, which is why the offer is on
      // the result at all rather than being inferred by the client from `completionReason`.
      expect(result.options).toEqual([]);
      expect(result.questionKey).toBeNull();
    });

    it("hands over on the turn the model wanted to ask ANOTHER question", async () => {
      // The routing evidence is complete the moment the trade is named, which is usually a turn
      // the model still intends to keep talking on. Waiting for `done` would cost the worker
      // every remaining Phase A question after we already knew where they were going.
      const { orchestrator } = makeWorld(led("CNC Machining", "CNC Turner", "ask"));
      const result = await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(result.kind).toBe("close");
      expect(result.reply).toBe(TRADE_FORM_OFFERS.cnc_turner.reply);
    });

    it("stores the form kind, so the handover survives a reload", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(saved(store)?.formKind).toBe("cnc_turner");
    });

    it("switches Phase A off for good", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      // `leads()` gates on the stage, so this is the whole of "the LLM is off".
      expect(saved(store)?.llmStage).toBe("done");
      expect(saved(store)?.llmGateOpen).toBe(false);
    });

    it("settles the trade BEFORE ending, so the form does not re-ask it", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade).toBeDefined();
      expect(trade?.status).toBe("answered");
    });

    it("records the handover with counts and NO labels", async () => {
      const { orchestrator, events } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));

      const emitted = events.emit.mock.calls
        .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
        .find((e) => e.event_name === "profile.form_mode_entered");
      expect(emitted).toBeDefined();
      expect(emitted?.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        form_kind: "cnc_turner",
        llm_led_turns: 1,
        asks: 1,
      });
      // THE LABELS ARE THE MODEL'S FREE TEXT ABOUT A NAMED WORKER. They are the routing evidence
      // and they must not follow the routing decision into the audit log.
      expect(JSON.stringify(emitted?.payload)).not.toContain("Turner");
      expect(JSON.stringify(emitted?.payload)).not.toContain("Machining");
    });
  });

  /**
   * ═══ THE PIN REACHING THE ROUTER, WHICH NOTHING HERE USED TO PROVE ═══
   *
   * The bug the owner hit was not in `routeToTradeForm` and not in `identify` — it was that the
   * one carried evidence the other had already produced and the orchestrator never handed over.
   * This file could not have caught it: its `identify` stub was a permanent no-op, so no test in
   * the suite ever put a real occupation pin in front of the router. The interaction that failed
   * in production was untested by construction, in the file whose whole subject it is.
   */
  describe("the occupation pin is routing evidence", () => {
    const PINNED: Partial<ProfilingEnvelope> = {
      occupationFamilyId: "fam_cnc_turning",
      occupation: {
        job_domain_id: "jd_nco_7223_6002",
        label: "CNC Operator-Turning",
        isco_unit_code: "7223",
        match_status: "matched_lexical",
        match_score: 0.97,
        match_layer: "l0_exact",
        pack_id: null,
        pack_version: null,
        catalog_version: "v1",
      },
    };

    it("hands over on the pin alone, with the model still silent", async () => {
      // EXACTLY THE PRODUCTION TURN. The worker types "cnc turning", retrieval pins it, and the
      // model answers by asking about materials without filling either label. Before the pinned
      // label was routing evidence this ran on to the next turn and cost the worker a question
      // they had already answered.
      const { orchestrator } = makeWorld(led(null, null, "ask"), PINNED);
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(result.kind).toBe("close");
      expect(result.completionReason).toBe("form_handoff");
      expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_turner);
    });

    it("persists the form kind and switches Phase A off, same as any handover", async () => {
      const { orchestrator, store } = makeWorld(led(null, null, "ask"), PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      expect(saved(store)?.formKind).toBe("cnc_turner");
      expect(saved(store)?.llmStage).toBe("done");
    });

    it("does NOT hand over when the worker names a competing machine in the same breath", async () => {
      // The veto reads the worker's sentence, which is the only surface their "vmc" appears on:
      // the pin resolves the longest alias span ("cnc turning"), so the label says turner and the
      // model has written nothing. Without this they would get eighteen turning questions having
      // just said they run a machining centre too.
      const { orchestrator } = makeWorld(led(null, null, "ask"), PINNED);
      const result = await orchestrator.takeTurn(say("cnc turning aur vmc dono karta hoon"));

      expect(result.kind).not.toBe("close");
      expect(result.formOffer ?? null).toBeNull();
    });

    it("a pin into some other family still routes nobody", async () => {
      const { orchestrator } = makeWorld(led(null, null, "ask"), {
        occupationFamilyId: "fam_tailoring",
        occupation: { ...PINNED.occupation!, label: "Tailor", job_domain_id: "jd_x" },
      });
      const result = await orchestrator.takeTurn(say("main tailor hoon"));
      expect(result.formOffer ?? null).toBeNull();
    });
  });

  describe("everyone else reaches the engine unchanged", () => {
    it("a VMC operator keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "VMC Setter-cum-Operator"));
      const result = await orchestrator.takeTurn(say("main vmc chalata hoon"));

      expect(result.completionReason).not.toBe("form_handoff");
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
    });

    it("a tailor keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("Garments", "Tailor"));
      const result = await orchestrator.takeTurn(say("main darzi hoon"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
    });

    it("a model that named no trade at all keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("", ""));
      const result = await orchestrator.takeTurn(say("pata nahi"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
    });

    it("a Phase A fallback is untouched by the handover", async () => {
      // `take` returning null is the model going away. The handover sits in the other branch and
      // must not fire here, where there is no draft to route on.
      const { orchestrator, store } = makeWorld(null);
      const result = await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.llmFallback).toBe(true);
    });
  });
});
