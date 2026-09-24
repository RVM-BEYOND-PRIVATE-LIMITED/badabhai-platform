import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  toResumeHistoryStatePatch,
  type ProfilingEnvelope,
} from "./conversation-state";
import { CLOSING_REPLY, ProfilingOrchestrator } from "./orchestrator.service";
import {
  readResumeUpdateOfferReply,
  RESUME_UPDATE_ACCEPTED_REPLY,
  RESUME_UPDATE_OFFER_OPTIONS,
  RESUME_UPDATE_OFFER_PROMPT,
  ResumeUpdateOfferPolicy,
} from "./resume-update-offer";

/**
 * ═══ "AAPKI NAYI JAANKARI SE RESUME UPDATE KAR DOON?" (ADR-0043, ruling R3) ═══
 *
 * A worker who already has a résumé finishes another interview. At the point the engine would
 * close, they are asked whether to update their résumé; "Haan" confirms the profile this
 * interview produces and regenerates in the background, "Abhi nahi" is the close they always got.
 *
 * WHAT IS AT RISK, and what these are shaped around:
 *   1. An INELIGIBLE worker — a first interview, or the switch off — must close byte for byte as
 *      before. The offer is a new early return at the one place every interview ends.
 *   2. The answer turn must read ONLY the answer. A "haan" that reached capture could settle an
 *      unrelated boolean question; one that reached identify could re-pin a trade.
 *   3. An unreadable reply is a NO. A "Haan" spends AI money in the worker's name.
 *   4. The offer must survive a reload — both readers of a reopened session serve it.
 *   5. The acceptance must reach Postgres through the loose `resume_update` key — the only thing
 *      the extraction processor and `GET /resume/history` will ever see.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-09-24T10:00:00.000Z");
const T1 = new Date("2026-09-24T10:02:00.000Z");
const CTX = { correlationId: "c1", requestId: "r1" };

/** The one question left: answering it is what makes the engine close. */
const CITY: QuestionPackItem = {
  question_key: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  display_order: 0,
  target_kind: "rfs",
  target_field: "current_city",
  target_skill_id: null,
  answer_type: "text",
  is_mandatory: false,
  is_core: false,
  max_asks: 1,
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
  version: 2,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [CITY],
};

function makeWorld(opts: { eligible?: boolean; policy?: boolean } = {}) {
  const store = new Map<string, TranscriptBuffer>();
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: {
      ...emptyProfilingEnvelope(),
      rev: 1,
      phase: "universal_tail",
      servedQuestionKey: CITY.question_key,
      askCounts: { [CITY.question_key]: 1 },
      engineAsks: 1,
    },
  } as TranscriptBuffer);

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through the REAL narrower, as `ChatTranscriptBuffer.load` does — so "survives a reload"
      // is tested against the same code that runs in production.
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
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  // Phase A never leads here: the offer sits on the deterministic close.
  const llm = { leads: () => false, take: vi.fn(async () => null) };
  const policy = { eligible: vi.fn(async (_workerId: string) => opts.eligible ?? true) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    {
      pendingForChat: async () => null,
      forImport: async () => new Map(),
      identityForChat: async () => null,
    } as never,
    { findCurrentCity: async () => null } as never,
    undefined,
    opts.policy === false ? undefined : (policy as unknown as ResumeUpdateOfferPolicy),
  );
  return { orchestrator, store, events, policy, buffer, identify };
}

const say = (text: string, now: Date = T0) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

const answered = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls
    .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
    .filter((e) => e.event_name === "profile.resume_update_answered");

describe("the résumé-update offer (ADR-0043)", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  describe("who is asked", () => {
    it("an ELIGIBLE worker is asked where the engine would have closed — the interview is NOT over", async () => {
      const { orchestrator, store, policy } = makeWorld({ eligible: true });
      const result = await orchestrator.takeTurn(say("Pune"));

      expect(policy.eligible).toHaveBeenCalledWith(WORKER);
      expect(result.kind).toBe("ask");
      expect(result.complete).toBe(false);
      expect(result.completionReason).toBeNull();
      expect(result.reply).toBe(RESUME_UPDATE_OFFER_PROMPT);
      expect(result.options).toEqual([...RESUME_UPDATE_OFFER_OPTIONS]);
      expect(result.questionKey).toBeNull();
      expect(result.answerType).toBe("single_select");
      // The interview's whole answer map waits on one tap — checkpoint it.
      expect(result.checkpointDue).toBe(true);
      // The engine's own verdict is carried across the extra turn, and nothing is accepted yet.
      expect(saved(store)?.resumeUpdateOffer).toEqual({
        state: "pending",
        accepted: null,
        completionReason: "complete",
        answeredAt: null,
      });
      expect(saved(store)?.servedQuestionKey).toBeNull();
    });

    it("an INELIGIBLE worker (a first interview, or the switch off) closes exactly as before", async () => {
      const { orchestrator, store } = makeWorld({ eligible: false });
      const result = await orchestrator.takeTurn(say("Pune"));
      expect(result.kind).toBe("close");
      expect(result.complete).toBe(true);
      expect(result.completionReason).toBe("complete");
      expect(result.reply).toBe(CLOSING_REPLY);
      expect(saved(store)?.resumeUpdateOffer).toBeNull();
    });

    it("an orchestrator built WITHOUT the policy closes exactly as before — no offer, no read", async () => {
      const { orchestrator } = makeWorld({ policy: false });
      const result = await orchestrator.takeTurn(say("Pune"));
      expect(result.kind).toBe("close");
      expect(result.reply).toBe(CLOSING_REPLY);
    });
  });

  describe("the answer", () => {
    it("HAAN (the chip key) closes the interview with the update reply and records the acceptance", async () => {
      const { orchestrator, store, events } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      const result = await orchestrator.takeTurn(say("update_offer_yes", T1));

      expect(result.kind).toBe("close");
      expect(result.complete).toBe(true);
      // The reason the ENGINE decided, not one re-derived a turn later.
      expect(result.completionReason).toBe("complete");
      expect(result.reply).toBe(RESUME_UPDATE_ACCEPTED_REPLY);
      expect(saved(store)?.resumeUpdateOffer).toEqual({
        state: "settled",
        accepted: true,
        completionReason: "complete",
        answeredAt: T1.toISOString(),
      });
      expect(answered(events)).toHaveLength(1);
      expect(answered(events)[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        answer: "yes",
      });
    });

    it("an answer whose write is LOST records nothing — the event follows the CAS, never precedes it", async () => {
      const { orchestrator, store, events, buffer } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      // Every write of the answer turn loses the race: the turn did not happen.
      buffer.saveWithCas.mockResolvedValue(false);
      const result = await orchestrator.takeTurn(say("update_offer_yes", T1));
      expect(result.unavailable).toBe(true);
      expect(answered(events)).toHaveLength(0);
      expect(saved(store)?.resumeUpdateOffer?.state).toBe("pending");
    });

    it("an OLD client's label text reads the same as the key", async () => {
      const { orchestrator, store } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      await orchestrator.takeTurn(say(RESUME_UPDATE_OFFER_OPTIONS[0]!.label_text, T1));
      expect(saved(store)?.resumeUpdateOffer?.accepted).toBe(true);
    });

    it("ABHI NAHI closes with the ordinary line and records a NO", async () => {
      const { orchestrator, store, events } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      const result = await orchestrator.takeTurn(say(RESUME_UPDATE_OFFER_OPTIONS[1]!.label_text));
      expect(result.complete).toBe(true);
      expect(result.reply).toBe(CLOSING_REPLY);
      expect(saved(store)?.resumeUpdateOffer?.accepted).toBe(false);
      expect(answered(events)[0]!.payload.answer).toBe("no");
    });

    it("an UNREADABLE reply is a NO — never a yes, and never re-asked", async () => {
      const { orchestrator, store } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      const result = await orchestrator.takeTurn(say("kitna time lagega?"));
      expect(result.complete).toBe(true);
      expect(result.reply).toBe(CLOSING_REPLY);
      expect(saved(store)?.resumeUpdateOffer?.accepted).toBe(false);
    });

    it("the answer turn reads ONLY the answer — it does not reach capture or identify", async () => {
      const { orchestrator, store, identify } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      const before = JSON.stringify(saved(store)?.answerMap);
      identify.identify.mockClear();
      await orchestrator.takeTurn(say("haan"));
      expect(JSON.stringify(saved(store)?.answerMap)).toBe(before);
      expect(identify.identify).not.toHaveBeenCalled();
    });

    it("the acceptance reaches the durable projection the processor and the history read", async () => {
      const { orchestrator, store } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      // PENDING projects NO answer — a question on screen is not an acceptance.
      expect(toResumeHistoryStatePatch(saved(store)!).resume_update).toBeNull();
      await orchestrator.takeTurn(say("update_offer_yes", T1));
      expect(toResumeHistoryStatePatch(saved(store)!)).toEqual({
        import_applied_id: null,
        resume_update: { accepted: true, answered_at: T1.toISOString() },
      });
    });
  });

  describe("a reopened session", () => {
    it("openTurn RE-SERVES the pending offer and writes nothing", async () => {
      const { orchestrator, buffer } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      buffer.saveWithCas.mockClear();
      const reopened = await orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: T1,
        ctx: CTX as never,
      });
      expect(reopened.reply).toBe(RESUME_UPDATE_OFFER_PROMPT);
      expect(reopened.options).toEqual([...RESUME_UPDATE_OFFER_OPTIONS]);
      expect(reopened.complete).toBe(false);
      expect(reopened.replayed).toBe(true);
      expect(buffer.saveWithCas).not.toHaveBeenCalled();
    });

    it("viewSession serves the pending offer, so a voice-form tap resolves to its label", async () => {
      const { orchestrator } = makeWorld();
      await orchestrator.takeTurn(say("Pune"));
      const view = await orchestrator.viewSession(SESSION, T1);
      expect(view?.served).toMatchObject({
        questionKey: null,
        promptText: RESUME_UPDATE_OFFER_PROMPT,
        answerType: "single_select",
      });
      expect(view?.served?.options.map((o) => o.option_key)).toEqual([
        "update_offer_yes",
        "update_offer_no",
      ]);
    });
  });
});

describe("readResumeUpdateOfferReply — only an UNAMBIGUOUS yes is a yes", () => {
  it.each([
    ["update_offer_yes", "accept"],
    ["update_offer_no", "decline"],
    ["Haan, update karein", "accept"],
    ["haan, update karein.", "accept"],
    ["Abhi nahi", "decline"],
    ["haan", "accept"],
    ["Haan ji", "accept"],
    ["ji haan", "accept"],
    ["yes", "accept"],
    ["update kar do", "accept"],
    ["हाँ", "accept"],
    ["nahi", "decline"],
    ["kitna time lagega?", "unclear"],
    ["", "unclear"],
  ])("%j reads as %s", (text, expected) => {
    expect(readResumeUpdateOfferReply(text)).toBe(expected);
  });

  // THE SECURITY-REVIEW REGRESSIONS. Every one of these read as YES through the lexicon's
  // `parseAffirmation` — the parser the boolean pack questions use, which leans toward yes on
  // `theek` / `sahi` / `acha` and verb forms, and counts a negator only in its own clause. Here a
  // yes confirms a profile nobody reviewed and puts it in front of employers.
  it.each([
    "nahi, purana theek hai",
    "pehle wala sahi hai",
    "sahi hai purana wala rakho",
    "purana theek tha",
    "theek hai, baad mein",
    "abhi rehne do, theek hai",
    "main khud kar lunga",
    "haan lekin baad mein",
    "haan?",
    "acha",
    "ok",
    "theek hai",
    "haan nahi",
    "update mat karo",
    "नहीं",
  ])("%j is NOT a yes", (text) => {
    expect(readResumeUpdateOfferReply(text)).not.toBe("accept");
  });

  it("the chip keys cannot collide with anything a shipped client routes on", () => {
    for (const option of RESUME_UPDATE_OFFER_OPTIONS) {
      expect(option.option_key).not.toMatch(/^(resume_|section_)/);
    }
  });
});

describe("ResumeUpdateOfferPolicy", () => {
  const policy = (enabled: boolean, latest: () => Promise<unknown>) =>
    new ResumeUpdateOfferPolicy(
      { RESUME_CHAT_UPDATE_OFFER_ENABLED: enabled } as never,
      { latestResume: vi.fn(latest) } as never,
    );

  it("offers only a worker who already has a résumé, and only while the switch is on", async () => {
    expect(await policy(true, async () => ({ id: "r" })).eligible(WORKER)).toBe(true);
    expect(await policy(true, async () => undefined).eligible(WORKER)).toBe(false);
    expect(await policy(false, async () => ({ id: "r" })).eligible(WORKER)).toBe(false);
  });

  it("the switch OFF costs no read at all", async () => {
    const latest = vi.fn(async () => ({ id: "r" }));
    const p = new ResumeUpdateOfferPolicy(
      { RESUME_CHAT_UPDATE_OFFER_ENABLED: false } as never,
      { latestResume: latest } as never,
    );
    await p.eligible(WORKER);
    expect(latest).not.toHaveBeenCalled();
  });

  it("an unreadable eligibility FAILS TO NO OFFER — the pre-0125 close", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const p = policy(true, async () => {
      throw new Error("pg down");
    });
    expect(await p.eligible(WORKER)).toBe(false);
  });
});
