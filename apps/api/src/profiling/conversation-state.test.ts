import { describe, expect, it } from "vitest";

import type { AnswerRecord, OccupationPin } from "@badabhai/ai-contracts";

import {
  answersOf,
  emptyProfilingEnvelope,
  inboundHash,
  narrowProfilingEnvelope,
  PROFILING_ENVELOPE_KEYS,
  toConversationStatePatch,
  toEngineState,
  withAnswers,
  type ProfilingEnvelope,
} from "./conversation-state";
import { recordAnswer } from "./answer-map";

/** A closing reply carries no question key. */
const CLOSING_ISH = "Aapki baat poori ho chuki hai.";

const PIN: OccupationPin = {
  job_domain_id: "dom_welder",
  label: "Welder",
  isco_unit_code: "7212",
  match_status: "matched_worker_confirmed",
  match_score: 0.91,
  match_layer: "l1_skeleton",
  pack_id: "qp_welding",
  pack_version: 3,
  catalog_version: "cat_2026_08",
};

const ANSWER: AnswerRecord = {
  question_key: "q_years",
  target_field: "experience_years",
  value_raw: "7 saal",
  value_normalized: 7,
  status: "answered",
  evidence: null,
  turn: 2,
  history: [],
};

/**
 * EVERY field set to a NON-DEFAULT value.
 *
 * That is what makes the round-trip test meaningful: a fixture full of defaults would pass
 * against a `narrow` that dropped the field and rebuilt the default, which is precisely the bug
 * being tested for.
 */
const FULL: ProfilingEnvelope = {
  rev: 12,
  phase: "universal_tail",
  occupation: PIN,
  answerMap: [ANSWER],
  engineAsks: 9,
  askCounts: { q_years: 2, q_city: 1 },
  servedQuestionKey: "q_city",
  clarifyCount: 1,
  abusiveTurns: 2,
  silentTurns: 1,
  hardshipTurns: 1,
  needsDisambiguation: true,
  disambiguationOffer: [{ label: "Welder", jobDomainId: "jd_nco_7212_0100", familyId: "fam_welding" }],
  identifyAttempts: 1,
  packId: "qp_welding",
  packVersion: 3,
  catalogVersion: "cat_2026_08",
  lastTurn: {
    inboundHash: "a".repeat(64),
    reply: "Aap kis sheher mein rehte hain?",
    questionKey: "q_city",
    at: "2026-08-06T10:00:00.000Z",
  },
  // Every bucket distinct and non-zero, for the same reason as every other field here: a
  // zeroed histogram would round-trip identically through a `narrow` that dropped it entirely.
  turnLatency: { le_100: 4, le_200: 3, le_400: 2, le_800: 1, gt_800: 5, max_ms: 1234 },
  occupationFamilyId: "fam_welding",
  occupationRepins: 1,
};

describe("⚠ THE FIELD-DROP TRAP — narrow() round-trips every v2 field", () => {
  it("survives a full JSON round trip with nothing dropped and nothing changed", () => {
    // The real path: JSON.stringify on save, JSON.parse on load, then narrow.
    const reloaded = narrowProfilingEnvelope(JSON.parse(JSON.stringify(FULL)));
    expect(reloaded).toEqual(FULL);
  });

  it("the fixture itself covers EVERY key, so the round trip above cannot be vacuous", () => {
    // Without this the round trip proves only that the fields the fixture happens to set survive.
    // `PROFILING_ENVELOPE_KEYS` is compile-time exhaustive over the interface, so this is the
    // link that makes a new field fail HERE if it is added to the fixture but not to narrow, and
    // fail at BUILD time if it is added to neither.
    expect(Object.keys(FULL).sort()).toEqual(Object.keys(PROFILING_ENVELOPE_KEYS).sort());
  });

  it("narrow returns exactly those keys — no extras, no omissions", () => {
    const reloaded = narrowProfilingEnvelope(JSON.parse(JSON.stringify(FULL)));
    expect(Object.keys(reloaded as object).sort()).toEqual(
      Object.keys(PROFILING_ENVELOPE_KEYS).sort(),
    );
  });

  it("drops a key the envelope does not declare rather than letting it ride back", () => {
    const withStale = { ...FULL, legacyTopicIds: ["role"], captured: { x: "y" } };
    const reloaded = narrowProfilingEnvelope(JSON.parse(JSON.stringify(withStale)));
    expect(reloaded).not.toHaveProperty("legacyTopicIds");
    expect(reloaded).not.toHaveProperty("captured");
  });
});

describe("a stored value that is not an envelope", () => {
  it("is ABSENT, not defaulted — a v1 interview has no envelope", () => {
    // Handing back a fresh envelope would restart a deterministic interview at question one
    // while claiming it had never started.
    for (const value of [null, undefined, 7, "x", [], {}, { phase: "identify" }]) {
      expect(narrowProfilingEnvelope(value)).toBeUndefined();
    }
  });

  it("is keyed on `rev`, because that is the field only this code path writes", () => {
    expect(narrowProfilingEnvelope({ rev: 0 })).toBeDefined();
    expect(narrowProfilingEnvelope({ rev: "0" })).toBeUndefined();
    expect(narrowProfilingEnvelope({ rev: Number.NaN })).toBeUndefined();
  });
});

describe("a present-but-damaged envelope is REPAIRED, never discarded", () => {
  it("clamps every counter at zero — a negative would BUY EXTRA ASKS", () => {
    const damaged = narrowProfilingEnvelope({
      ...FULL,
      engineAsks: -5,
      clarifyCount: -1,
      abusiveTurns: -3,
      silentTurns: -2,
      hardshipTurns: -9,
      askCounts: { q_years: -4, q_city: 1.9, q_bad: "2" },
    });
    expect(damaged?.engineAsks).toBe(0);
    expect(damaged?.clarifyCount).toBe(0);
    expect(damaged?.abusiveTurns).toBe(0);
    expect(damaged?.silentTurns).toBe(0);
    expect(damaged?.hardshipTurns).toBe(0);
    expect(damaged?.askCounts).toEqual({ q_years: 0, q_city: 1 });
  });

  it("falls back to `identify` for a phase outside the closed set", () => {
    expect(narrowProfilingEnvelope({ ...FULL, phase: "sudden_death" })?.phase).toBe("identify");
  });

  it("drops an unparseable occupation pin rather than trusting a partial one", () => {
    // A pin missing `job_domain_id` cannot pin anything; keeping it would let the engine believe
    // an occupation was identified when nothing was.
    const broken = narrowProfilingEnvelope({ ...FULL, occupation: { label: "Welder" } });
    expect(broken?.occupation).toBeNull();
  });

  it("drops ONE malformed answer, never the whole interview", () => {
    const mixed = narrowProfilingEnvelope({
      ...FULL,
      answerMap: [ANSWER, { question_key: "NOT A SLUG" }, { nonsense: true }],
    });
    expect(mixed?.answerMap).toHaveLength(1);
    expect(mixed?.answerMap[0]?.question_key).toBe("q_years");
  });

  it("drops a half-written reply-cache entry, so a retry takes a real turn", () => {
    // A `lastTurn` with no hash can never match, but one with no `at` would be judged against
    // `new Date(undefined)` — NaN — and that must not read as "inside the window".
    for (const bad of [{}, { inboundHash: "x" }, { inboundHash: "x", reply: "y" }, "nope"]) {
      expect(narrowProfilingEnvelope({ ...FULL, lastTurn: bad })?.lastTurn).toBeNull();
    }
  });

  it("keeps a reply-cache entry that has no question key — a CLOSE has none", () => {
    const closed = narrowProfilingEnvelope({
      ...FULL,
      lastTurn: { inboundHash: "b".repeat(64), reply: CLOSING_ISH, at: "2026-08-06T10:00:00.000Z" },
    });
    expect(closed?.lastTurn?.questionKey).toBeNull();
    expect(closed?.lastTurn?.reply).toBe(CLOSING_ISH);
  });

  it("refuses a non-positive pack version", () => {
    expect(narrowProfilingEnvelope({ ...FULL, packVersion: 0 })?.packVersion).toBeNull();
    expect(narrowProfilingEnvelope({ ...FULL, packVersion: 1.5 })?.packVersion).toBeNull();
  });
});

describe("the reply-cache key", () => {
  it("binds session, rev AND text — changing any one changes the hash", () => {
    const base = inboundHash("s1", 3, "pune");
    expect(inboundHash("s2", 3, "pune")).not.toBe(base);
    expect(inboundHash("s1", 4, "pune")).not.toBe(base);
    expect(inboundHash("s1", 3, "mumbai")).not.toBe(base);
    expect(inboundHash("s1", 3, "pune")).toBe(base);
  });

  it("never contains the worker's words — it reaches logs and metrics", () => {
    expect(inboundHash("s1", 3, "main pune me rehta hu")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("projections", () => {
  it("hands the engine a strict SUBSET, with the turn supplied by the caller", () => {
    // The turn count lives on the transcript buffer and is shared with the v1 path; a second copy
    // in the envelope would be free to disagree with it.
    const state = toEngineState(FULL, 14);
    expect(state.turn).toBe(14);
    expect(state.phase).toBe("universal_tail");
    expect(state.answers.q_years?.value_normalized).toBe(7);
    expect(state).not.toHaveProperty("rev");
    expect(state).not.toHaveProperty("lastTurn");
  });

  it("round-trips the answer map through the contract's array form", () => {
    const filled = withAnswers(
      emptyProfilingEnvelope(),
      recordAnswer(
        {},
        {
          questionKey: "q_city",
          targetField: "current_city",
          valueRaw: "pune",
          valueNormalized: "Pune",
          evidence: null,
        },
        1,
      ),
    );
    expect(answersOf(filled).q_city?.value_normalized).toBe("Pune");
  });

  it("projects the SEVEN frozen OIE fields plus a populated `captured`", () => {
    const patch = toConversationStatePatch(FULL);
    expect(patch.phase).toBe("universal_tail");
    expect(patch.occupation).toEqual(PIN);
    expect(patch.answer_map).toEqual([ANSWER]);
    expect(patch.engine_asks).toBe(9);
    expect(patch.pack_id).toBe("qp_welding");
    expect(patch.pack_version).toBe(3);
    expect(patch.catalog_version).toBe("cat_2026_08");
    // `captured` STAYS POPULATED across the cutover — every existing reader of the flattened map
    // keeps working while `answer_map` becomes the record underneath it.
    expect(patch.captured).toEqual({ experience_years: "7" });
  });

  it("does NOT rebuild the v1 fields it does not own", () => {
    // Two writers for one field is how `role_family` and `turn_count` would start disagreeing.
    const patch = toConversationStatePatch(FULL) as Record<string, unknown>;
    expect(patch).not.toHaveProperty("role_family");
    expect(patch).not.toHaveProperty("turn_count");
    expect(patch).not.toHaveProperty("answered_topics");
  });
});
