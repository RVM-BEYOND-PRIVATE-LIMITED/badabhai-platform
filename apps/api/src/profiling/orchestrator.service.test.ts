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
  RETRY_STORM_FLOOR_MS,
  REPLY_CACHE_WINDOW_MS,
  ID_REPLAY_MAX_AGE_MS,
  STALE_RESPONSE_WINDOW_MS,
  type LastTurn,
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
  // THE LLM PATH IS OFF IN EVERY TEST IN THIS FILE, which is the point: what is asserted below is
  // the deterministic engine, and it must behave identically whether the flag exists or not.
  // `leads()` returning false is the whole of "off" as far as the orchestrator can tell.
  const llm = { leads: () => false, take: vi.fn(async () => null) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
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

/**
 * A hand-built reply-cache stamp, as a test writes one.
 *
 * `submissionId` IS OPTIONAL HERE AND REQUIRED ON `LastTurn` (#931). The interface keeps it
 * required so that forgetting to narrow it out of Redis is a BUILD failure rather than a silently
 * forgotten id; a stamp a test hand-builds without one is exactly what every entry written before
 * the field existed looks like, and defaulting it to `null` below is what keeps every stamp these
 * tests construct on the legacy hash + window path — which is the path they exist to pin.
 */
type SeededLastTurn = Omit<LastTurn, "submissionId"> & { submissionId?: string | null };

/** Seed a session already mid-interview, with `q_city` on screen. */
function seed(
  store: Map<string, TranscriptBuffer>,
  envelope: Partial<Omit<ProfilingEnvelope, "lastTurn">> & { lastTurn?: SeededLastTurn | null } = {},
  buffer: Partial<TranscriptBuffer> = {},
) {
  // Split out so the stamp is rebuilt with its default rather than spread in raw — see
  // `SeededLastTurn`. `undefined` means "this test seeded no stamp at all", which is not the same
  // as an explicit `null`, so the key is only written when the caller wrote one.
  const { lastTurn, ...rest } = envelope;
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
      ...rest,
      ...(lastTurn === undefined
        ? {}
        : { lastTurn: lastTurn === null ? null : { submissionId: null, ...lastTurn } }),
    },
    ...buffer,
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };

/**
 * An inbound turn. The third argument is the client's per-submission id (#931).
 *
 * DEFAULTED TO `null`, so every call site written before that argument existed produces an
 * inbound with NO id and therefore takes the hash + window path unchanged — which is what makes
 * "the legacy behaviour is byte-identical" a property of the code rather than a claim in a PR.
 */
const say = (text: string, at: Date = T0, submissionId: string | null = null) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId,
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
  it("replays the previous reply for a duplicate submit, spending NO interview turn", async () => {
    const { orchestrator, store, buffer } = makeWorld();
    const first = await orchestrator.takeTurn(say("main pune me rehta hu"));
    const revAfterFirst = store.get(SESSION)?.profiling?.rev;
    const askCountsAfterFirst = store.get(SESSION)?.profiling?.askCounts;
    const servedAfterFirst = store.get(SESSION)?.profiling?.servedQuestionKey;
    const engineAsksAfterFirst = store.get(SESSION)?.profiling?.engineAsks;

    const retry = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 3_000)),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.reply).toBe(first.reply);
    // NO SECOND TURN, NO SECOND ANSWER: nothing the engine owns moved.
    expect(store.get(SESSION)?.profiling?.askCounts).toEqual(askCountsAfterFirst);
    expect(store.get(SESSION)?.profiling?.servedQuestionKey).toBe(servedAfterFirst);
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(engineAsksAfterFirst);
    // A REV BUMP, DELIBERATELY. Consuming one unit of the replay budget is a real write — see
    // `LastTurn.replays` — so the cache entry cannot match a THIRD identical submission forever.
    // Without it, a worker whose actual next answer echoes their last one would be stuck re-reading
    // this same reply for the whole of `REPLY_CACHE_WINDOW_MS`, however many genuine turns that is.
    expect(store.get(SESSION)?.profiling?.rev).toBe((revAfterFirst as number) + 1);
    expect(store.get(SESSION)?.profiling?.lastTurn?.replays).toBe(1);
    expect(buffer.saveWithCas).toHaveBeenCalledTimes(2);
  });

  /**
   * THE BUG THIS FILE'S BATCH FIXES. `inboundHash` is `(sessionId, rev, text)`, and `rev` moves in
   * lock step with the turn count whatever the text says — so on its own it cannot tell a network
   * retry of THIS reply from the worker's own next, genuinely different turn happening to answer
   * with the same short words. Measured: a real interview asked a `max_asks: 1` boolean question,
   * got a generic affirmative back, and never asked another question for the rest of a bounded run
   * — the SAME stamp matched every further identical submission, because a replay writes nothing
   * and so never goes stale.
   *
   * `MAX_REPLAYS_PER_TURN` bounds it. The FIRST duplicate is served from the cache for free — a
   * genuine flaky-link retry costs nothing. The submission AFTER that — genuine retry or not —
   * runs a real turn instead of matching the same stamp again, which is what lets the worker's
   * actual next answer (however plainly it echoes the last one) ever be heard.
   */
  it("runs a REAL turn once the replay budget is spent, even for the same words", async () => {
    // A `boolean`, `max_asks: 1` item, exactly the shape of the pack row the real bug was measured
    // on (`tools_owned`): served once, and — whatever the reply — never re-servable after that.
    const boolItem = item({
      question_key: "q_tools",
      prompt_text: "Kya aapke paas apne auzaar hain?",
      answer_type: "boolean",
      max_asks: 1,
    });
    const { orchestrator, store } = makeWorld({
      packs: { occupation: pack("qp_bool", [boolItem]), universal: UNIVERSAL_PACK },
    });
    seed(store, {
      servedQuestionKey: null,
      engineAsks: 0,
      askCounts: {},
      packId: "qp_bool",
      packVersion: 1,
    });

    // Turn 1 — REAL: nothing is on screen yet, so the only occupation item is served.
    const opened = await orchestrator.takeTurn(say("shuru karte hain"));
    expect(opened.questionKey).toBe("q_tools");
    expect(store.get(SESSION)?.profiling?.askCounts.q_tools).toBe(1);

    // Turn 2 — REAL, and DIFFERENT text from turn 1, so no replay is even in play here.
    // `q_tools` is already at its ceiling (max_asks: 1), so the engine advances whatever this
    // reply says — onto `q_city`, the universal pack's one mandatory item.
    const answered = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 1_000)),
    );
    expect(answered.replayed).toBe(false);
    expect(answered.questionKey).toBe("q_city");
    const stampedReply = answered.reply;

    // Turn 3 — the SAME words again, moments later. THIS is the failure mode: the stamp turn 2
    // just wrote matches byte-for-byte, so it replays — correctly, this is the cache doing its
    // job for what looks exactly like a flaky-link retry.
    const dup1 = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 2_000)),
    );
    expect(dup1.replayed).toBe(true);
    expect(dup1.questionKey).toBe("q_city");
    expect(dup1.reply).toBe(stampedReply);
    const askCountAfterReplay = store.get(SESSION)?.profiling?.askCounts.q_city;

    // Turn 4 — the SAME words a THIRD time. Before this fix, this matched the very same stamp
    // forever: a replay writes nothing, so the entry never went stale, and the interview would
    // sit on `q_city` for the rest of the ten-second window however many more of these arrived.
    // With the budget spent on turn 3, this one runs for real — `q_city` is re-served (its
    // `max_asks: 2` still has room), but as a GENUINE second ask: the RETRY wording, and the ask
    // counter actually moving, which a replay never does.
    const dup2 = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 3_000)),
    );
    expect(dup2.replayed).toBe(false);
    expect(dup2.reply).toBe(CITY.retry_text);
    expect(dup2.reply).not.toBe(stampedReply);
    expect(store.get(SESSION)?.profiling?.askCounts.q_city).toBe(
      (askCountAfterReplay as number) + 1,
    );
  });

  /**
   * THE RESIDUE OF THE BUDGET ABOVE (#858), and the case it gets wrong.
   *
   * `MAX_REPLAYS_PER_TURN` makes the submission after the first duplicate a REAL turn — right for
   * a worker whose own next answer echoes their last one, wrong for a broken client firing ONE
   * physical submission three or more times. A real turn answers whatever question is on screen
   * NOW, and by copy three that question has already advanced, because the FIRST copy's own
   * success is what advanced it. So the worker's words for question A are captured against
   * question B: B's ask budget spent, or B settled outright, on content never given for it.
   *
   * `RETRY_STORM_FLOOR_MS` closes it with the one signal the two cases do not share. A worker's
   * next answer requires them to have SEEN the next question; a storm lands in milliseconds.
   */
  it("absorbs a retry storm instead of spending the NEXT question's budget on it", async () => {
    // The same `boolean`, `max_asks: 1` shape #857 was measured on: served once, never re-servable
    // — so the turn that answers it is guaranteed to advance the interview, which is the whole
    // precondition of this bug.
    const boolItem = item({
      question_key: "q_tools",
      prompt_text: "Kya aapke paas apne auzaar hain?",
      answer_type: "boolean",
      max_asks: 1,
    });
    const { orchestrator, store } = makeWorld({
      packs: { occupation: pack("qp_bool", [boolItem]), universal: UNIVERSAL_PACK },
    });
    seed(store, {
      servedQuestionKey: null,
      engineAsks: 0,
      askCounts: {},
      packId: "qp_bool",
      packVersion: 1,
    });

    // POST 1 — a real turn. `q_tools` goes on screen.
    const opened = await orchestrator.takeTurn(say("shuru karte hain"));
    expect(opened.questionKey).toBe("q_tools");

    // POST 2 — the worker's ONE physical answer to `q_tools`. It lands, and its own success is
    // what moves the interview on to `q_city`. Everything after this is the SAME submission
    // arriving again.
    const answered = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 1_000)),
    );
    expect(answered.replayed).toBe(false);
    expect(answered.questionKey).toBe("q_city");
    const stampedReply = answered.reply;
    const revAfterAnswer = store.get(SESSION)?.profiling?.rev as number;
    const askCountsAfterAnswer = store.get(SESSION)?.profiling?.askCounts;

    // POST 3 — copy two, 100 ms later. The budget absorbs it, and consuming that unit is a write.
    const dup1 = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 1_100)),
    );
    expect(dup1.replayed).toBe(true);
    expect(store.get(SESSION)?.profiling?.rev).toBe(revAfterAnswer + 1);

    // POSTS 4 AND 5 — copies three and four, still far inside the floor. THIS is the fix: with the
    // budget spent these used to run `decide()` against `q_city` and be captured as its answer.
    // Now they are still the same physical submission, and are still answered from the cache.
    for (const offset of [1_200, 1_300]) {
      const storm = await orchestrator.takeTurn(
        say("haan bhai, theek hai", new Date(T0.getTime() + offset)),
      );
      expect(storm.replayed).toBe(true);
      expect(storm.reply).toBe(stampedReply);
      expect(storm.questionKey).toBe("q_city");
    }

    const saved = store.get(SESSION)?.profiling;
    // NOTHING THE ENGINE OWNS MOVED — `q_city` was never asked a second time on the strength of
    // words meant for `q_tools`.
    expect(saved?.askCounts).toEqual(askCountsAfterAnswer);
    expect(saved?.servedQuestionKey).toBe("q_city");
    // AND NOTHING WAS WRITTEN AT ALL beyond POST 3's single budget consume. A storm replay has no
    // budget left to spend, so it costs the session no Redis write either.
    expect(saved?.rev).toBe(revAfterAnswer + 1);

    // THE BOUND, asserted rather than argued. The floor is measured from `lastTurn.at`, which no
    // replay refreshes, so it expires on the wall clock whether or not anything is written: a
    // further identical submission past it runs a real turn exactly as #857 requires. Without
    // this the fix would simply be the pre-#857 unbounded replay wearing a timer.
    const past = await orchestrator.takeTurn(
      say("haan bhai, theek hai", new Date(T0.getTime() + 1_000 + RETRY_STORM_FLOOR_MS)),
    );
    expect(past.replayed).toBe(false);
    expect(store.get(SESSION)?.profiling?.askCounts.q_city).toBe(
      (askCountsAfterAnswer?.q_city as number) + 1,
    );
  });

  /**
   * The harm the counters above only stand in for: the worker's WORDS filed against a question
   * they were never asked, as its answer OF RECORD.
   *
   * BOTH QUESTIONS TAKE FREE TEXT, deliberately. A field with a normalizer (`current_city` runs
   * `canonicalCity`) refuses text that is not a city and absorbs this by luck; a free-text row has
   * nothing to refuse with, so whatever arrives while it is on screen becomes its answer. Those
   * are the rows this bug can actually reach, and a profile the platform ranks on (§2) is what it
   * writes them into.
   */
  it("does not file a storm duplicate's words as the next question's answer", async () => {
    const trade = item({
      question_key: "q_trade",
      prompt_text: "Kya kaam karte hain?",
      max_asks: 1,
    });
    const shift = item({ question_key: "q_shift", prompt_text: "Kaunsi shift pasand hai?" });
    const { orchestrator, store } = makeWorld({
      packs: { occupation: pack("qp_trade", [trade, shift]), universal: UNIVERSAL_PACK },
    });
    seed(store, {
      servedQuestionKey: null,
      engineAsks: 0,
      askCounts: {},
      packId: "qp_trade",
      packVersion: 1,
    });

    await orchestrator.takeTurn(say("shuru karte hain"));
    // The one physical answer to `q_trade`. `max_asks: 1` means this turn's own success is what
    // puts `q_shift` on screen — the precondition for everything below.
    const answered = await orchestrator.takeTurn(
      say("welding ka kaam", new Date(T0.getTime() + 1_000)),
    );
    expect(answered.questionKey).toBe("q_shift");

    // Copies two, three and four of that same submission, all inside the floor.
    for (const offset of [1_050, 1_100, 1_150]) {
      await orchestrator.takeTurn(say("welding ka kaam", new Date(T0.getTime() + offset)));
    }

    const answers = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(answers.some((a) => a.question_key === "q_trade")).toBe(true);
    // THE PHANTOM. The worker was never asked about shifts — the question only reached the screen
    // because this very submission put it there — and "welding ka kaam" is not an answer to it.
    expect(answers.some((a) => a.question_key === "q_shift")).toBe(false);
  });

  /**
   * THE FLOOR IS A FLOOR, NOT A SECOND WINDOW. Between it and `REPLY_CACHE_WINDOW_MS` sits the
   * band where a worker plausibly HAS read the next question and answered it in the same words —
   * the case #857 exists for — and there the spent budget must still win. Pinned explicitly
   * because nothing else in this suite exercises that band at all.
   */
  it("still runs a REAL turn for a spent budget once the storm floor has passed", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    // The first duplicate spends the budget.
    const dup = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 200)),
    );
    expect(dup.replayed).toBe(true);

    // Five seconds on: inside the ten-second cache window, well past the floor. A worker has had
    // every chance to read the new question, so identical words are their answer to it.
    const later = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 5_000)),
    );
    expect(later.replayed).toBe(false);
    expect(RETRY_STORM_FLOOR_MS).toBeLessThan(5_000);
    expect(store.get(SESSION)?.profiling?.rev).toBe(3);
  });

  /**
   * ⚠ THIS ASSERTION MOVED WITH #869, deliberately, and the old one is preserved below as the
   * boundary it became. It used to fire at 11 s — inside what is now the STALE window — and
   * asserted `replayed: false`, which is precisely the behaviour that let the shipped client's
   * 15 s timeout retry answer the next question with the previous question's words. The outer
   * bound of the cache is now `STALE_RESPONSE_WINDOW_MS`, not `REPLY_CACHE_WINDOW_MS`.
   */
  it("takes a REAL turn once the STALE window has passed", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const later = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + STALE_RESPONSE_WINDOW_MS + 1_000)),
    );
    expect(later.replayed).toBe(false);
    expect(store.get(SESSION)?.profiling?.rev).toBe(2);
  });

  it("still replays between the fresh and stale windows, writing nothing (#869)", async () => {
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("main pune me rehta hu"));
    const revAfterFirst = store.get(SESSION)?.profiling?.rev;

    const stale = await orchestrator.takeTurn(
      say("main pune me rehta hu", new Date(T0.getTime() + 11_000)),
    );

    expect(stale.replayed).toBe(true);
    // No rev bump: a stale replay consumes no budget, so it costs no CAS write either.
    expect(store.get(SESSION)?.profiling?.rev).toBe(revAfterFirst);
    expect(REPLY_CACHE_WINDOW_MS).toBeLessThan(11_000);
    expect(STALE_RESPONSE_WINDOW_MS).toBeGreaterThan(11_000);
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
        lookahead: null,
        inputMode: "text" as const,
        replays: 0,
      },
    });
    const result = await orchestrator.takeTurn(say("main pune me rehta hu"));
    expect(result.replayed).toBe(false);
  });

  /**
   * #766 item 2 — a replay carries the PREDICTION too, not just the words.
   *
   * The replay path is reached exactly when the link is flaky, which is the connection the
   * lookahead exists for. Serving the reply back without it would hand that worker the words and
   * silently drop the instant next-question render — the same downgrade `options` and `progress`
   * used to suffer here, and the reason `LastTurn` caches what the client draws.
   */
  it("replays the lookahead with the reply, rather than dropping it on the flaky link", async () => {
    const { orchestrator } = makeWorld();

    const first = await orchestrator.takeTurn(say("main welder hoon"));
    expect(first.replayed).toBe(false);
    // Guard against a vacuous assertion below: if the real turn predicted nothing there is
    // nothing for the replay to carry, and the test would pass without proving anything.
    expect(
      first.lookahead,
      "the seeded turn must predict for this test to mean anything",
    ).not.toBeNull();

    // The SAME words again inside the replay window — a retried submit over 2G.
    const replay = await orchestrator.takeTurn(say("main welder hoon"));
    expect(replay.replayed).toBe(true);
    expect(replay.reply).toBe(first.reply);
    expect(replay.lookahead).toEqual(first.lookahead);
  });
});

/**
 * THE STALE-RESPONSE WINDOW (#869).
 *
 * `REPLY_CACHE_WINDOW_MS` is 10 s; the shipped worker app's own HTTP deadline is 15 s
 * (`kRequestTimeout`). So the ONE retry that client is designed to produce — a POST that landed
 * but whose response was lost — arrived outside the cache window EVERY time, ran a real turn, and
 * captured the worker's words for question A against question B, which A's own success had put on
 * screen. N = 2, no storm, so neither the replay budget nor the storm floor could see it: both
 * live past the age test that rejected it.
 *
 * The pack below is the issue's own repro: `q_trade` at `max_asks: 1` (so it is settled and never
 * re-servable after one ask) followed by `q_shift`.
 */
describe("the stale-response window — a client timeout retry never answers the next question (#869)", () => {
  const TRADE = item({
    question_key: "q_trade",
    prompt_text: "Aap kya kaam karte hain?",
    max_asks: 1,
  });
  const SHIFT = item({ question_key: "q_shift", prompt_text: "Aap kaunsi shift kar sakte hain?" });

  const world = () => {
    const w = makeWorld({
      packs: { occupation: pack("qp_trade", [TRADE, SHIFT]), universal: UNIVERSAL_PACK },
    });
    seed(w.store, {
      servedQuestionKey: null,
      engineAsks: 0,
      askCounts: {},
      packId: "qp_trade",
      packVersion: 1,
    });
    return w;
  };

  /**
   * Put `q_trade` on screen, then answer it. The SECOND turn is the one that matters: its own
   * success advances the interview to `q_shift`, which is the question a stale retry would
   * otherwise be captured against.
   */
  const answerTrade = async (w: ReturnType<typeof world>) => {
    await w.orchestrator.takeTurn(say("shuru karein", T0));
    return w.orchestrator.takeTurn(say("welding ka kaam", new Date(T0.getTime() + 1_000)));
  };

  const answersFor = (w: ReturnType<typeof world>, key: string) =>
    w.store.get(SESSION)?.profiling?.answerMap.filter((a) => a.question_key === key) ?? [];

  it("REGRESSION: the 15s-timeout retry replays instead of settling q_shift with q_trade's words", async () => {
    const w = world();
    const first = await answerTrade(w);
    expect(first.questionKey).toBe("q_shift");

    // The client gave up at 15 s and re-sent the same bytes. Before the fix this was `replayed:
    // false` and wrote {"question_key":"q_shift","value_raw":"welding ka kaam"} — settling a
    // question the worker never saw, permanently, because `q_shift` had already been asked.
    const retry = await w.orchestrator.takeTurn(
      say("welding ka kaam", new Date(T0.getTime() + 17_000)),
    );

    expect(retry.replayed).toBe(true);
    expect(retry.reply).toBe(first.reply);
    expect(answersFor(w, "q_shift")).toEqual([]);
    // And q_trade keeps the one real answer it always had.
    expect(answersFor(w, "q_trade")[0]).toMatchObject({
      value_raw: "welding ka kaam",
      status: "answered",
    });
  });

  it("holds even once the replay budget is spent — the budget governs only the fresh window", async () => {
    const w = world();
    await answerTrade(w);
    // A first retry INSIDE the fresh window spends the budget (`MAX_REPLAYS_PER_TURN` is 1).
    await w.orchestrator.takeTurn(say("welding ka kaam", new Date(T0.getTime() + 4_000)));
    expect(w.store.get(SESSION)?.profiling?.lastTurn?.replays).toBe(1);

    // The 15 s timeout retry then lands with the budget already gone. Without `&& !stale` on the
    // budget check this falls straight through to a real turn — the defect, restored.
    const late = await w.orchestrator.takeTurn(
      say("welding ka kaam", new Date(T0.getTime() + 17_000)),
    );

    expect(late.replayed).toBe(true);
    expect(answersFor(w, "q_shift")).toEqual([]);
  });

  it("a stale replay writes NOTHING — no budget consumed, no CAS write", async () => {
    const w = world();
    await answerTrade(w);
    const revAfterFirst = w.store.get(SESSION)?.profiling?.rev;
    const savesAfterFirst = w.buffer.saveWithCas.mock.calls.length;

    await w.orchestrator.takeTurn(say("welding ka kaam", new Date(T0.getTime() + 17_000)));

    // `last.at` is never refreshed either, which is what makes the window shut by the clock on its
    // own rather than being extended by each retry — the property that removes the need for a
    // budget out here at all.
    expect(w.store.get(SESSION)?.profiling?.rev).toBe(revAfterFirst);
    expect(w.store.get(SESSION)?.profiling?.lastTurn?.replays).toBe(0);
    expect(w.buffer.saveWithCas.mock.calls.length).toBe(savesAfterFirst);
  });

  it("past the stale window the worker's considered second thought IS heard", async () => {
    // The other half of the trade-off, and the reason the fresh window was not simply widened: a
    // worker who really does repeat themselves must eventually get a turn, not an echo forever.
    const w = world();
    await answerTrade(w);

    const secondThought = await w.orchestrator.takeTurn(
      say("welding ka kaam", new Date(T0.getTime() + 40_000)),
    );

    expect(secondThought.replayed).toBe(false);
    expect(answersFor(w, "q_shift")).toHaveLength(1);
  });
});

/**
 * THE PER-SUBMISSION CLIENT ID — a different id is a real turn, however identical the words (#931).
 *
 * WHAT WAS WRONG. `inboundHash` is `(sessionId, rev, text)` stamped against `rev + 1`, so a worker
 * who answers the FOLLOWING question with the SAME word produces a byte-identical key at the
 * matching rev: their answer is discarded and the question re-served. Reproduced on device on the
 * qp_machining pack, which is what this block's fixture is — "Kya aap programme feed kar lete
 * hain?" → "haan" captured and the engine advances, then "Kya aap drawing padh lete hain?" →
 * "haan" thrown away. 236 of 466 authored items are `boolean` with zero options and the packs
 * place them back to back, so this is the ordinary case for a voice-first UI.
 *
 * A NEW SIBLING BLOCK, NOT AN EDIT TO THE TWO ABOVE. `LAYER A — the reply cache` and the #869
 * block build every inbound WITHOUT an id, so they take the hash + window path unchanged — a
 * zero-line diff there is the cheapest possible proof that the rollout requirement (old builds
 * must not regress) holds mechanically rather than by promise.
 */
describe("the per-submission client id — a different id is a real turn (#931)", () => {
  // The on-device pack, reduced to the two rows that reproduce it: consecutive `boolean` items
  // with ZERO options and `max_asks: 1`, so answering the first is guaranteed to advance to the
  // second and the second can never be re-served for an unrelated reason.
  const FEED = item({
    question_key: "q_feed",
    prompt_text: "Kya aap programme feed kar lete hain?",
    answer_type: "boolean",
    max_asks: 1,
  });
  const DRAWING = item({
    question_key: "q_drawing",
    prompt_text: "Kya aap drawing padh lete hain?",
    answer_type: "boolean",
    max_asks: 1,
  });

  /** The word a worker actually uses. Both questions get it, which is the entire defect. */
  const YES = "haan";
  const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const ID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

  const world = () => {
    const w = makeWorld({
      packs: { occupation: pack("qp_machining", [FEED, DRAWING]), universal: UNIVERSAL_PACK },
    });
    seed(w.store, {
      servedQuestionKey: null,
      engineAsks: 0,
      askCounts: {},
      packId: "qp_machining",
      packVersion: 1,
    });
    return w;
  };

  /**
   * Put `q_feed` on screen and answer it with `YES`. The SECOND turn is the one that matters: its
   * own success advances the interview to `q_drawing` and stamps `YES` at the new rev, which is
   * exactly the state in which the worker's next `YES` collides with it.
   */
  const answerFeed = async (w: ReturnType<typeof world>, submissionId: string | null) => {
    await w.orchestrator.takeTurn(say("shuru karein", T0));
    return w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 1_000), submissionId));
  };

  const answersFor = (w: ReturnType<typeof world>, key: string) =>
    w.store.get(SESSION)?.profiling?.answerMap.filter((a) => a.question_key === key) ?? [];

  const stampOf = (w: ReturnType<typeof world>) => w.store.get(SESSION)?.profiling?.lastTurn;
  const revOf = (w: ReturnType<typeof world>) => w.store.get(SESSION)?.profiling?.rev;

  it("ACCEPTANCE: two consecutive boolean questions answered 'haan' capture BOTH answers", async () => {
    // The on-device repro, literally. Asserted on the ANSWER MAP and not only on `replayed`,
    // because the harm is a worker's answer going missing — a counter is a stand-in for it.
    const w = world();
    const feed = await answerFeed(w, ID_A);
    expect(feed.questionKey).toBe("q_drawing");

    const drawing = await w.orchestrator.takeTurn(
      say(YES, new Date(T0.getTime() + 2_000), ID_B),
    );

    expect(drawing.replayed).toBe(false);
    expect(answersFor(w, "q_feed")).toHaveLength(1);
    expect(answersFor(w, "q_drawing")).toHaveLength(1);
  });

  it("runs a real turn on a DIFFERENT id even though the hash matches byte for byte", async () => {
    // The same fact as the acceptance case, at the level of the one line that fixes it. The hash
    // is asserted to MATCH first: without that this test would pass for the wrong reason the day
    // something else changes the key, and would stop testing the fix at all.
    const w = world();
    await answerFeed(w, ID_A);
    expect(stampOf(w)?.inboundHash).toBe(inboundHash(SESSION, revOf(w) as number, YES));

    const next = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_B));

    expect(next.replayed).toBe(false);
  });

  it("replays the byte-identical reply for the SAME id, and writes NOTHING", async () => {
    // A genuine transport retry: the client re-sent the exact submission it has no confirmation
    // for. It gets the response it missed, and — unlike the hash path — no CAS write at all: the
    // budget exists only to stop a stamp trapping the worker's NEXT answer, and their next answer
    // carries a different id and can never match this stamp.
    const w = world();
    const first = await answerFeed(w, ID_A);
    const revAfterFirst = revOf(w);
    const writesAfterFirst = w.buffer.saveWithCas.mock.calls.length;

    const retry = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_A));

    expect(retry.replayed).toBe(true);
    expect(retry.reply).toBe(first.reply);
    expect(retry.questionKey).toBe(first.questionKey);
    expect(retry.options).toEqual(first.options);
    expect(revOf(w)).toBe(revAfterFirst);
    expect(stampOf(w)?.replays).toBe(0);
    expect(w.buffer.saveWithCas.mock.calls.length).toBe(writesAfterFirst);
  });

  it("absorbs a whole storm of ONE id without ever spending the budget (#858 stays closed)", async () => {
    // Copies two and three milliseconds apart — the shape #858 was measured on. On the hash path
    // this is what `RETRY_STORM_FLOOR_MS` is for; here there is nothing to bound, because every
    // copy carries the same id and is therefore the same submission by construction.
    const w = world();
    const first = await answerFeed(w, ID_A);
    const revAfterFirst = revOf(w);

    for (const offset of [2, 3, 4]) {
      const copy = await w.orchestrator.takeTurn(
        say(YES, new Date(T0.getTime() + 1_000 + offset), ID_A),
      );
      expect(copy.replayed).toBe(true);
      expect(copy.reply).toBe(first.reply);
    }
    expect(revOf(w)).toBe(revAfterFirst);
    expect(answersFor(w, "q_drawing")).toHaveLength(0);
  });

  it("still replays the SAME id past the stale window — an id is a fact, not a guess", async () => {
    // THE RULING, PINNED ON PURPOSE. The clocks exist to disambiguate a match the server cannot
    // otherwise read; an id-matched submission is not ambiguous, so no window, budget or floor is
    // consulted on that path — and the hash test in front of it already bounds the branch to
    // "nothing has happened since", since any real turn moves `rev` and the key stops matching.
    // The client's own transcript deadline is ~150 s, well outside the 30 s stale window, so this
    // is a case that happens rather than a hypothetical. This test is what stops a later reader
    // "tidying" the two paths into one.
    const w = world();
    const first = await answerFeed(w, ID_A);

    const late = await w.orchestrator.takeTurn(
      say(YES, new Date(T0.getTime() + 40_000), ID_A),
    );

    expect(late.replayed).toBe(true);
    expect(late.reply).toBe(first.reply);
    expect(answersFor(w, "q_drawing")).toHaveLength(0);
  });

  it("but stops replaying once even the slowest client could not still be retrying", async () => {
    // THE OTHER HALF OF THE RULING ABOVE, and the reason that one survived review rather than
    // being reverted. `An id is a fact` holds for a correct client; a client that reuses one id
    // across two sends is broken, and with NO bound its every later send matches this stamp and
    // writes nothing — `rev` never moves, the stamp never ages, and the interview wedges for the
    // 24 h buffer TTL on a question the worker cannot type past. The bound is sized off the
    // longest deadline a shipped client actually has (150 s, the in-request transcript wait), so
    // the sibling above — a real 40 s retry — still replays, and only a wedge ages out.
    const w = world();
    await answerFeed(w, ID_A);

    const wedged = await w.orchestrator.takeTurn(
      say(YES, new Date(T0.getTime() + ID_REPLAY_MAX_AGE_MS + 5_000), ID_A),
    );

    expect(wedged.replayed).toBeFalsy();
  });

  it("LEGACY: with NO id on either side the hash and the windows decide, exactly as today", async () => {
    // THE ROLLOUT REQUIREMENT, as an explicit named guard rather than as implicit coverage from
    // the untouched blocks above. Old app builds stay in the field for a long time, and for them
    // this replay — including the defect it represents, which is why #931 step 4 exists — must
    // keep behaving precisely as it did: served from the budget, one CAS write, `replays` at 1.
    const w = world();
    const first = await answerFeed(w, null);
    const revAfterFirst = revOf(w);

    const again = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), null));

    expect(again.replayed).toBe(true);
    expect(again.reply).toBe(first.reply);
    expect(revOf(w)).toBe((revAfterFirst as number) + 1);
    expect(stampOf(w)?.replays).toBe(1);
  });

  it("falls back to the clock when the STAMP has no id — the deploy straddle", async () => {
    // Every `lastTurn` in Redis at deploy time was written without this field and is alive behind
    // a 24 h TTL. An id can only be compared with an id, so a session straddling the deploy is
    // judged by the hash and the windows for exactly one turn and self-heals on the next real one.
    const w = world();
    const first = await answerFeed(w, null);
    expect(stampOf(w)?.submissionId).toBeNull();
    const revAfterFirst = revOf(w);

    const withId = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_B));

    expect(withId.replayed).toBe(true);
    expect(withId.reply).toBe(first.reply);
    expect(revOf(w)).toBe((revAfterFirst as number) + 1);
  });

  it("reads an envelope written by the OLD BUILD as 'no id', never as a match", async () => {
    // THE DEPLOY STRADDLE AT ITS LITERAL WORST, and the reason `narrowLastTurn` defaults this
    // field rather than leaving it alone. The test above stamps an explicit `null`; a stamp
    // written by the previous build has NO SUCH KEY AT ALL, which is a different value in
    // JavaScript and — left un-narrowed — a differently BEHAVING one: `undefined !== null` is
    // true, so the guard would open on a stamp that carries no id, read the inbound's id as
    // "different", and take a REAL TURN on what is genuinely a retry. That is #857/#858/#869
    // regressing for every session alive at deploy time, caused by the new field rather than by
    // the old ones. Deleting the key here and loading it back through the REAL narrower is what
    // proves absent lands on the hash + window path instead.
    const w = world();
    const first = await answerFeed(w, null);
    const stored = w.store.get(SESSION) as TranscriptBuffer;
    const legacyStamp = { ...(stored.profiling?.lastTurn as LastTurn) };
    delete (legacyStamp as { submissionId?: unknown }).submissionId;
    expect("submissionId" in legacyStamp).toBe(false);
    w.store.set(SESSION, {
      ...stored,
      profiling: { ...(stored.profiling as ProfilingEnvelope), lastTurn: legacyStamp },
    });
    const revAfterFirst = revOf(w);

    const withId = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_B));

    // Judged by the hash and the windows: a budget-consuming replay, exactly as yesterday.
    expect(withId.replayed).toBe(true);
    expect(withId.reply).toBe(first.reply);
    expect(revOf(w)).toBe((revAfterFirst as number) + 1);
    expect(stampOf(w)?.replays).toBe(1);
    // And the session self-heals: the stamp it just re-wrote narrows to an explicit `null`.
    expect(stampOf(w)?.submissionId).toBeNull();
  });

  it("falls back to the clock when the INBOUND has no id — an old build mid-session", async () => {
    // The mirror case, and it is not hypothetical: there is no mode-lock, so a worker may start
    // in the voice form and continue in chat on a build that sends no id.
    const w = world();
    const first = await answerFeed(w, ID_A);

    const noId = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), null));

    expect(noId.replayed).toBe(true);
    expect(noId.reply).toBe(first.reply);
    expect(stampOf(w)?.replays).toBe(1);
  });

  describe("the rulings the id branch is written around", () => {
    it("one id reused across DIFFERENT words never discards the second — the hash test stays in front", async () => {
      // The comment above the id branch forbids testing id-first: a client bug that reused one id
      // across two different utterances would then discard the second — a brand-new way to lose a
      // worker's words, worse than the defect being fixed. Behind the hash, the text comparison
      // catches it and the turn runs for real. Nothing asserted that ruling, because every other
      // test in this block sends the same word twice.
      const { orchestrator } = makeWorld();
      const first = await orchestrator.takeTurn(say("haan", T0, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"));
      expect(first.replayed).toBeFalsy();

      const second = await orchestrator.takeTurn(
        say("nahi", new Date(T0.getTime() + 2_000), "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
      );
      expect(second.replayed).toBeFalsy();
    });

  });

  describe("a duplicate is observable (#931 step 5)", () => {
    const dupEvents = (w: ReturnType<typeof world>) =>
      w.events.emit.mock.calls
        .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
        .filter((e) => e.event_name === "profile.submission_duplicated");

    it("emits the id-matched duplicate with the branch that absorbed it", async () => {
      const w = world();
      await answerFeed(w, ID_A);

      await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_A));

      const [event, ...rest] = dupEvents(w);
      expect(rest).toHaveLength(0);
      expect(event?.payload).toMatchObject({
        session_id: SESSION,
        worker_id: WORKER,
        question_key: "q_drawing",
        absorbed_as: "client_id",
        inbound_had_id: true,
        replays: 0,
      });
    });

    it("emits the legacy duplicate as a CLOCK branch — the signal step 4 is gated on", async () => {
      // `absorbed_as` going to `client_id` across the field is what says the four constants can
      // finally be retired. A duplicate the clock absorbed says the opposite, and says it whether
      // or not the inbound carried an id — which is why both fields are on the payload.
      const w = world();
      await answerFeed(w, null);

      await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), null));

      expect(dupEvents(w)[0]?.payload).toMatchObject({
        absorbed_as: "budget",
        inbound_had_id: false,
      });
    });

    it("carries NO worker text, and collapses a storm to ONE row", async () => {
      // §2: ids, one pack key, two enums and two counts. The worker's words live in the
      // transcript. The idempotency key is what stops a broken client turning one submission into
      // a row per POST — the volume ceiling is per duplicated SUBMISSION.
      const w = world();
      await answerFeed(w, ID_A);
      for (const offset of [2, 3, 4]) {
        await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 1_000 + offset), ID_A));
      }

      const events = dupEvents(w);
      expect(events).toHaveLength(3);
      const keys = new Set(
        w.events.emit.mock.calls
          .map(([params]) => params as { event_name: string; idempotencyKey?: string })
          .filter((e) => e.event_name === "profile.submission_duplicated")
          .map((e) => e.idempotencyKey),
      );
      expect(keys.size).toBe(1);
      expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(YES);
    });

    it("never fails the turn when the audit write does", async () => {
      // The worker's duplicate was already absorbed correctly; losing the reply on top of that
      // would turn an invisible telemetry failure into a visible interview failure.
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const w = world();
      const first = await answerFeed(w, ID_A);
      w.events.emit.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

      const retry = await w.orchestrator.takeTurn(say(YES, new Date(T0.getTime() + 2_000), ID_A));

      expect(retry.replayed).toBe(true);
      expect(retry.reply).toBe(first.reply);
      vi.restoreAllMocks();
    });
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

  it("FAILS CLOSED on the id path too — the guard is about the stamp, not about who matched it", async () => {
    // THE REGRESSION THIS PINS (#931). The sibling above passed while the id path served the
    // dead end, because `say()` defaults `submissionId` to null and so exercised only the clock
    // path. The id branch had been written BELOW the guard, so an id-carrying retry — which
    // every shipped client now is, since #870 — was handed `kind: "disambiguate"` with zero
    // chips, and handed it on EVERY retry, that branch consulting no window that could age it
    // out. Same scenario as above, one argument different.
    const { orchestrator, store } = makeWorld({ identifyOffer: OFFER });
    seed(store);
    const first = await orchestrator.takeTurn(say("welding ka kaam", T0, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"));
    expect(first.kind).toBe("disambiguate");

    const held = store.get(SESSION) as TranscriptBuffer;
    const envelope = held.profiling as ProfilingEnvelope;
    store.set(SESSION, {
      ...held,
      profiling: {
        ...envelope,
        lastTurn: { ...envelope.lastTurn!, options: [] },
      } as ProfilingEnvelope,
    });

    // The SAME id — a genuine transport retry, the case the id branch exists to absorb.
    const onId = await orchestrator.takeTurn(say("welding ka kaam", T0, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"));
    expect(onId.replayed).toBeFalsy();
    expect(onId.options.length).toBeGreaterThan(0);
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
        lookahead: null,
        inputMode: "text" as const,
        replays: 0,
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
