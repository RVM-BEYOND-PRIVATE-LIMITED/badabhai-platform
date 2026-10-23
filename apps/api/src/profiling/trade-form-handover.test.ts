import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyGeneralRoad,
  emptyProfilingEnvelope,
  emptyTradeConfirm,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import type { LlmTurnResult } from "./llm-turn.service";
import { MAX_ENGINE_TURNS } from "./next-question";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { FORM_OFFER_OPTIONS, offerPrompt } from "./trade-form-offer";
import { TRADE_FORM_OFFERS } from "./trade-form-router";

/**
 * ═══ THE TRADE-FORM OFFER, END TO END THROUGH THE ORCHESTRATOR ═══
 *
 * `orchestrator.service.test.ts` states as an invariant that the LLM path is OFF in every test in
 * that file, and it is right to: everything it asserts is the deterministic engine, which must
 * behave identically whether Phase A exists or not. The offer only happens on an LLM-led turn —
 * so it gets its own world rather than weakening that one.
 *
 * ── WHAT CHANGED WHEN THE GATE BECAME AN OFFER (ruling 2026-09-16) ──────────────────────────
 *
 * The turn the model names a form-enabled trade no longer CLOSES the interview. It serves one
 * question — "form bharkar resume pura karna chahenge?" with Haan/Nahi chips — and the worker
 * answers. Accept runs the exact handover the gate used to run (`completeFormHandover`):
 * settlement first, `formKind` sticky, Phase A off, the close turn with its CTA. Decline
 * settles the offer, writes NOTHING to `formKind`, and the interview picks up on the same
 * bubble. The offer is never served twice.
 *
 * ── WHAT CHANGED WHEN THE TRADE-CONFIRM GATE CAME FIRST ───────────────────────────────────
 *
 * The offer is now served for a CONFIRMED trade: the turn the trade is named serves
 * "<trade> — kya aap yahi kaam karna chahte hain?" first, and the offer follows on the Haan.
 * Every flow below therefore walks two gates — trade-confirm, then form offer — and the
 * pin-only tests prove the pin is gate evidence too, not an offer shortcut.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and what these tests are shaped around:
 *
 *   1. A worker who is NOT a form trade must reach the engine completely unchanged. The offer
 *      is a new early return inside the hottest branch in the file, and every non-turner in the
 *      country goes through it.
 *   2. A worker who IS a form trade must still arrive at the form with their trade ALREADY
 *      SETTLED — the settlement moved, it did not go away.
 *   3. The offer must never be a gate. Declining continues the interview; nothing about the
 *      session may close because the worker said no.
 *   4. The offer must survive a reload. It is stored state, not a per-turn re-derivation.
 *   5. The events must carry no labels. They are the model's free text about a named worker.
 *   6. The offer must not depend on the model answering (#2245). A fallback with a form trade
 *      pinned is offered the form; a fallback with nothing to route on reaches the engine.
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
  // Token-audit fix F3 — CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED. Absent = the double has no such
  // method, which is exactly how every pre-existing case here stays on today's path.
  opts: { offerBeforeModel?: boolean } = {},
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
      // makes assertion 4 (the offer survives a reload) mean anything at all.
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
    // LEADS UNTIL THE STAGE SAYS OTHERWISE OR THE MODEL HAS GONE, which is the real `leads()`
    // rule — gating on the stage rather than a flag is what lets the handover switch Phase A off
    // by writing `done`, and the sticky fallback is what keeps a fallen-back session on the
    // engine for every turn after it (#2245's decline path depends on that).
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done" && !envelope.llmFallback,
    take: vi.fn(async () => turn),
    ...(opts.offerBeforeModel === undefined
      ? {}
      : { tradeOfferBeforeModel: () => opts.offerBeforeModel === true }),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,

    // ADR-0041 RI-5. NO PENDING OFFER is the case every test in this file is about: the
    // interview these assert on must be byte for byte the one a worker without a résumé gets.
    {
      pendingForChat: async () => null,
      forImport: async () => new Map(),
      identityForChat: async () => null,
    } as never,
    // #1504 item 5 (city-seed). No worker record to seed from in this suite.
    { findCurrentCity: async () => null } as never,
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
  knownName: async () => null,
  ctx: CTX as never,
});

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

/** Retrieval's pin for "cnc turning" — the catalogue's label, not anything a model wrote. */
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

type EmittedEvent = { event_name: string; payload: Record<string, unknown> };
const emitted = (
  events: { emit: { mock: { calls: unknown[][] } } },
  name: string,
): EmittedEvent[] =>
  events.emit.mock.calls
    .map(([params]) => params as EmittedEvent)
    .filter((e) => e.event_name === name);

describe("the trade-form offer", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  describe("a CNC turner", () => {
    it("confirms the trade first, then is OFFERED the form — the interview does not end", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      const gated = await orchestrator.takeTurn(say("main cnc turner hoon"));

      // The trade-confirm gate owns the turn the trade is named.
      expect(gated.reply).toBe("CNC Turner — kya aap yahi kaam karna chahte hain?");
      expect(gated.inputMode).toBe("options_only");

      // Haan confirms it, and the offer is served on that same turn.
      const result = await orchestrator.takeTurn(say("Haan"));

      // NOT a close. The gate this replaced ended the interview here; the offer pauses it.
      expect(result.kind).toBe("ask");
      expect(result.complete).toBe(false);
      expect(result.completionReason).toBeNull();
      expect(result.formOffer ?? null).toBeNull();
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(result.options).toEqual([...FORM_OFFER_OPTIONS]);
      expect(result.questionKey).toBeNull();
      // THE SESSION IS STILL THE WORKER'S. Nothing about the road is committed until the
      // worker chooses: no form kind, no closed interview, Phase A still leading.
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "pending" });
      expect(saved(store)?.llmStage).not.toBe("done");
      // The led offer pauses an LLM stretch; `serveFormOffer` leaves `phase` to its caller.
      expect(saved(store)?.phase).toBe("llm_interview");
    });

    it("offers on the turn the trade is confirmed, and spends an ask", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner", "ask"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      // The gate spends no ask; the offer is a question. Hiding it from the count would make
      // the budget stop describing what he was asked.
      expect(saved(store)?.engineAsks).toBe(1);
    });

    it("ACCEPTING runs the handover the gate used to run — settlement, sticky kind, close with CTA", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      const result = await orchestrator.takeTurn(say("form_offer_yes"));

      expect(result.kind).toBe("close");
      expect(result.complete).toBe(true);
      expect(result.completionReason).toBe("form_handoff");
      expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_turner);
      expect(result.options).toEqual([]);
      // THE SETTLEMENT MOVED, IT DID NOT GO AWAY: the form must not open by asking a worker
      // the one question they have already answered.
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade?.status).toBe("answered");
      expect(saved(store)?.formKind).toBe("cnc_turner");
      expect(saved(store)?.llmStage).toBe("done");
      expect(saved(store)?.llmGateOpen).toBe(false);
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "settled" });
    });

    it("accepts a typed 'haan' at either gate — trade-confirm and form offer alike", async () => {
      const { orchestrator } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      // Typed "haan" confirms the trade; the offer is served for the confirmed trade.
      const offered = await orchestrator.takeTurn(say("haan"));
      expect(offered.reply).toBe(offerPrompt("cnc_turner"));
      // And a typed accept takes the offer too — the chip's LABEL text, so this turn is not
      // a byte-identical repeat of the last one (which Layer A would replay on the legacy
      // no-submission-id path; shipped clients send distinct ids per #931).
      const result = await orchestrator.takeTurn(say("Haan, form bharein"));
      expect(result.kind).toBe("close");
      expect(result.completionReason).toBe("form_handoff");
    });

    it("DECLINING continues the interview on the same bubble, commits nothing, and never re-offers", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));

      // SETTLED ON THE OFFER, NOT ON THE ACCEPT — the worker's own words from Phase A. A
      // decline must not walk back into a re-ask of the trade the conversation just named.
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade?.status).toBe("answered");

      const declined = await orchestrator.takeTurn(say("form_offer_no"));
      // THE OFFER IS NOT A GATE. A no must leave the interview exactly where it paused.
      expect(declined.kind).not.toBe("close");
      expect(declined.formOffer ?? null).toBeNull();
      expect(declined.completionReason).not.toBe("form_handoff");
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.llmStage).not.toBe("done");
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "settled" });

      // AND NEVER AGAIN. The draft still names CNC Turner on every later turn; the settled
      // state is what keeps the offer from being served a second time.
      const later = await orchestrator.takeTurn(say("kuch nahi"));
      expect(later.kind).not.toBe("close");
      expect(later.formOffer ?? null).toBeNull();
      expect(later.reply).not.toBe(offerPrompt("cnc_turner"));
    });

    it("treats an unreadable reply as a decline — never a re-ask, and counted apart", async () => {
      const { orchestrator, store, events } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      // "form kya hota hai bhai" is genuinely unreadable by the lexicon — unlike "pata nahi",
      // which it classifies as a decline. The two are counted apart for exactly this reason.
      const result = await orchestrator.takeTurn(say("form kya hota hai bhai"));

      expect(result.kind).not.toBe("close");
      expect(saved(store)?.formOfferPrompt?.state).toBe("settled");
      const declined = emitted(events, "profile.form_offer_declined");
      expect(declined).toHaveLength(1);
      expect(declined[0]!.payload.reply).toBe("unclear");
    });

    it("records the OFFER with counts and NO labels, exactly once", async () => {
      const { orchestrator, events } = makeWorld(led("CNC Machining", "CNC Turner"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      // The decline turn must not emit a second offer row.
      await orchestrator.takeTurn(say("Nahi"));

      const offered = emitted(events, "profile.form_offered");
      expect(offered).toHaveLength(1);
      expect(offered[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        form_kind: "cnc_turner",
        llm_led_turns: 1,
        asks: 1,
      });
      // THE LABELS ARE THE MODEL'S FREE TEXT ABOUT A NAMED WORKER. They are the routing evidence
      // and they must not follow the routing decision into the audit log.
      expect(JSON.stringify(offered[0]!.payload)).not.toContain("Turner");
      expect(JSON.stringify(offered[0]!.payload)).not.toContain("Machining");
    });

    it("records the decline with its reply class, and the accept still records form_mode_entered", async () => {
      const declinedWorld = makeWorld(led("CNC Machining", "CNC Turner"));
      await declinedWorld.orchestrator.takeTurn(say("main cnc turner hoon"));
      await declinedWorld.orchestrator.takeTurn(say("Haan"));
      await declinedWorld.orchestrator.takeTurn(say("form_offer_no"));
      const declined = emitted(declinedWorld.events, "profile.form_offer_declined");
      expect(declined).toHaveLength(1);
      expect(declined[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        form_kind: "cnc_turner",
        reply: "declined",
      });
      expect(emitted(declinedWorld.events, "profile.form_mode_entered")).toHaveLength(0);

      const acceptedWorld = makeWorld(led("CNC Machining", "CNC Turner"));
      await acceptedWorld.orchestrator.takeTurn(say("main cnc turner hoon"));
      await acceptedWorld.orchestrator.takeTurn(say("Haan"));
      await acceptedWorld.orchestrator.takeTurn(say("form_offer_yes"));
      const entered = emitted(acceptedWorld.events, "profile.form_mode_entered");
      expect(entered).toHaveLength(1);
      expect(entered[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        form_kind: "cnc_turner",
        llm_led_turns: 1,
        asks: 1,
      });
      expect(emitted(acceptedWorld.events, "profile.form_offer_declined")).toHaveLength(0);
    });
  });

  /**
   * ═══ TOKEN-AUDIT FIX F3 — A TAPPED HAAN ROUTES BEFORE THE MODEL ═══
   *
   * Today the Haan turn calls the model and then discards its reply in favour of the offer. With
   * the switch on, a TAPPED Haan routes first and makes no call. Everything else — a typed yes
   * with more in it, a trade with no form, the switch off — calls the model exactly as before.
   */
  describe("token-audit fix F3 — the offer before the model on a tapped Haan", () => {
    it("switch OFF (absent or false) is today: the Haan turn calls the model, then offers", async () => {
      for (const opts of [{}, { offerBeforeModel: false }]) {
        const { orchestrator, llm } = makeWorld(led("CNC Machining", "CNC Turner"), {}, opts);
        await orchestrator.takeTurn(say("main cnc turner hoon"));
        const result = await orchestrator.takeTurn(say("Haan"));
        expect(result.reply).toBe(offerPrompt("cnc_turner"));
        expect(llm.take).toHaveBeenCalledTimes(2);
      }
    });

    it("switch ON: a tapped Haan serves the SAME offer and makes no model call", async () => {
      const { orchestrator, llm, store, events } = makeWorld(
        led("CNC Machining", "CNC Turner"),
        {},
        { offerBeforeModel: true },
      );
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(llm.take).toHaveBeenCalledTimes(1);

      const result = await orchestrator.takeTurn(say("Haan"));
      expect(llm.take).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("ask");
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(result.options).toEqual([...FORM_OFFER_OPTIONS]);
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "pending" });
      expect(saved(store)?.phase).toBe("llm_interview");
      // Settled on the offer, as the led path does, so a decline never re-asks the trade.
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade?.status).toBe("answered");
      expect(emitted(events, "profile.form_offered")).toHaveLength(1);
    });

    it("switch ON: the chip KEY counts as a tap too", async () => {
      const { orchestrator, llm } = makeWorld(
        led("CNC Machining", "CNC Turner"),
        {},
        { offerBeforeModel: true },
      );
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      const result = await orchestrator.takeTurn(say("trade_confirm_yes"));
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(llm.take).toHaveBeenCalledTimes(1);
    });

    it("switch ON: a typed yes WITH MORE IN IT still goes to the model, which may record a job", async () => {
      const { orchestrator, llm } = makeWorld(
        led("CNC Machining", "CNC Turner"),
        {},
        { offerBeforeModel: true },
      );
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      const result = await orchestrator.takeTurn(say("haan, 5 saal Maruti mein kiya"));
      expect(llm.take).toHaveBeenCalledTimes(2);
      // ...and the offer is still served on that turn, exactly as today.
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
    });

    it("switch ON: a trade with no form still goes to the model on the Haan", async () => {
      const { orchestrator, llm } = makeWorld(
        led("Tailoring", "Tailor"),
        {},
        { offerBeforeModel: true },
      );
      await orchestrator.takeTurn(say("main tailor hoon"));
      const result = await orchestrator.takeTurn(say("Haan"));
      expect(llm.take).toHaveBeenCalledTimes(2);
      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
    });

    it("switch ON: declining the early offer returns to the model-led chat", async () => {
      const { orchestrator, llm, store } = makeWorld(
        led("CNC Machining", "CNC Turner"),
        {},
        { offerBeforeModel: true },
      );
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      expect(llm.take).toHaveBeenCalledTimes(1);

      const declined = await orchestrator.takeTurn(say("form_offer_no"));
      expect(declined.kind).not.toBe("close");
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "settled" });
      expect(saved(store)?.llmGateOpen).toBe(false);
      // The interview continues where it paused, and the model leads it again.
      expect(llm.take).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * ═══ THE PIN REACHING THE ROUTER, WHICH NOTHING HERE USED TO PROVE ═══
   *
   * The bug the owner hit was not in `routeToTradeForm` and not in `identify` — it was that the
   * one carried evidence the other had already produced and the orchestrator never handed over.
   * This file could not have caught it: its `identify` stub was a permanent no-op, so no test in
   * the suite ever put a real occupation pin in front of the router.
   */
  describe("the occupation pin is routing evidence", () => {
    it("offers on the pin alone, with the model still silent — after the gate confirms it", async () => {
      // EXACTLY THE PRODUCTION TURN. The worker types "cnc turning", retrieval pins it, and the
      // model answers by asking about materials without filling either label. Before the pinned
      // label was routing evidence this ran on to the next turn and cost the worker a question
      // they had already answered. The pin is confirmed by the trade gate first: the offer is
      // served for a trade the worker said Haan to, never for a pin alone.
      const { orchestrator } = makeWorld(led(null, null, "ask"), PINNED);
      const gated = await orchestrator.takeTurn(say("cnc turning"));

      expect(gated.kind).toBe("ask");
      expect(gated.reply).toBe("CNC Operator-Turning — kya aap yahi kaam karna chahte hain?");

      const result = await orchestrator.takeTurn(say("Haan"));
      expect(result.kind).toBe("ask");
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
    });

    it("accepting from the pin persists the form kind and switches Phase A off", async () => {
      const { orchestrator, store } = makeWorld(led(null, null, "ask"), PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      await orchestrator.takeTurn(say("Haan"));
      const result = await orchestrator.takeTurn(say("form_offer_yes"));
      expect(result.completionReason).toBe("form_handoff");
      expect(saved(store)?.formKind).toBe("cnc_turner");
      expect(saved(store)?.llmStage).toBe("done");
    });

    it("does NOT offer when the worker names a competing machine in the same breath", async () => {
      // The veto reads the worker's sentence, which is the only surface their "vmc" appears on:
      // the pin resolves the longest alias span ("cnc turning"), so the label says turner and the
      // model has written nothing. Without this they would get turning questions having just said
      // they run a machining centre too.
      const { orchestrator } = makeWorld(led(null, null, "ask"), PINNED);
      const result = await orchestrator.takeTurn(say("cnc turning aur vmc dono karta hoon"));

      expect(result.kind).not.toBe("close");
      expect(result.formOffer ?? null).toBeNull();
      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
    });

    it("a pin into some other family still routes nobody", async () => {
      const { orchestrator, store } = makeWorld(led(null, null, "ask"), {
        occupationFamilyId: "fam_tailoring",
        occupation: { ...PINNED.occupation!, label: "Tailor", job_domain_id: "jd_x" },
      });
      await orchestrator.takeTurn(say("main tailor hoon"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });
  });

  describe("everyone else reaches the engine unchanged", () => {
    it("a VMC operator keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "VMC Setter-cum-Operator"));
      const result = await orchestrator.takeTurn(say("main vmc chalata hoon"));

      expect(result.completionReason).not.toBe("form_handoff");
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("a tailor keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("Garments", "Tailor"));
      const result = await orchestrator.takeTurn(say("main darzi hoon"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("a model that named no trade at all keeps interviewing", async () => {
      const { orchestrator, store } = makeWorld(led("", ""));
      const result = await orchestrator.takeTurn(say("pata nahi"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("a Phase A fallback with nothing to route on is untouched by the offer", async () => {
      // `take` returning null is the model going away. With no draft and no pin there is no
      // routing evidence, so the fallback's offer (#2245) stays silent and the engine asks.
      const { orchestrator, store } = makeWorld(null);
      const result = await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(result.formOffer ?? null).toBeNull();
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
      expect(saved(store)?.llmFallback).toBe(true);
    });
  });

  /**
   * ═══ THE OFFER OUTLIVES THE MODEL (#2245) ═══
   *
   * Production 2026-10-14: two CNC sessions lost their FIRST Phase A call, fell back for good, and
   * were walked through the fixed turning questions — with the turning pin already on the
   * envelope. Eligibility is deterministic and the pin is retrieval's, so the turn the model goes
   * away serves the same offer the led branch would have. No trade-confirm gate in front of it:
   * from here on the interview is deterministic, and `tradeGateFor` confirms only what a model
   * turn inferred.
   */
  describe("a Phase A fallback with a form trade pinned", () => {
    it("is OFFERED the form on the turn the model goes away — the production case", async () => {
      const { orchestrator, store, llm } = makeWorld(null, PINNED);
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(llm.take).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("ask");
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(result.options).toEqual([...FORM_OFFER_OPTIONS]);
      expect(result.questionKey).toBeNull();
      expect(result.complete).toBe(false);
      expect(saved(store)?.llmFallback).toBe(true);
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "pending" });
      expect(saved(store)?.formKind).toBeNull();
      // THE OFFER IS AN ASK on this path too.
      expect(saved(store)?.engineAsks).toBe(1);
      // `phase` feeds the packs' predicates; a fallen-back session is not in an LLM stretch.
      expect(saved(store)?.phase).not.toBe("llm_interview");
    });

    it("ACCEPTING runs the same handover, settling the trade the worker just said Haan to", async () => {
      const { orchestrator, store } = makeWorld(null, PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      const result = await orchestrator.takeTurn(say("form_offer_yes"));

      expect(result.kind).toBe("close");
      expect(result.completionReason).toBe("form_handoff");
      expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_turner);
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade?.status).toBe("answered");
      expect(saved(store)?.formKind).toBe("cnc_turner");
    });

    it("DECLINING is today's path — the engine asks on, the model is never called again", async () => {
      const { orchestrator, store, llm } = makeWorld(null, PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      const declined = await orchestrator.takeTurn(say("form_offer_no"));

      expect(declined.kind).not.toBe("close");
      expect(declined.formOffer ?? null).toBeNull();
      expect(declined.reply).not.toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formKind).toBeNull();
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "settled" });

      const later = await orchestrator.takeTurn(say("Pune"));
      expect(later.reply).not.toBe(offerPrompt("cnc_turner"));
      // The fallback stays sticky: neither the decline nor the next turn went back to the model.
      expect(llm.take).toHaveBeenCalledTimes(1);
    });

    it("records the offer once, beside the fallback event, with no labels", async () => {
      const { orchestrator, events } = makeWorld(null, PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      await orchestrator.takeTurn(say("form_offer_no"));

      expect(emitted(events, "profile.llm_interview_fallback")).toHaveLength(1);
      const offered = emitted(events, "profile.form_offered");
      expect(offered).toHaveLength(1);
      // A FIRST-TURN fallback: zero led turns. A fallback later in the interview carries its led
      // count, so the funnel tells the two offers apart by the fallback event, not by this field.
      expect(offered[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        form_kind: "cnc_turner",
        llm_led_turns: 0,
        asks: 0,
      });
      expect(JSON.stringify(offered[0]!.payload)).not.toContain("Turning");
    });

    it("does NOT offer when the worker names a competing machine in the same breath", async () => {
      const { orchestrator, store } = makeWorld(null, PINNED);
      const result = await orchestrator.takeTurn(say("cnc turning aur vmc dono karta hoon"));

      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
      expect(saved(store)?.llmFallback).toBe(true);
    });

    it("does NOT offer a trade the worker said Nahi to and has not confirmed a replacement for", async () => {
      const { orchestrator, store } = makeWorld(null, {
        ...PINNED,
        tradeConfirm: { ...emptyTradeConfirm(), pastLabel: "CNC Operator-Turning", rounds: 1 },
      });
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("does NOT offer on the general road's skills lane", async () => {
      const { orchestrator, store } = makeWorld(null, {
        ...PINNED,
        generalRoad: { ...emptyGeneralRoad(), armed: true, lane: "skills" },
      });
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("a pin into some other family still routes nobody", async () => {
      const { orchestrator, store } = makeWorld(null, {
        occupationFamilyId: "fam_tailoring",
        occupation: { ...PINNED.occupation!, label: "Tailor", job_domain_id: "jd_x" },
      });
      await orchestrator.takeTurn(say("main tailor hoon"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
      expect(saved(store)?.llmFallback).toBe(true);
    });

    it("DOES offer once a replacement trade was confirmed after a Nahi", async () => {
      const { orchestrator, store } = makeWorld(null, {
        ...PINNED,
        tradeConfirm: { ...emptyTradeConfirm(), confirmed: true, rounds: 1 },
      });
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "pending" });
    });

    it("does NOT offer on a capped turn — the interview is closing", async () => {
      const { orchestrator, store } = makeWorld(null, PINNED);
      store.set(SESSION, { ...store.get(SESSION)!, turnCount: MAX_ENGINE_TURNS });
      const result = await orchestrator.takeTurn(say("cnc turning"));

      expect(result.reply).not.toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.formOfferPrompt ?? null).toBeNull();
    });

    it("a fallback mid-interview offers too, after settling what Phase A had learned", async () => {
      // Gate served by a led turn, Haan, and THEN the model goes away on the confirmed turn.
      const { orchestrator, store, events, llm } = makeWorld(null, PINNED);
      llm.take.mockResolvedValueOnce(led("CNC Machining", "CNC Turner"));
      const gated = await orchestrator.takeTurn(say("main cnc turner hoon"));
      expect(gated.reply).toBe("CNC Turner — kya aap yahi kaam karna chahte hain?");

      const result = await orchestrator.takeTurn(say("Haan"));
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(saved(store)?.llmFallback).toBe(true);
      const trade = saved(store)?.answerMap.find((a) => a.question_key === "primary_trade");
      expect(trade?.status).toBe("answered");
      expect(emitted(events, "profile.form_offered")[0]!.payload.llm_led_turns).toBe(1);
    });
  });

  /**
   * ═══ A PENDING OFFER SURVIVES A REOPEN, WHOEVER SERVED IT (#2245) ═══
   *
   * Both readers of a reopened session used to find the offer only through `outstandingLlmAsk`,
   * which reads nothing once `leads()` is false — true for an offer served on the fallback turn
   * AND for one served on a led `done`. The reopen then served a pack question with the offer
   * still pending, and the worker's next "haan" to THAT question handed them to the form.
   */
  describe("a pending offer, reopened", () => {
    const open = (orchestrator: ProfilingOrchestrator) =>
      orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: new Date(T0.getTime() + 60_000),
        ctx: CTX as never,
      });

    it("openTurn re-serves a fallback offer, writes nothing, and the Haan still accepts it", async () => {
      const { orchestrator, store } = makeWorld(null, PINNED);
      await orchestrator.takeTurn(say("cnc turning"));
      const before = saved(store);

      const reopened = await open(orchestrator);
      expect(reopened.replayed).toBe(true);
      expect(reopened.reply).toBe(offerPrompt("cnc_turner"));
      expect(reopened.options).toEqual([...FORM_OFFER_OPTIONS]);
      expect(reopened.questionKey).toBeNull();
      // RE-SERVE ONLY: no ask spent, no pack question claimed.
      expect(saved(store)?.rev).toBe(before?.rev);
      expect(saved(store)?.servedQuestionKey ?? null).toBeNull();

      const accepted = await orchestrator.takeTurn(say("form_offer_yes"));
      expect(accepted.completionReason).toBe("form_handoff");
    });

    it("viewSession reports the offer and its chips, so a voice-form tap resolves", async () => {
      const { orchestrator } = makeWorld(null, PINNED);
      await orchestrator.takeTurn(say("cnc turning"));

      const view = await orchestrator.viewSession(SESSION, T0);
      expect(view?.served).toMatchObject({
        questionKey: null,
        promptText: offerPrompt("cnc_turner"),
        answerType: "single_select",
        options: [...FORM_OFFER_OPTIONS],
      });
    });

    it("openTurn re-serves an offer made on a led `done` — the same gap, closed by the same rule", async () => {
      const { orchestrator, store } = makeWorld(led("CNC Machining", "CNC Turner", "done"));
      await orchestrator.takeTurn(say("main cnc turner hoon"));
      await orchestrator.takeTurn(say("Haan"));
      expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_turner", state: "pending" });
      expect(saved(store)?.llmStage).toBe("done");

      const reopened = await open(orchestrator);
      expect(reopened.reply).toBe(offerPrompt("cnc_turner"));
      expect(reopened.options).toEqual([...FORM_OFFER_OPTIONS]);
    });
  });
});
