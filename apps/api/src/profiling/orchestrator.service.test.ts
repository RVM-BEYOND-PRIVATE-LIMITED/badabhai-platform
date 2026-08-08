import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import {
  QuestionPackOptionSchema,
  type QuestionPack,
  type QuestionPackItem,
  type QuestionPackOption,
} from "@badabhai/ai-contracts";
import { DISAMBIGUATION_ESCAPE_KEY, DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  inboundHash,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import { DISAMBIGUATION_PROMPT, toPackOption } from "./identify.service";
import {
  MAX_ABUSIVE_TURNS,
  MAX_CONSECUTIVE_CLARIFIES,
  MAX_CONSECUTIVE_HARDSHIP,
  MAX_ENGINE_TURNS,
  MAX_SILENT_TURNS,
} from "./next-question";
import {
  CHECKPOINT_EVERY_ASKS,
  CLOSING_REPLY,
  DE_ESCALATION_REPLY,
  HARDSHIP_REPLIES,
  ProfilingOrchestrator,
  UNAVAILABLE_REPLY,
} from "./orchestrator.service";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-08-06T10:00:00.000Z");

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

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 1,
    family_id: "fam_welding",
    locale: "hi-IN",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

const CITY = item({
  question_key: "q_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  why_text: "Sheher se aas paas ki naukri dhundhne mein aasani hoti hai.",
  retry_text: "Sheher ka naam bataiye.",
  is_mandatory: true,
});
const YEARS = item({
  question_key: "q_years",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Kitne saal ka kaam ka tajurba hai?",
});
const PROCESS = item({ question_key: "q_process", prompt_text: "Kaunsi welding karte hain?" });

const OCCUPATION_PACK = pack("qp_welding", [PROCESS]);
const UNIVERSAL_PACK = pack("qp_universal", [CITY, YEARS]);

/**
 * A whole world in one object: an in-memory Redis honouring the CAS, and a pack registry.
 *
 * `interject` runs BETWEEN a turn's read and its write, which is the only way to reproduce a lost
 * update deterministically — a real concurrent writer cannot be scheduled from a test.
 */
function makeWorld(
  opts: {
    packs?: { occupation: QuestionPack | null; universal: QuestionPack | null };
    interject?: (store: Map<string, TranscriptBuffer>) => void;
    /** Pre-existing durable pin, as `chat_sessions` would hold it after an envelope eviction. */
    storedPin?: { packId: string; packVersion: number } | null;
    /** Make the durable pin write fail, to prove a turn survives it. */
    pinThrows?: boolean;
    /** Retrieval came back ambiguous: chips on screen instead of a pack question (#695). */
    identifyOffer?: { prompt: string; options: QuestionPackOption[] } | null;
  } = {},
) {
  const store = new Map<string, TranscriptBuffer>();
  const packs = opts.packs ?? { occupation: null, universal: UNIVERSAL_PACK };
  let interjected = false;

  const buffer = {
    // THROUGH THE REAL NARROWER, because that is what `ChatTranscriptBuffer.load` does and it is
    // not a formality: `narrowProfilingEnvelope` re-validates every cached field against the
    // contract, and a JSON round-trip alone reports whatever was written. A fake that skipped it
    // let a cached offer whose chips the contract REJECTS look intact in tests and arrive empty in
    // production — the exact gap that hid the `occ_0` key.
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      if (opts.interject && !interjected) {
        interjected = true;
        opts.interject(store);
      }
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
    loadUniversal: vi.fn(async () => packs.universal),
    loadPinned: vi.fn(async () => packs.occupation),
    resolveForOccupation: vi.fn(async () => packs.occupation),
  };
  // The identify step is STUBBED TO A NO-OP here on purpose. These tests are about the turn
  // machinery — CAS, replay, bounded re-ask, hard cases — and letting real retrieval run would
  // make every one of them depend on the occupation catalogue. Identification has its own suite.
  const identify = {
    identify: vi.fn(async () => ({
      patch: {},
      offer: opts.identifyOffer ?? null,
      pinned: null,
    })),
  };

  // `chat_sessions`, reduced to the two things the orchestrator is allowed to do to it: read the
  // pack pin and win it once. `pinned` is the row; `pinPack` enforces the same WRITE-ONCE rule
  // the real `WHERE pack_id IS NULL` does, so a test can tell "I won" from "someone else had it".
  let pinned: { packId: string; packVersion: number } | null = opts.storedPin ?? null;
  const chat = {
    findPackPin: vi.fn(async () => pinned),
    pinPack: vi.fn(async (_id: string, packId: string, packVersion: number) => {
      if (opts.pinThrows) throw new Error("connection terminated unexpectedly");
      if (pinned) return false;
      pinned = { packId, packVersion };
      return true;
    }),
  };
  // Typed to TAKE its argument, so a test can assert on the emitted payload — `vi.fn(async () =>
  // …)` infers a zero-arg signature and `mock.calls[0][0]` is then a compile error.
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
  );
  return {
    orchestrator,
    store,
    buffer,
    registry,
    identify,
    chat,
    events,
    storedPin: () => pinned,
  };
}

/** Seed a session already mid-interview, with `q_city` on screen. */
function seed(
  store: Map<string, TranscriptBuffer>,
  envelope: Partial<ProfilingEnvelope> = {},
  buffer: Partial<TranscriptBuffer> = {},
) {
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
      servedQuestionKey: "q_city",
      engineAsks: 1,
      askCounts: { q_city: 1 },
      ...envelope,
    },
    ...buffer,
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };

const say = (text: string, at: Date = T0) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  ctx: CTX as never,
});

describe("the first turn", () => {
  it("serves the first question and records the ask", async () => {
    const { orchestrator, store } = makeWorld();
    const result = await orchestrator.takeTurn(say("shuru karein"));
    expect(result.questionKey).toBe("q_city");
    expect(result.reply).toBe(CITY.prompt_text);
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.engineAsks).toBe(1);
    expect(saved?.askCounts).toEqual({ q_city: 1 });
    expect(saved?.servedQuestionKey).toBe("q_city");
  });

  it("buffers BOTH sides of the turn, verbatim", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("shuru karein"));
    expect(store.get(SESSION)?.messages).toEqual([
      { role: "worker", text: "shuru karein", at: T0.toISOString() },
      { role: "assistant", text: CITY.prompt_text, at: T0.toISOString() },
    ]);
  });

  it("closes with `no_pack` rather than an interview with no questions", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({
      packs: { occupation: null, universal: null },
    });
    const result = await orchestrator.takeTurn(say("hello"));
    expect(result.unavailable).toBe(true);
    expect(result.reply).toBe(UNAVAILABLE_REPLY);
    // NOTHING WAS WRITTEN. A worker whose interview could not start must be able to retry into it.
    expect(store.size).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("capture and advance", () => {
  it("records the answer to the question on screen and moves on", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap[0]).toMatchObject({
      question_key: "q_city",
      value_normalized: "Pune",
      status: "answered",
    });
    expect(result.questionKey).toBe("q_years");
  });

  it("NEVER re-serves a settled question", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const second = await orchestrator.takeTurn(say("7 saal", new Date(T0.getTime() + 60_000)));
    expect(second.questionKey).not.toBe("q_city");
  });

  it("records `unanswered` when the engine ADVANCES past a question", async () => {
    // Distinct from having no record at all, which means "not yet reached".
    const { orchestrator, store } = makeWorld();
    seed(store, { askCounts: { q_city: 2 } });
    await orchestrator.takeTurn(say("mausam accha hai aaj"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_city")?.status).toBe("unanswered");
  });

  it("serves `retry_text` on the bounded re-ask, not the original wording", async () => {
    // Re-serving the ORIGINAL wording after the retry wording was shown reads as the assistant
    // going backwards.
    const { orchestrator, store } = makeWorld();
    // Seeded mid-interview with q_city already asked once, so this is the ONE bounded re-ask.
    seed(store);
    const result = await orchestrator.takeTurn(say("hmm theek hai bhai"));
    expect(result.reply).toBe(CITY.retry_text);
    expect(result.questionKey).toBe("q_city");
  });
});

describe("the hard cases, each one deterministic", () => {
  it("'nahi pata' settles the question — never re-asked, never blocks completion", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("nahi pata"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap[0]).toMatchObject({ question_key: "q_city", status: "declined" });
    expect(result.questionKey).toBe("q_years");
  });

  it("an abusive turn de-escalates, is buffered, and is flagged away from the model", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("chutiya"));
    expect(result.reply).toBe(DE_ESCALATION_REPLY);
    expect(result.excludeFromParse).toBe(true);
    // The AUDIT stays honest: the message is still in the transcript.
    expect(store.get(SESSION)?.messages[0]?.text).toBe("chutiya");
    // No question was served, so no ask was spent.
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
  });

  it("closes with `abuse_cap` on the third abusive turn", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { abusiveTurns: MAX_ABUSIVE_TURNS - 1 });
    const result = await orchestrator.takeTurn(say("chutiya"));
    expect(result.complete).toBe(true);
    expect(result.completionReason).toBe("abuse_cap");
    expect(result.reply).toBe(CLOSING_REPLY);
  });

  it("silence consumes a TURN, not an ASK, and re-serves the same question", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("."));
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
    expect(store.get(SESSION)?.profiling?.silentTurns).toBe(1);
  });

  it("advances after three silences", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { silentTurns: MAX_SILENT_TURNS - 1 });
    const result = await orchestrator.takeTurn(say("."));
    expect(result.questionKey).toBe("q_years");
    expect(store.get(SESSION)?.profiling?.silentTurns).toBe(0);
  });

  it("answers a worker who asks back, then re-serves — never counting an ask", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("sir job milegi kya?"));
    expect(result.reply).toContain(CITY.why_text as string);
    expect(result.reply).toContain(CITY.prompt_text);
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
    expect(store.get(SESSION)?.profiling?.clarifyCount).toBe(1);
  });

  it("REGRESSION: a clarify after a re-ask serves the RETRY wording, not the original", async () => {
    // The silent-turn branch carries a comment about exactly this — re-serving raw `prompt_text`
    // "walked the interview BACKWARDS to the opening wording after the retry wording had already
    // been served" — and `joinClarify` then did precisely that, because it read
    // `askedItem.prompt_text` instead of `servedText`.
    //
    // The worker sees: "Sheher ka naam bataiye." (the re-ask). They type "yeh kyun poochh rahe
    // ho?". Pre-fix they got the explanation followed by "Aap kis sheher mein rehte hain?" — the
    // phrasing from two turns ago, which reads as the app forgetting what it just said. In a
    // VOICE form it is worse: the worker cannot scroll back to check, they just hear the
    // question change shape.
    //
    // Five of 466 items carry `retry_text` today, which is why this survived. The plan calls for
    // ~20 hand-authored retries plus 8 answer-type templates.
    const { orchestrator, store } = makeWorld();
    seed(store, { askCounts: { q_city: 2 } }); // already re-asked once

    const result = await orchestrator.takeTurn(say("sir job milegi kya?"));

    expect(result.reply).toContain(CITY.why_text as string);
    expect(result.reply).toContain(CITY.retry_text as string);
    expect(result.reply).not.toContain(CITY.prompt_text);
  });

  it("moves on past the clarify bound rather than looping", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { clarifyCount: MAX_CONSECUTIVE_CLARIFIES });
    const result = await orchestrator.takeTurn(say("sir job milegi kya?"));
    expect(result.reply).not.toContain(CITY.why_text as string);
  });

  it("acknowledges hardship without pushing a question or counting an ask", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    const result = await orchestrator.takeTurn(say("ghar chalana mushkil hai"));
    expect(HARDSHIP_REPLIES as readonly string[]).toContain(result.reply);
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
    expect(store.get(SESSION)?.profiling?.hardshipTurns).toBe(1);
  });

  it("BOUNDS hardship, so an all-hardship interview still ends", async () => {
    // The one turn class that advances nothing. Unbounded it is an interview that can never
    // finish, and the hardship patterns are the most permissive in the lexicon.
    const { orchestrator, store } = makeWorld();
    seed(store, { hardshipTurns: MAX_CONSECUTIVE_HARDSHIP });
    const result = await orchestrator.takeTurn(say("ghar chalana mushkil hai"));
    expect(HARDSHIP_REPLIES as readonly string[]).not.toContain(result.reply);
  });

  it("survives the silence cap with NO question on screen", async () => {
    // Turn one is silent three times over: there is no served question to spend asks on, so the
    // cap must fall through cleanly rather than indexing a null item.
    const { orchestrator, store } = makeWorld();
    seed(store, { servedQuestionKey: null, silentTurns: MAX_SILENT_TURNS - 1, askCounts: {} });
    const result = await orchestrator.takeTurn(say("."));
    expect(result.questionKey).toBe("q_city");
    expect(result.unavailable).toBe(false);
  });

  it("serves a QUESTION, not a blank bubble, when the first message is a single character", async () => {
    // THE HOLE THE GUARD DOES NOT COVER. `classifyUtterance` calls anything under two trimmed
    // characters `empty`, and the wire validator only demands one — so "k" reaches here. On a NEW
    // session `servedQuestionKey` is null, so the silent-turn re-serve had nothing to re-serve and
    // fell back to "": a blank assistant bubble COMMITTED, and cached as the replay reply.
    //
    // It matters far more for the voice form than for typing: a one-character transcript is
    // exactly what a noisy environment produces, so turn one would show a blank question and hand
    // the empty string to a text-to-speech lookup.
    const { orchestrator, store } = makeWorld();
    const result = await orchestrator.takeTurn(say("k"));
    expect(result.reply.trim().length).toBeGreaterThan(0);
    expect(result.reply).toBe(CITY.prompt_text);
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.lastTurn?.reply.trim().length).toBeGreaterThan(0);
  });

  it("re-serves the RETRY wording after a silent turn, never the original", async () => {
    // `servedText` exists so the ask path and the re-serve path cannot disagree about which words
    // the worker actually saw. The silent branch read `prompt_text` directly and so walked the
    // interview backwards to the original phrasing after the retry phrasing had been shown —
    // audible in a voice session rather than merely visible.
    const { orchestrator, store } = makeWorld();
    seed(store, { askCounts: { q_city: 2 } });
    const result = await orchestrator.takeTurn(say("."));
    expect(result.reply).toBe(CITY.retry_text);
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
  });

  it("resets the hardship run once the worker answers", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { hardshipTurns: 1 });
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(store.get(SESSION)?.profiling?.hardshipTurns).toBe(0);
  });
});

describe("the derived turn backstop", () => {
  it("closes with `turn_cap` however the worker got there", async () => {
    // Reached via the hardship path specifically: that branch returns BEFORE consulting the
    // engine, so a cap tested after it would never fire for a worker who only sends hardship.
    const { orchestrator, store } = makeWorld();
    seed(store, { hardshipTurns: 0 }, { turnCount: MAX_ENGINE_TURNS });
    const result = await orchestrator.takeTurn(say("ghar chalana mushkil hai"));
    expect(result.complete).toBe(true);
    expect(result.completionReason).toBe("turn_cap");
  });
});

describe("cross-question capture — free information, never an overwrite", () => {
  it("FILLS an empty slot mentioned while answering something else", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { servedQuestionKey: "q_years", askCounts: { q_years: 1 } });
    await orchestrator.takeTurn(say("7 saal, main pune me rehta hu"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_years")?.value_normalized).toBe(7);
    expect(saved?.answerMap.find((a) => a.question_key === "q_city")?.value_normalized).toBe(
      "Pune",
    );
  });

  it("NEVER overwrites a slot the worker already established", async () => {
    // Mentioning a city while answering the salary question must not rewrite an established
    // location.
    const { orchestrator, store } = makeWorld();
    seed(store, {
      servedQuestionKey: "q_years",
      askCounts: { q_years: 1 },
      answerMap: [
        {
          question_key: "q_city",
          target_field: "current_city",
          value_raw: "mumbai",
          value_normalized: "Mumbai",
          status: "answered",
          evidence: null,
          turn: 1,
          history: [],
        },
      ],
    });
    await orchestrator.takeTurn(say("7 saal, main pune me rehta hu"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_city")?.value_normalized).toBe(
      "Mumbai",
    );
  });

  it("does NOT swallow the whole message into every free-text question", async () => {
    // A free-text item's "normalizer" is the identity, so without the typed-field gate every
    // free-text question in the pack would be filled the moment a worker said anything.
    const { orchestrator, store } = makeWorld({
      packs: { occupation: OCCUPATION_PACK, universal: UNIVERSAL_PACK },
    });
    seed(store, { servedQuestionKey: "q_city", packId: "qp_welding", packVersion: 1 });
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_process")).toBeUndefined();
  });
});

describe("pack resolution", () => {
  it("resolves from the OCCUPATION when no pack is pinned yet, then pins it", async () => {
    const { orchestrator, store, registry } = makeWorld({
      packs: { occupation: OCCUPATION_PACK, universal: UNIVERSAL_PACK },
    });
    seed(store, {
      packId: null,
      packVersion: null,
      occupation: {
        job_domain_id: "dom_welder",
        label: "Welder",
        isco_unit_code: "7212",
        match_status: "matched_lexical",
        match_score: 0.9,
        match_layer: "l1_skeleton",
        pack_id: null,
        pack_version: null,
        catalog_version: "cat_2026_08",
      },
    });
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(registry.resolveForOccupation).toHaveBeenCalled();
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.packId).toBe("qp_welding");
    expect(saved?.packVersion).toBe(1);
    // The catalogue release is pinned with it, so alias resolution cannot move mid-flight.
    expect(saved?.catalogVersion).toBe("cat_2026_08");
  });

  it("loads the PINNED version on every later turn, never re-resolving", async () => {
    const { orchestrator, store, registry } = makeWorld({
      packs: { occupation: OCCUPATION_PACK, universal: UNIVERSAL_PACK },
    });
    seed(store, { packId: "qp_welding", packVersion: 1 });
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(registry.loadPinned).toHaveBeenCalledWith("qp_welding", 1, T0.getTime());
    expect(registry.resolveForOccupation).not.toHaveBeenCalled();
  });

  it("does not run the universal block twice when it IS the resolved pack", async () => {
    // The universal pack resolving as the "occupation" pack is not an occupation pack.
    const { orchestrator, store } = makeWorld({
      packs: { occupation: UNIVERSAL_PACK, universal: UNIVERSAL_PACK },
    });
    seed(store, { packId: "qp_universal", packVersion: 1, askCounts: { q_city: 2 } });
    await orchestrator.takeTurn(say("mausam accha hai"));
    const saved = store.get(SESSION)?.profiling;
    // One record per question, not two.
    expect(saved?.answerMap.filter((a) => a.question_key === "q_city")).toHaveLength(1);
  });
});

describe("LAYER A — the reply cache", () => {
  it("replays the previous reply for a duplicate submit, writing NOTHING", async () => {
    const { orchestrator, store, buffer } = makeWorld();
    const first = await orchestrator.takeTurn(say("main pune me rehta hu"));
    const revAfterFirst = store.get(SESSION)?.profiling?.rev;

    const retry = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 3_000)),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.reply).toBe(first.reply);
    // No second turn, no second answer, no rev bump.
    expect(store.get(SESSION)?.profiling?.rev).toBe(revAfterFirst);
    expect(buffer.saveWithCas).toHaveBeenCalledTimes(1);
  });

  it("takes a REAL turn once the window has passed", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const later = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 11_000)),
    );
    expect(later.replayed).toBe(false);
    expect(store.get(SESSION)?.profiling?.rev).toBe(2);
  });

  it("does not replay a DIFFERENT message sent inside the window", async () => {
    const { orchestrator } = makeWorld();
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const other = await orchestrator.takeTurn(say("7 saal", new Date(T0.getTime() + 2_000)));
    expect(other.replayed).toBe(false);
  });

  it("refuses a NEGATIVE age, so clock skew cannot make a stale entry look fresh", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, {
      lastTurn: {
        inboundHash: inboundHash(SESSION, 1, "main pune me rehta hu"),
        reply: "stale",
        kind: "ask" as const,
        questionKey: "q_city",
        at: new Date(T0.getTime() + 60_000).toISOString(),
        options: [],
        progress: { answered: 0, total: 0 },
        whyText: null,
        answerType: null,
      },
    });
    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(result.replayed).toBe(false);
  });
});

describe("LAYER B — the CAS", () => {
  it("re-runs the decision against the WINNER's state and succeeds", async () => {
    // The loser does not merge, does not replay a half-applied mutation, and does not retry its
    // own stale decision — it asks the pure function the same question about newer facts.
    const { orchestrator, store, buffer } = makeWorld({
      interject: (s) => {
        const held = s.get(SESSION) as TranscriptBuffer;
        s.set(SESSION, {
          ...held,
          profiling: { ...(held.profiling as ProfilingEnvelope), rev: 99 },
        });
      },
    });
    seed(store);
    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(buffer.saveWithCas).toHaveBeenCalledTimes(2);
    expect(result.unavailable).toBe(false);
    expect(store.get(SESSION)?.profiling?.rev).toBe(100);
  });

  it("gives up after two attempts and writes NOTHING", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    // A permanently hot key: every attempt finds the rev moved again.
    const { orchestrator, store, buffer } = makeWorld();
    seed(store);
    const before = JSON.stringify(store.get(SESSION));
    buffer.saveWithCas.mockResolvedValue(false);

    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(result.unavailable).toBe(true);
    expect(result.reply).toBe(UNAVAILABLE_REPLY);
    // Bounded, not a livelock — and the session is EXACTLY as it was.
    expect(buffer.saveWithCas).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.get(SESSION))).toBe(before);
    vi.restoreAllMocks();
  });
});

describe("determinism", () => {
  it("gives the same answer to the same state, every time", async () => {
    // The property the whole design exists for: the CAS retry re-runs this, so it must have no
    // memory of the attempt that lost.
    const replies = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { orchestrator, store } = makeWorld();
      seed(store);
      replies.add(JSON.stringify(await orchestrator.takeTurn(say("main pune me rehta hu"))));
    }
    expect(replies.size).toBe(1);
  });
});

describe("the disambiguation offer announces itself (#695)", () => {
  // BUILT BY THE REAL PRODUCER, not hand-written. A literal fixture here asserted a key shape
  // (`occ_0`) that `toPackOption` happened to emit and the CONTRACT rejects, so the offer that
  // reached these tests was one the narrower would have emptied on the way out of Redis.
  const OFFER = {
    prompt: "Aap in mein se kaun sa kaam karte hain?",
    options: [
      toPackOption({ label: "Welder", jobDomainId: "jd_welder", familyId: "fam_welding" }, 0),
      toPackOption({ label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null }, 1),
    ],
  };

  it("returns kind `disambiguate`, which nothing downstream has to infer", () => {
    // The fact existed exactly here and was thrown away one layer up: `TurnResult` carried no
    // kind, so `ChatService` could not tell this turn from an ordinary ask and served
    // `question_kind: "ask"` — rendering a trade list, whose tapped label becomes the worker's
    // answer of record, in the horizontal chip scroller meant for typing shortcuts.
    const { orchestrator, store } = makeWorld({ identifyOffer: OFFER });
    seed(store);
    return orchestrator.takeTurn(say("welding ka kaam")).then((result) => {
      expect(result.kind).toBe("disambiguate");
      // The rest of the branch is unchanged: no pack key, chips from retrieval, single-select.
      expect(result.questionKey).toBeNull();
      expect(result.answerType).toBe("single_select");
      expect(result.options.map((o) => o.label_text)).toEqual([
        "Welder",
        DISAMBIGUATION_ESCAPE_LABEL,
      ]);
    });
  });

  it("an ordinary pack question stays `ask`, and the close stays `close`", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store);
    expect((await orchestrator.takeTurn(say("main pune me rehta hu"))).kind).toBe("ask");
  });

  it("SURVIVES THE REPLAY CACHE — a resubmit must not downgrade the offer to an ask", async () => {
    // The reply cache exists for a worker resubmitting over a flaky 2G link. Re-deriving `ask`
    // on that path would hand them the wrong widget for the question that pins their pack, on
    // precisely the connections the cache was built for.
    const { orchestrator, store } = makeWorld({ identifyOffer: OFFER });
    seed(store);
    const first = await orchestrator.takeTurn(say("welding ka kaam"));
    const replayed = await orchestrator.takeTurn(say("welding ka kaam"));
    expect(replayed.replayed).toBe(true);
    expect(replayed.kind).toBe(first.kind);
    expect(replayed.kind).toBe("disambiguate");
    expect(replayed.options).toEqual(first.options);
  });

  it("every synthesised chip key is a key the CONTRACT accepts, at any offer size", () => {
    // THE DEFECT THAT MADE THE TEST ABOVE INERT. `toPackOption` is typed as a
    // `QuestionPackOption`, never parsed into one, so `occ_${index}` type-checked for as long as
    // it existed while `option_key`'s `slugKey` (/^[a-z_]+$/) forbids digits. `narrowLastTurn`
    // parses cached chips all-or-nothing, so one `occ_0` emptied the ENTIRE offer coming back out
    // of Redis while `kind: "disambiguate"` survived — the replay this suite exists to protect,
    // arriving as a single-select with nothing in it.
    //
    // Asserted against the SCHEMA rather than against a literal, so the day the key shape changes
    // again it is the contract that decides whether the new one is legal.
    const chip = { label: "Welder", jobDomainId: "jd_welder", familyId: "fam_welding" };
    for (const index of [0, 1, 25, 26, 27, 51, 52, 700]) {
      const parsed = QuestionPackOptionSchema.safeParse(toPackOption(chip, index));
      expect(parsed.success, `index ${index} produced an illegal option_key`).toBe(true);
    }
    // The escape hatch is a real constant, not a synthesised one — it must pass too, and it must
    // still BE the constant: the client's "none of these" branch keys off this, not off copy.
    const escape = toPackOption(
      { label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null },
      0,
    );
    expect(QuestionPackOptionSchema.safeParse(escape).success).toBe(true);
    expect(escape.option_key).toBe(DISAMBIGUATION_ESCAPE_KEY);
    expect(escape.is_none_of_above).toBe(true);
    // Distinct indices must not collide, or two chips would answer to one key.
    const keys = [0, 1, 25, 26, 27, 51, 52].map((i) => toPackOption(chip, i).option_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("FAILS CLOSED when a cached offer comes back without its chips", async () => {
    // Belt to the braces above. If a chip ever fails the contract again — a new field, a stricter
    // rule, an entry written by an older deploy — `narrowLastTurn` empties the list and `kind`
    // survives on its own. Serving that pair is worse than spending a turn: the client is told to
    // draw a single-select and given nothing to put in it, and on the voice form the worker has no
    // other way to answer. The replay must decline, not degrade.
    const { orchestrator, store } = makeWorld({ identifyOffer: OFFER });
    seed(store);
    const first = await orchestrator.takeTurn(say("welding ka kaam"));
    expect(first.kind).toBe("disambiguate");

    // Corrupt the CACHED chips only — exactly what an unparseable option_key does downstream.
    const held = store.get(SESSION) as TranscriptBuffer;
    const envelope = held.profiling as ProfilingEnvelope;
    store.set(SESSION, {
      ...held,
      profiling: {
        ...envelope,
        lastTurn: { ...envelope.lastTurn!, options: [] },
      } as ProfilingEnvelope,
    });

    const replayed = await orchestrator.takeTurn(say("welding ka kaam"));
    expect(replayed.replayed).toBeFalsy();
    expect(replayed.options.length).toBeGreaterThan(0);
  });
});

describe("a DISAMBIGUATE decision must never become a blank message", () => {
  it("writes nothing and fails closed instead of serving an empty assistant bubble", async () => {
    // LATENT BUG, found by tracing the branch rather than by a failure. `nextQuestion` returns
    // kind "disambiguate" with promptText "" — the chips are Phase 7's to build. The commit path
    // fell through the `else`, so the turn was COMMITTED with reply "": an empty assistant bubble
    // appended to the transcript, cached as the replay reply, `servedQuestionKey` nulled, and no
    // ask spent — so nothing cleared the flag and every later turn emitted another blank until
    // MAX_ENGINE_TURNS closed the interview. Unreachable today only because nothing sets the flag.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld();
    seed(store, { needsDisambiguation: true });
    const before = JSON.stringify(store.get(SESSION));

    const result = await orchestrator.takeTurn(say("welder"));

    expect(result.unavailable).toBe(true);
    expect(result.reply).toBe(UNAVAILABLE_REPLY);
    // NOTHING was written — no blank bubble, no rev bump, no poisoned reply cache.
    expect(JSON.stringify(store.get(SESSION))).toBe(before);
    vi.restoreAllMocks();
  });

  it("never serves an empty reply for ANY decision kind", async () => {
    // The general invariant behind the specific bug: whatever the engine decides, a turn that
    // would show the worker nothing is not a turn worth committing.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const blank = pack("qp_blank", [item({ question_key: "q_blank", prompt_text: "   " })]);
    const { orchestrator, store } = makeWorld({ packs: { occupation: null, universal: blank } });
    const result = await orchestrator.takeTurn(say("hello"));
    expect(result.unavailable).toBe(true);
    expect(store.size).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("the mid-interview checkpoint boundary (Phase 9, risk #10)", () => {
  // The orchestrator decides; `ChatService` writes. What is asserted here is only the decision,
  // and specifically that it fires on the CROSSING rather than on the value — the difference
  // between two UPDATEs per interview and one per turn forever on a stuck conversation.

  it("fires on the ask that crosses the boundary", async () => {
    const { orchestrator, store } = makeWorld();
    // One ask short of the boundary, with `q_city` on screen and unanswered.
    seed(store, { engineAsks: CHECKPOINT_EVERY_ASKS - 1, askCounts: { q_city: 1 } });

    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));

    expect(result.questionKey).toBe("q_years"); // it advanced, so it spent an ask
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(CHECKPOINT_EVERY_ASKS);
    expect(result.checkpointDue).toBe(true);
  });

  it("does NOT fire on an ask that lands between boundaries", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, { engineAsks: CHECKPOINT_EVERY_ASKS, askCounts: { q_city: 1 } });

    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));

    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(CHECKPOINT_EVERY_ASKS + 1);
    expect(result.checkpointDue).toBe(false);
  });

  it("does NOT re-fire on a later turn that spends no ask", async () => {
    // THE BUG THIS DESIGN EXISTS TO AVOID. A caller testing `engineAsks % 5 === 0` for itself
    // would fire again here, and again on every following clarify, hardship or silent turn — the
    // ask count is not moving, so the condition stays true forever. Sitting exactly ON the
    // boundary is the worst case, so that is what is seeded.
    const { orchestrator, store } = makeWorld();
    seed(store, { engineAsks: CHECKPOINT_EVERY_ASKS, askCounts: { q_city: 1 } });

    // A hardship turn: acknowledged, no question asked, no budget spent.
    const result = await orchestrator.takeTurn(say("ghar me paise ki bahut dikkat hai"));

    expect(HARDSHIP_REPLIES).toContain(result.reply);
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(CHECKPOINT_EVERY_ASKS);
    expect(result.checkpointDue).toBe(false);
  });

  it("is false on a replay — a retry made nothing newly durable", async () => {
    const { orchestrator, store } = makeWorld();
    const text = "main pune me rehta hu";
    seed(store, {
      engineAsks: CHECKPOINT_EVERY_ASKS - 1,
      lastTurn: {
        inboundHash: inboundHash(SESSION, 1, text),
        reply: "Kitne saal ka kaam ka tajurba hai?",
        kind: "ask" as const,
        questionKey: "q_years",
        at: T0.toISOString(),
        options: [],
        progress: { answered: 0, total: 0 },
        whyText: null,
        answerType: null,
      },
    });

    const result = await orchestrator.takeTurn(say(text));

    expect(result.replayed).toBe(true);
    expect(result.checkpointDue).toBe(false);
  });
});

describe("the pack pin has to survive Redis", () => {
  /**
   * THE DEFECT A LIVE INTERVIEW FOUND. Migration 0071 added `chat_sessions.pack_id` /
   * `pack_version` with a comment explaining exactly why they must exist — the envelope lives
   * only in a Redis key with a 24h TTL, so an eviction re-runs retrieval on resume and can hand
   * a half-finished interview a DIFFERENT pack. Then nothing wrote them. Thirteen turns of the
   * welding pack were served and the column read NULL for every one of them.
   *
   * Two halves, and each is useless alone: writing a pin nobody reads back changes nothing, and
   * reading a pin nobody wrote returns null forever.
   */
  const PIN = {
    job_domain_id: "jd_nco_7212_0301",
    label: "Welder",
    isco_unit_code: "7212",
    match_status: "matched_lexical" as const,
    match_score: 0.97,
    match_layer: "l0_exact" as const,
    pack_id: null,
    pack_version: null,
    catalog_version: "9121:0:3885:2026-08-07T12:24:17.864Z:2026-08-07T12:24:22.762Z:101",
  };

  /** A world whose identify step pins a welder on the turn it is called. */
  function pinningWorld(opts: Parameters<typeof makeWorld>[0] = {}) {
    const world = makeWorld({
      packs: { occupation: OCCUPATION_PACK, universal: UNIVERSAL_PACK },
      ...opts,
    });
    world.identify.identify.mockImplementation(
      async () =>
        ({
          patch: { occupation: PIN, phase: "occupation_specific" },
          offer: null,
          pinned: PIN,
        }) as never,
    );
    return world;
  }

  it("writes the pin to chat_sessions on the turn the pack is chosen, and emits it once", async () => {
    const world = pinningWorld();
    await world.orchestrator.takeTurn(say("main welder hoon"));

    expect(world.storedPin()).toEqual({ packId: "qp_welding", packVersion: 1 });
    expect(world.chat.pinPack).toHaveBeenCalledTimes(1);

    // The audit half. `catalog_version` is PROJECTED — the raw signature is 65 characters
    // against a payload cap of 64, which is how the unresolved event once 500'd every
    // unplaced worker's turn.
    expect(world.events.emit).toHaveBeenCalledTimes(1);
    const emitted = world.events.emit.mock.calls[0]?.[0] as unknown as {
      event_name: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(emitted.event_name).toBe("profile.pack_pinned");
    expect(emitted.payload.pack_id).toBe("qp_welding");
    expect(emitted.payload.pack_version).toBe(1);
    expect(emitted.payload.job_domain_id).toBe("jd_nco_7212_0301");
    expect(String(emitted.payload.catalog_version).length).toBeLessThanOrEqual(64);
    expect(emitted.idempotencyKey).toBe(`profile.pack_pinned:${SESSION}`);
    // No worker text anywhere in the payload — the utterance that produced the pin never
    // leaves the request.
    expect(JSON.stringify(emitted.payload)).not.toContain("welder hoon");
  });

  it("writes ONCE — later turns re-derive the same pin and must not re-UPDATE", async () => {
    // The envelope carries `packId` forward on every turn, so a naive "write whatever the
    // envelope says" would be a dozen UPDATEs to store one immutable fact.
    const world = pinningWorld();
    await world.orchestrator.takeTurn(say("main welder hoon"));
    await world.orchestrator.takeTurn(say("Pune"));
    await world.orchestrator.takeTurn(say("8 saal"));
    expect(world.chat.pinPack).toHaveBeenCalledTimes(1);
    expect(world.events.emit).toHaveBeenCalledTimes(1);
  });

  it("restores the pin when the envelope is GONE, and loads that pack rather than re-resolving", async () => {
    // The eviction the columns exist for: nothing in Redis, a pin in Postgres. Re-running
    // retrieval here is not idempotent — the catalogue may have moved and the worker's opening
    // words are gone — so the resumed interview must load the PINNED version verbatim.
    const world = pinningWorld({ storedPin: { packId: "qp_welding", packVersion: 1 } });
    world.identify.identify.mockImplementation(
      async () => ({ patch: {}, offer: null, pinned: null }) as never,
    );
    expect(world.store.size).toBe(0); // no envelope at all

    await world.orchestrator.takeTurn(say("haan ji"));

    expect(world.chat.findPackPin).toHaveBeenCalledWith(SESSION);
    expect(world.registry.loadPinned).toHaveBeenCalled();
    expect(world.registry.resolveForOccupation).not.toHaveBeenCalled();
    expect(world.store.get(SESSION)?.profiling?.packId).toBe("qp_welding");
    expect(world.store.get(SESSION)?.profiling?.packVersion).toBe(1);
  });

  it("does not query the pin when the envelope loaded — it already knows", async () => {
    // A read here would be a round trip on every turn of every interview to learn something
    // the envelope holds.
    const world = pinningWorld();
    seed(world.store);
    await world.orchestrator.takeTurn(say("Pune"));
    expect(world.chat.findPackPin).not.toHaveBeenCalled();
  });

  it("a failed pin write costs the pin, never the worker's turn", async () => {
    // The turn is already committed to Redis and the reply is owed. Throwing here would turn a
    // durability problem into a lost answer.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const world = pinningWorld({ pinThrows: true });

    const result = await world.orchestrator.takeTurn(say("main welder hoon"));

    expect(result.unavailable).toBe(false);
    expect(result.reply).toBe(PROCESS.prompt_text); // the welding pack still ran
    expect(world.store.get(SESSION)?.profiling?.packId).toBe("qp_welding");
    expect(world.events.emit).not.toHaveBeenCalled(); // never claim a pin Postgres lacks
    vi.restoreAllMocks();
  });

  it("never repins a session that already holds one, and emits nothing when it loses", async () => {
    // `WHERE pack_id IS NULL` is the real guard; this proves the caller honours its answer
    // rather than emitting a `pack_pinned` for a pin it did not make.
    //
    // THE SETUP IS THE TEST. An envelope that LOADED (so the restore path is skipped and the
    // turn believes nothing is pinned) against a row that already holds a different pack —
    // which is the state a concurrent writer, or a `findPackPin` that threw, leaves behind.
    // Seeding no envelope instead would restore the pin and return before `pinPack` was ever
    // called, so the assertion would hold for the wrong reason.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const world = pinningWorld({ storedPin: { packId: "qp_other", packVersion: 3 } });
    seed(world.store, { packId: null, packVersion: null });

    await world.orchestrator.takeTurn(say("main welder hoon"));

    expect(world.chat.pinPack).toHaveBeenCalledTimes(1); // it tried…
    expect(world.storedPin()).toEqual({ packId: "qp_other", packVersion: 3 }); // …and lost
    expect(world.events.emit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

const open = (at: Date = T0) => ({
  sessionId: SESSION,
  workerId: WORKER,
  now: at,
  ctx: CTX as never,
});

describe("openTurn — putting the first question on screen", () => {
  it("serves question one and records the ask", async () => {
    const { orchestrator, store } = makeWorld();

    const result = await orchestrator.openTurn(open());

    expect(result.questionKey).toBe("q_city");
    expect(result.reply).toBe(CITY.prompt_text);
    expect(result.unavailable).toBe(false);
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.engineAsks).toBe(1);
    expect(saved?.askCounts).toEqual({ q_city: 1 });
    expect(saved?.servedQuestionKey).toBe("q_city");
  });

  it("writes NO worker message and spends NO turn — the screen spoke, the worker did not", async () => {
    const { orchestrator, store } = makeWorld();

    await orchestrator.openTurn(open());

    const saved = store.get(SESSION);
    // The whole reason this method exists rather than `takeTurn("")`: an empty inbound line here
    // is read by the end-of-interview parse call as the worker having said nothing at all.
    expect(saved?.messages).toEqual([
      { role: "assistant", text: CITY.prompt_text, at: T0.toISOString() },
    ]);
    expect(saved?.turnCount).toBe(0);
  });

  it("carries the shape the client needs to draw the question", async () => {
    const { orchestrator } = makeWorld();

    const result = await orchestrator.openTurn(open());

    expect(result.whyText).toBe(CITY.why_text);
    expect(result.answerType).toBe(CITY.answer_type);
  });

  it("is idempotent: a re-open re-serves the same question and writes nothing", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.openTurn(open());
    const afterFirst = store.get(SESSION)?.profiling;

    const second = await orchestrator.openTurn(open(new Date(T0.getTime() + 3_600_000)));

    expect(second.questionKey).toBe("q_city");
    expect(second.reply).toBe(CITY.prompt_text);
    expect(second.replayed).toBe(true);
    const afterSecond = store.get(SESSION)?.profiling;
    // Not the reply cache — that is keyed on inbound text and expires in ten seconds. An hour
    // later, on a cold app start, the worker must still see the question they were left on.
    expect(afterSecond?.rev).toBe(afterFirst?.rev);
    expect(afterSecond?.engineAsks).toBe(1);
    expect(afterSecond?.askCounts).toEqual({ q_city: 1 });
  });

  it("re-opens on the wording last SERVED, not the opening phrasing", async () => {
    // A worker who has been re-asked once is looking at `retry_text`. Reopening the screen on
    // `prompt_text` would change the question's shape under them — recoverable on chat, where
    // they can scroll back, and simply confusing when it is the thing read aloud.
    const { orchestrator, store } = makeWorld();
    seed(store, { askCounts: { q_city: 2 } });

    const result = await orchestrator.openTurn(open());

    expect(result.reply).toBe(CITY.retry_text);
  });

  it("re-serves the OUTSTANDING OFFER, not the stale pack question underneath it", async () => {
    // `identify()`'s offer branch never clears `servedQuestionKey`, so a session mid-offer still
    // carries the pack key from the turn before — and `openTurn` runs on every cold start and
    // resume-after-kill, which is exactly when a worker comes back to an offer they never
    // answered. Re-serving `q_city` there silently replaces the offer, and answering it 409s
    // against `viewSession`, which has always reported `questionKey: null` for the same session.
    const { orchestrator, store } = makeWorld();
    seed(store, {
      needsDisambiguation: true,
      disambiguationOffer: [
        { label: "Welder", jobDomainId: "jd_welder", familyId: "fam_welding" },
        { label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null },
      ],
      servedQuestionKey: "q_city",
    });

    const result = await orchestrator.openTurn(open());

    expect(result.kind).toBe("disambiguate");
    expect(result.questionKey).toBeNull();
    expect(result.reply).toBe(DISAMBIGUATION_PROMPT);
    expect(result.options.map((o) => o.label_text)).toEqual([
      "Welder",
      DISAMBIGUATION_ESCAPE_LABEL,
    ]);
    expect(result.answerType).toBe("single_select");
  });

  it("agrees with viewSession about what is on screen — one rule, two readers", async () => {
    // The defect was a DIVERGENCE, not either branch alone, so the assertion is the agreement.
    const { orchestrator, store } = makeWorld();
    seed(store, {
      needsDisambiguation: true,
      disambiguationOffer: [
        { label: "Welder", jobDomainId: "jd_welder", familyId: "fam_welding" },
        { label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null },
      ],
      servedQuestionKey: "q_city",
    });

    const opened = await orchestrator.openTurn(open());
    const viewed = await orchestrator.viewSession(SESSION, T0);

    if (viewed === null || viewed.served === null) throw new Error("viewSession served nothing");
    expect(opened.questionKey).toBe(viewed.served.questionKey);
    expect(opened.reply).toBe(viewed.served.promptText);
    expect(opened.options).toEqual(viewed.served.options);
  });

  it("fails closed when no pack resolves, writing nothing", async () => {
    const { orchestrator, store } = makeWorld({
      packs: { occupation: null, universal: null },
    });
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const result = await orchestrator.openTurn(open());

    expect(result.unavailable).toBe(true);
    expect(result.reply).toBe(UNAVAILABLE_REPLY);
    expect(store.get(SESSION)).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("loses the CAS to a concurrent open and re-serves the winner's question", async () => {
    // Two taps on "Sawaal-jawaab" is the ordinary case, not the exotic one.
    const world = makeWorld({
      interject: (store) => {
        store.set(SESSION, {
          workerId: WORKER,
          turnCount: 0,
          captured: {},
          roleFamily: "",
          messages: [{ role: "assistant", text: CITY.prompt_text, at: T0.toISOString() }],
          startedAt: T0.toISOString(),
          profiling: {
            ...emptyProfilingEnvelope(),
            rev: 1,
            servedQuestionKey: "q_city",
            engineAsks: 1,
            askCounts: { q_city: 1 },
          },
        });
      },
    });
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

    const result = await world.orchestrator.openTurn(open());

    expect(result.questionKey).toBe("q_city");
    // The loser must not double-count the ask the winner already recorded.
    expect(world.store.get(SESSION)?.profiling?.engineAsks).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("a replayed turn is the SAME response, not a stripped one", () => {
  it("replays the chips, the progress and the question shape", async () => {
    const { orchestrator } = makeWorld();
    const text = "main pune me rehta hu";
    const first = await orchestrator.takeTurn(say(text));

    const replay = await orchestrator.takeTurn(say(text, new Date(T0.getTime() + 1_000)));

    expect(replay.replayed).toBe(true);
    // Before these were cached, a retry over a flaky link answered with the same words and no
    // chips — which on a select question is a worker who cannot type and cannot proceed.
    expect(replay.options).toEqual(first.options);
    expect(replay.progress).toEqual(first.progress);
    expect(replay.whyText).toBe(first.whyText);
    expect(replay.answerType).toBe(first.answerType);
  });
});
