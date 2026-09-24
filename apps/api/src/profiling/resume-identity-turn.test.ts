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
import { ProfilingOrchestrator } from "./orchestrator.service";
import { TRADE_FORM_OFFERS } from "./trade-form-router";
import { RESUME_IDENTITY_OPTIONS } from "./resume-import/resume-identity";

/**
 * ═══ THE "IS THIS YOU?" TURN (RI-identity) ═══
 *
 * While a staged identity line exists, the worker sees ONLY this turn — the RI-5
 * batch-confirm ("Resume se ye mila … Sahi hai?") stays hidden. Owner rulings pinned
 * here:
 *   1. The identity bubble opens the session (open path) and is offered mid-interview
 *      (turn path) with the same words — one builder, three serve sites.
 *   2. "Haan" settles the identity AND retires the batch-confirm; today's flow continues
 *      behind it (the extraction route lands later). Nothing is prefilled by this turn.
 *   3. "Nahi" — and any unreadable reply — retires the résumé from the chat entirely:
 *      the batch-confirm is settled with it and the ordinary interview continues.
 *   4. The answer is counted once per import (`profile.resume_identity_answered`).
 */

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "44444444-4444-4444-8444-444444444444";
/** A SECOND document, as a re-upload mints — the id is what makes it a fresh claim. */
const NEW_IMPORT = "55555555-5555-4555-8555-555555555555";
const T0 = new Date("2026-09-16T10:00:00.000Z");
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

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 2,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE],
};

const LINE = {
  importId: IMPORT,
  roleKind: "cnc_grinding",
  experienceText: "2 saal 7 mahine ka tajurba",
  summaryText: "CNC cylindrical grinder par kaam",
};
const IDENTITY_REPLY =
  "Resume se ye mila: CNC Grinding Operator, 2 saal 7 mahine ka tajurba. " +
  "CNC cylindrical grinder par kaam Kya ye aap hi hain?";

function makeWorld(
  opts: {
    identity?: typeof LINE | null;
    route?: { route: string | null; formKind: string | null } | null;
    seed?: Partial<ProfilingEnvelope>;
    /** The BUFFER's turn counter — NOT the envelope's, which has no such field. */
    turnCount?: number;
  } = {},
) {
  const store = new Map<string, TranscriptBuffer>();
  const seeded: ProfilingEnvelope = { ...emptyProfilingEnvelope(), rev: 1, ...opts.seed };
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: opts.turnCount ?? 0,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: seeded,
  } as TranscriptBuffer);

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through the REAL narrower, as `ChatTranscriptBuffer.load` does.
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
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done",
    take: vi.fn(async () => null),
  };
  const resume = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
    identityForChat: vi.fn(async () => opts.identity ?? null),
    routeForImport: vi.fn(async () => opts.route ?? null),
  };

  // RI-AUTOFILL. Applies staged mappings on the Haan; every existing test asserts the
  // handover/interview that follows, which must be byte for byte what it always was.
  const autofill = {
    applyOnHaan: vi.fn(async () => ({ mapped: 0, applied: 0, skippedAnswered: 0 })),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    resume as never,
    { findCurrentCity: async () => null } as never,
    autofill as never,
  );
  return { orchestrator, store, events, buffer, resume, autofill };
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

const open = () => ({ sessionId: SESSION, workerId: WORKER, now: T0, ctx: CTX as never });

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

const emitted = (events: { emit: { mock: { calls: unknown[][] } } }, name: string) =>
  events.emit.mock.calls
    .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
    .filter((e) => e.event_name === name);

describe("the résumé identity turn (RI-identity)", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

  it("opens the session on the identity bubble with its own two chips", async () => {
    const { orchestrator, store } = makeWorld({ identity: LINE });
    const result = await orchestrator.openResumeConfirm(open());

    expect(result).not.toBeNull();
    expect(result!.reply).toBe(IDENTITY_REPLY);
    expect(result!.kind).toBe("ask");
    expect(result!.questionKey).toBeNull();
    expect(result!.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
    expect(result!.answerType).toBe("single_select");

    expect(saved(store)?.resumeIdentity).toEqual({ importId: IMPORT, state: "pending" });
    // IT SPENDS AN ASK, AND MUST — it is a question the worker can decline.
    expect(saved(store)?.engineAsks).toBe(1);
    expect(store.get(SESSION)!.messages).toHaveLength(1);
    expect(store.get(SESSION)!.turnCount).toBe(0);
  });

  it("a second open re-serves the identity WITHOUT spending a second ask", async () => {
    const { orchestrator, store } = makeWorld({ identity: LINE });
    await orchestrator.openResumeConfirm(open());

    const again = await orchestrator.openTurn(open());

    expect(again.reply).toBe(IDENTITY_REPLY);
    expect(again.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
    expect(again.replayed).toBe(true);
    expect(saved(store)?.engineAsks).toBe(1);
    expect(store.get(SESSION)!.messages).toHaveLength(1);
  });

  it("is offered on the turn path too, when the session never opened on it", async () => {
    const { orchestrator } = makeWorld({
      identity: LINE,
      seed: { resumeIdentity: null },
    });
    // A fresh session answering its first question through the turn path (no open call).
    const result = await orchestrator.takeTurn(say("Namaste"));

    expect(result.reply).toBe(IDENTITY_REPLY);
    expect(result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ option_key: "resume_identity_yes" }),
        expect.objectContaining({ option_key: "resume_identity_no" }),
      ]),
    );
  });

  it("Haan on a chat-routed import settles, applies staged mappings, counts yes, interviews on", async () => {
    const { orchestrator, store, events, autofill } = makeWorld({
      identity: LINE,
      route: { route: "chat", formKind: null },
    });
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_identity_yes"));

    expect(saved(store)?.resumeIdentity?.state).toBe("settled");
    // ONLY THE NEW ONE: the old batch-confirm is retired with the identity answer.
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    // THE AUTOFILL RUNS ON EVERY HAAN, form-routed or not — the service itself no-ops
    // on a chat route. The interview's own answer map is untouched by it either way:
    // autofill writes form rows, never chat answers.
    expect(autofill.applyOnHaan).toHaveBeenCalledTimes(1);
    expect(autofill.applyOnHaan).toHaveBeenCalledWith(WORKER, IMPORT, expect.anything());
    expect(saved(store)?.answerMap ?? []).toHaveLength(0);
    const answered = emitted(events, "profile.resume_identity_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toMatchObject({ import_id: IMPORT, answer: "yes" });
    // No batch-confirm event: the old turn never ran.
    expect(emitted(events, "profile.resume_prefill_applied")).toHaveLength(0);
    // THE INTERVIEW CONTINUES in the same bubble, on the trade question the résumé
    // described but the worker has not yet claimed.
    expect(result.kind).toBe("ask");
    expect(result.reply).not.toBe(IDENTITY_REPLY);
    expect(result.questionKey).toBe("primary_trade");
    // ADR-0043 (ruling R1): the worker claimed this CV, so the résumé this interview makes is
    // labelled `resume_upload` — on the chat road as much as the form one.
    expect(saved(store)?.importAppliedId).toBe(IMPORT);
  });

  it("Haan on a form-routed import autofills first, then hands over to its form with the same CTA card", async () => {
    const { orchestrator, store, events, autofill } = makeWorld({
      identity: LINE,
      route: { route: "form", formKind: "cnc_grinding" },
    });
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_identity_yes"));

    // Identity AND old confirm both settled — the worker answered, the résumé is claimed.
    expect(saved(store)?.resumeIdentity?.state).toBe("settled");
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    expect(emitted(events, "profile.resume_identity_answered")).toHaveLength(1);
    // THE AUTOFILL RUNS BEFORE THE HANDOVER, so the form the worker lands on is filled.
    expect(autofill.applyOnHaan).toHaveBeenCalledTimes(1);
    // THE HANDOVER, byte for byte the offer-accept path's: close turn, CTA card, handoff
    // event, durable answers before the worker leaves for the form.
    expect(result.kind).toBe("close");
    expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_grinding);
    expect(saved(store)?.formKind).toBe("cnc_grinding");
    expect(saved(store)?.formOfferPrompt).toEqual({ kind: "cnc_grinding", state: "settled" });
    // ADR-0043 (ruling R1): set BEFORE the handover, so the flush that ends this session into the
    // form persists it and the form's résumé is labelled `resume_upload` too.
    expect(saved(store)?.importAppliedId).toBe(IMPORT);
  });

  it("Haan with an unresolvable form kind falls through to the interview, never a bad handover", async () => {
    const { orchestrator, store } = makeWorld({
      identity: LINE,
      route: { route: "form", formKind: "retired_kind" },
    });
    await orchestrator.openResumeConfirm(open());

    // A stored kind no form serves is a "no form" — the narrow fails closed and the
    // interview continues rather than handing over to a surface that does not exist.
    const result = await orchestrator.takeTurn(say("resume_identity_yes"));

    expect(result.kind).toBe("ask");
    expect(result.questionKey).toBe("primary_trade");
    expect(saved(store)?.formKind ?? null).toBeNull();
  });

  it("Nahi retires the résumé from the chat entirely and counts no", async () => {
    const { orchestrator, store, events, autofill } = makeWorld({ identity: LINE });
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_identity_no"));

    expect(saved(store)?.resumeIdentity?.state).toBe("settled");
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    expect(saved(store)?.answerMap ?? []).toHaveLength(0);
    const answered = emitted(events, "profile.resume_identity_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toMatchObject({ import_id: IMPORT, answer: "no" });
    expect(emitted(events, "profile.resume_prefill_applied")).toHaveLength(0);
    // A NAHI NEVER AUTOFILLS — the résumé leaves the chat, and nothing about it is written.
    expect(autofill.applyOnHaan).not.toHaveBeenCalled();
    // IGNORE + NORMAL CHAT: the trade question comes back as if no résumé existed.
    expect(result.kind).toBe("ask");
    expect(result.questionKey).toBe("primary_trade");
    // ADR-0043: a CV the worker denied did not make their résumé — no `resume_upload` label.
    expect(saved(store)?.importAppliedId ?? null).toBeNull();
  });

  it("an autofill throw costs the prefill, never the handover", async () => {
    const { orchestrator, store, autofill } = makeWorld({
      identity: LINE,
      route: { route: "form", formKind: "cnc_grinding" },
    });
    autofill.applyOnHaan.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_identity_yes"));

    // FAIL-OPEN: the handover the worker was promised still runs, on the unfilled form.
    expect(result.kind).toBe("close");
    expect(result.formOffer).toEqual(TRADE_FORM_OFFERS.cnc_grinding);
    expect(saved(store)?.formKind).toBe("cnc_grinding");
  });

  it("an unreadable reply is a NO, never a yes", async () => {
    const { orchestrator, store, events } = makeWorld({ identity: LINE });
    await orchestrator.openResumeConfirm(open());

    await orchestrator.takeTurn(say("5 saal"));

    expect(saved(store)?.resumeIdentity?.state).toBe("settled");
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    const answered = emitted(events, "profile.resume_identity_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toMatchObject({ answer: "no" });
    // ADR-0043: an unreadable reply is a no here too — no `resume_upload` label.
    expect(saved(store)?.importAppliedId ?? null).toBeNull();
  });

  it("no staged line ⇒ the ordinary opening, never the identity bubble", async () => {
    const { orchestrator, store } = makeWorld({ identity: null });
    const result = await orchestrator.openResumeConfirm(open());

    // No identity to announce: the open path must not label the first pack question as one.
    expect(result).toBeNull();
    expect(saved(store)?.resumeIdentity ?? null).toBeNull();
    expect(store.get(SESSION)!.messages).toHaveLength(0);
  });

  it("a RE-UPLOAD re-opens the identity turn — a new document is a fresh claim", async () => {
    // THE DEFECT THIS PINS (found 2026-09-21). The gate used to be "ever settled", so a
    // worker who re-uploaded a corrected résumé mid-session was never asked about the new
    // document — and, because the Haan is what runs the autofill, its mapping never
    // applied. Symptom: "I uploaded a résumé and no chip was pre-selected."
    const { orchestrator, store } = makeWorld({
      identity: LINE,
      seed: { resumeIdentity: { importId: IMPORT, state: "settled" } },
    });

    // Same import ⇒ never asked twice.
    const sameImport = await orchestrator.openResumeConfirm(open());
    expect(sameImport).toBeNull();

    // New import ⇒ a new question, asked once.
    const fresh = makeWorld({
      identity: { ...LINE, importId: NEW_IMPORT },
      seed: { resumeIdentity: { importId: IMPORT, state: "settled" } },
    });
    const result = await fresh.orchestrator.openResumeConfirm(open());
    expect(result).not.toBeNull();
    expect(result!.reply).toBe(IDENTITY_REPLY);
    expect(saved(fresh.store)?.resumeIdentity).toEqual({
      importId: NEW_IMPORT,
      state: "pending",
    });
    // The old session's marker is untouched — this is a different envelope.
    expect(saved(store)?.resumeIdentity).toEqual({ importId: IMPORT, state: "settled" });
  });

  it("a re-upload mid-interview re-offers on the TURN path, and its Haan autofills the NEW import", async () => {
    const { orchestrator, store, autofill } = makeWorld({
      identity: { ...LINE, importId: NEW_IMPORT },
      route: { route: "form", formKind: "cnc_grinding" },
      seed: {
        resumeIdentity: { importId: IMPORT, state: "settled" },
        resumeConfirm: { importId: IMPORT, state: "settled" },
      },
      // A session already past its opening turn: only the turn path can offer.
      turnCount: 1,
    });

    const offered = await orchestrator.takeTurn(say("7 saal"));
    expect(offered.reply).toBe(IDENTITY_REPLY);
    expect(saved(store)?.resumeIdentity).toEqual({ importId: NEW_IMPORT, state: "pending" });

    const haan = await orchestrator.takeTurn(say("resume_identity_yes"));
    // THE AUTOFILL IS NAMED THE NEW IMPORT — never the settled one. Serving the newer
    // line under the old id would have applied the previous document's mapping.
    expect(autofill.applyOnHaan).toHaveBeenCalledWith(WORKER, NEW_IMPORT, expect.anything());
    expect(haan.kind).toBe("close");
  });
});
