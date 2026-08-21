/**
 * `IdentifyService` — the join between retrieval and the interview.
 *
 * WHAT THESE TESTS ARE FOR. This class decides whether a worker's sentence becomes a pinned
 * occupation, a set of chips, or a fall back to the universal pack — and every one of those
 * choices changes which twelve questions they are asked for the rest of the conversation. It
 * also holds the one place in the deterministic turn loop where worker text can leave memory.
 *
 * `OccupationService` is STUBBED, deliberately: the ladder, its calibration and its thresholds
 * have their own suite measured against the gold set. What is under test here is the
 * translation — a `ResolveResult` into envelope state, chips and events.
 */
import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "@nestjs/common";

import { emptyProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";
import {
  IdentifyService,
  MAX_IDENTIFY_ATTEMPTS,
  MAX_OCCUPATION_REPINS,
  DISAMBIGUATION_PROMPT,
} from "./identify.service";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = {
  sessionId: SESSION,
  workerId: WORKER,
  correlationId: "33333333-3333-4333-8333-333333333333",
  requestId: "req-1",
} as never;

const CANDIDATE = {
  jobDomainId: "jd_nco_7531_0100",
  label: "darzi",
  familyId: "fam_tailoring",
  iscoUnitCode: "7531",
  confidence: 0.97,
  layer: "L0" as const,
};

function resolveResult(over: Record<string, unknown> = {}) {
  return {
    status: "unresolved",
    catalogVersion: "cat_2026_08",
    pinned: null,
    candidates: [],
    disambiguationOptions: [],
    needsDisambiguation: false,
    embedSpent: false,
    reason: "nothing cleared the floor",
    ...over,
  };
}

/**
 * `key in over`, NOT `over.x ?? default`.
 *
 * `null` is MEANINGFUL for both `describe` (the catalogue moved under a live conversation) and
 * `pseudonymize` (the gateway is unreachable), and `??` would silently substitute the happy-path
 * default for exactly the two cases those tests exist to cover — turning them into duplicates of
 * tests that already pass.
 */
function make(over: { resolve?: unknown; describe?: unknown; pseudonymize?: unknown } = {}) {
  const DESCRIBED = {
    jobDomainId: CANDIDATE.jobDomainId,
    labelEn: "Tailor, General",
    labelHi: null,
    label: "darzi",
    iscoUnitCode: "7531",
    familyId: "fam_tailoring",
    catalogVersion: "cat_2026_08",
  };
  const occupation = {
    resolve: vi.fn(async () => ("resolve" in over ? over.resolve : resolveResult())),
    recordUnresolved: vi.fn(async () => ({ count: 3 })),
    describeDomain: vi.fn(() => ("describe" in over ? over.describe : DESCRIBED)),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const ai = {
    pseudonymize: vi.fn(async () =>
      "pseudonymize" in over
        ? over.pseudonymize
        : { pseudonymized_text: "kharad ka kaam", blocked: false },
    ),
  };
  const svc = new IdentifyService(occupation as never, events as never, ai as never);
  return { svc, occupation, events, ai };
}

const env = (over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  ...over,
});

const emitted = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map(
    (c) => c[0] as { event_name: string; payload: Record<string, unknown> },
  );

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

describe("identification never runs when it should not", () => {
  it("a pinned occupation is not re-pinned on a match in the SAME family", async () => {
    // CONDITION 2 of the re-pin guard. "Welder, Gas" vs "Welder, Electric" is a coin flip at
    // occupation level and identical at family level — which is the entire reason the ladder
    // resolves families first. Re-pinning here would swap the pack for the one the interview
    // already had, discarding progress to arrive back where it started.
    const { svc } = make({ resolve: resolveResult({ status: "auto", pinned: CANDIDATE }) });
    const result = await svc.identify(
      env({
        occupation: { ...CANDIDATE, job_domain_id: "jd_other_in_same_family" } as never,
        occupationFamilyId: CANDIDATE.familyId,
      }),
      "silai machine bhi chalata hoon",
      CTX,
    );
    expect(result.patch).toEqual({});
    expect(result.pinned).toBeNull();
  });

  it("a pinned occupation is not re-pinned on anything less than an `auto` match", async () => {
    // CONDITION 1. A worker naming a second machine inside their own trade produces a weak
    // match or none — never a confident, well-separated one on a different family. Anything
    // below `auto` is exactly that weak signal, and acting on it is how a welder becomes a
    // machine operator halfway through their own interview.
    const { svc } = make({
      resolve: resolveResult({
        status: "disambiguate",
        pinned: { ...CANDIDATE, familyId: "fam_driving" },
      }),
    });
    const result = await svc.identify(
      env({ occupation: CANDIDATE as never, occupationFamilyId: "fam_tailoring" }),
      // Carries a first-person claim ON PURPOSE, so CONDITION 0 lets it through and the
      // sub-`auto` status is what actually blocks it. With "tempo bhi hai ghar pe" here this
      // test passed without ever reaching the check it is named after.
      "ab main tempo bhi chalata hoon",
      CTX,
    );
    expect(result.patch).toEqual({});
    expect(result.pinned).toBeNull();
  });

  it("does not re-pin on an ANSWER to the question on screen, only on a claim", async () => {
    // THE REGRESSION THIS EXISTS FOR, observed in a live interview: a CNC worker was asked
    // "Aap kaunsi machine chalate hain?" and tapped the pack's own "Koi aur machine" chip. The
    // ladder ran on that chip label, returned an `auto` match on a different family, and re-pinned
    // the interview to Milker on turn three -- where, the budget being one, it stayed.
    //
    // The chip label is asserted rather than a paraphrase because it is the exact string the
    // client sends when a worker taps that option, and a chip tap is the single least ambiguous
    // "this is an answer, not a claim" signal in the whole system.
    const { svc, occupation } = make({
      resolve: resolveResult({ status: "auto", pinned: { ...CANDIDATE, familyId: "fam_dairy" } }),
    });
    const result = await svc.identify(
      env({ occupation: CANDIDATE as never, occupationFamilyId: "fam_machining" }),
      "Koi aur machine",
      CTX,
    );
    // Not merely refused -- never asked. The four retrieval layers must not run on a pack answer.
    expect(occupation.resolve).not.toHaveBeenCalled();
    expect(result.patch).toEqual({});
    expect(result.pinned).toBeNull();
  });

  it("stops re-pinning once MAX_OCCUPATION_REPINS is spent", async () => {
    // Not because a second re-pin is less trustworthy than the first: an interview that keeps
    // changing packs never DRAINS one, and a worker who answers twelve questions across three
    // trades has completed none of them.
    const { svc, occupation } = make({
      resolve: resolveResult({ status: "auto", pinned: { ...CANDIDATE, familyId: "fam_driving" } }),
    });
    const result = await svc.identify(
      env({
        occupation: CANDIDATE as never,
        occupationFamilyId: "fam_tailoring",
        occupationRepins: MAX_OCCUPATION_REPINS,
      }),
      "ab kuch aur karta hoon",
      CTX,
    );
    // The ladder is not even consulted — the budget check short-circuits before retrieval.
    expect(occupation.resolve).not.toHaveBeenCalled();
    expect(result.patch).toEqual({});
    expect(result.pinned).toBeNull();
  });

  it("⚠ a re-pin NEVER discards an answer — only unanswered questions", async () => {
    // THE PLAN'S RULE, and the reason a re-pin costs the worker nothing they already said.
    // "ab tempo chalata hun": the trade changed, so the old pack's UNASKED questions are now
    // the wrong questions — but every word the worker actually gave us is still true.
    const answered = {
      question_key: "q_years",
      target_field: "experience_years",
      value_raw: "7 saal",
      value_normalized: 7,
      status: "answered",
      evidence: null,
      turn: 3,
      history: [],
    };
    const declined = {
      ...answered,
      question_key: "q_salary",
      status: "declined",
      value_raw: "nahi pata",
    };
    const superseded = { ...answered, question_key: "q_city", status: "superseded" };
    const unanswered = { ...answered, question_key: "q_stitch_type", status: "unanswered" };

    const { svc } = make({
      resolve: resolveResult({
        status: "auto",
        pinned: { ...CANDIDATE, familyId: "fam_driving", jobDomainId: "jd_nco_8322_0100" },
      }),
    });

    const result = await svc.identify(
      env({
        occupation: CANDIDATE as never,
        occupationFamilyId: "fam_tailoring",
        occupationRepins: 0,
        answerMap: [answered, declined, superseded, unanswered] as never,
        askCounts: { q_years: 1, q_stitch_type: 2 },
      }),
      "ab tempo chalata hoon",
      CTX,
    );

    expect(result.pinned).not.toBeNull();
    expect(result.patch.occupationRepins).toBe(1);
    expect(result.patch.occupationFamilyId).toBe("fam_driving");

    // Every answered/declined/superseded record survives; only the unanswered one is dropped.
    const keys = (result.patch.answerMap ?? []).map((a) => a.question_key).sort();
    expect(keys).toEqual(["q_city", "q_salary", "q_years"]);

    // The dropped question's ask budget is cleared so the NEW pack can ask a same-named
    // question; the surviving answer's counter is untouched. Without this the new pack
    // inherits exhausted counters and silently skips its own questions.
    expect(result.patch.askCounts).toEqual({ q_years: 1 });
  });

  it("does not refund the global ask budget on a re-pin", async () => {
    // `engineAsks` is what guarantees the interview terminates. Refunding it would make a
    // re-pin a way to run forever.
    const { svc } = make({
      resolve: resolveResult({ status: "auto", pinned: { ...CANDIDATE, familyId: "fam_driving" } }),
    });
    const result = await svc.identify(
      env({
        occupation: CANDIDATE as never,
        occupationFamilyId: "fam_tailoring",
        engineAsks: 9,
      }),
      "ab tempo chalata hoon",
      CTX,
    );
    expect(result.pinned).not.toBeNull();
    expect(result.patch.engineAsks).toBeUndefined(); // untouched, so the merge preserves 9
  });

  it("stops running the ladder once the attempt budget is spent", async () => {
    const { svc, occupation } = make();
    const result = await svc.identify(
      env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS }),
      "kuch bhi",
      CTX,
    );
    expect(occupation.resolve).not.toHaveBeenCalled();
    expect(result.patch).toEqual({});
  });
});

describe("auto-pin", () => {
  const auto = {
    resolve: resolveResult({ status: "auto", pinned: CANDIDATE, candidates: [CANDIDATE] }),
  };

  it("pins the occupation, moves to the occupation phase, and reports it to the caller", async () => {
    const { svc } = make(auto);
    const result = await svc.identify(env(), "silai ka kaam karta hoon", CTX);
    expect(result.patch.occupation).toMatchObject({
      job_domain_id: CANDIDATE.jobDomainId,
      label: "darzi",
      match_status: "matched_lexical",
      match_layer: "l0_exact",
      match_score: 0.97,
    });
    expect(result.patch.phase).toBe("occupation_specific");
    expect(result.pinned).not.toBeNull();
    expect(result.offer).toBeNull();
  });

  it("emits profile.occupation_identified ONCE per session", async () => {
    const { svc, events } = make(auto);
    await svc.identify(env(), "silai ka kaam", CTX);
    const [event] = emitted(events);
    expect(event?.event_name).toBe("profile.occupation_identified");
    expect(event?.payload).toMatchObject({
      job_domain_id: CANDIDATE.jobDomainId,
      family_id: "fam_tailoring",
      match_layer: "l0_exact",
      candidate_count: 1,
    });
    // Idempotent on the session, so a lost-CAS retry cannot double-count a placement in the
    // layer histogram the launch gate is scored on.
    expect(
      ((events.emit.mock.calls as unknown[][])[0]?.[0] as { idempotencyKey: string })
        .idempotencyKey,
    ).toBe(`profile.occupation_identified:${SESSION}`);
  });

  it("NEVER carries the worker's utterance into the event", async () => {
    const { svc, events } = make(auto);
    await svc.identify(env(), "main Ramesh hoon aur silai karta hoon", CTX);
    const serialized = JSON.stringify(emitted(events)[0]?.payload);
    expect(serialized).not.toContain("Ramesh");
    expect(serialized).not.toContain("silai");
  });

  it("an `auto` with no pinned candidate is a contradiction — treated as keep-asking", async () => {
    const { svc } = make({ resolve: resolveResult({ status: "auto", pinned: null }) });
    const result = await svc.identify(env(), "silai", CTX);
    expect(result.patch).toEqual({});
    expect(result.pinned).toBeNull();
  });
});

describe("the disambiguation offer", () => {
  const two = [
    { jobDomainId: "jd_a", familyId: "fam_a", label: "welder" },
    { jobDomainId: "jd_b", familyId: "fam_b", label: "fitter" },
  ];
  const offering = {
    resolve: resolveResult({ status: "disambiguate", disambiguationOptions: two }),
  };

  it("serves the chips, stores the server-side map, and asks nothing else this turn", async () => {
    const { svc } = make(offering);
    const result = await svc.identify(env(), "mistri", CTX);
    expect(result.offer?.prompt).toBe(DISAMBIGUATION_PROMPT);
    expect(result.patch.needsDisambiguation).toBe(true);
    expect(result.patch.phase).toBe("disambiguate");
    // The MAP, not just the labels: this is what a tap resolves through.
    expect(result.patch.disambiguationOffer).toEqual([
      { label: "welder", jobDomainId: "jd_a", familyId: "fam_a" },
      { label: "fitter", jobDomainId: "jd_b", familyId: "fam_b" },
      { label: "Kuch aur", jobDomainId: null, familyId: null },
    ]);
  });

  it("appends the escape chip, and marks it none-of-above for the client", async () => {
    const { svc } = make(offering);
    const result = await svc.identify(env(), "mistri", CTX);
    const escape = result.offer?.options.at(-1);
    expect(escape?.is_none_of_above).toBe(true);
    expect(escape?.option_key).toBe("kuch_aur");
    // WITHOUT IT THE OFFER IS A TRAP: four chips and no way out forces a worker whose trade is
    // not listed to tap one anyway, and the label becomes their answer of record verbatim.
    expect(result.offer?.options.filter((o) => o.is_none_of_above)).toHaveLength(1);
  });

  it("refuses to offer fewer than two real choices — that is not a question", async () => {
    const { svc, events } = make({
      resolve: resolveResult({ status: "disambiguate", disambiguationOptions: [two[0]] }),
    });
    const result = await svc.identify(env(), "mistri", CTX);
    expect(result.offer).toBeNull();
    expect(result.patch.identifyAttempts).toBe(MAX_IDENTIFY_ATTEMPTS);
    expect(emitted(events)[0]?.payload).toMatchObject({ reason: "ambiguous" });
  });
});

describe("settling an outstanding offer", () => {
  const outstanding = env({
    needsDisambiguation: true,
    disambiguationOffer: [
      { label: "darzi", jobDomainId: CANDIDATE.jobDomainId, familyId: "fam_tailoring" },
      { label: "Kuch aur", jobDomainId: null, familyId: null },
    ],
  });

  it("a tap resolves through the STORED MAP, never by re-running retrieval", async () => {
    const { svc, occupation } = make();
    const result = await svc.identify(outstanding, "darzi", CTX);
    expect(occupation.resolve).not.toHaveBeenCalled();
    expect(result.patch.occupation).toMatchObject({
      job_domain_id: CANDIDATE.jobDomainId,
      // THE HIGHEST-QUALITY SIGNAL IN THE SYSTEM gets its own status — not our inference about
      // their words, their explicit selection from a reviewed closed set.
      match_status: "matched_worker_confirmed",
      match_score: 1,
    });
    expect(result.patch.needsDisambiguation).toBe(false);
    expect(result.patch.disambiguationOffer).toEqual([]);
  });

  it("matches the tap after normalization, so punctuation and case cannot miss", async () => {
    const { svc } = make();
    const result = await svc.identify(outstanding, "  Darzi  ", CTX);
    expect(result.pinned).not.toBeNull();
  });

  it("the escape records an ambiguous miss and stops offering", async () => {
    const { svc, events } = make();
    const result = await svc.identify(outstanding, "Kuch aur", CTX);
    expect(result.patch.occupation).toBeUndefined();
    expect(result.patch.identifyAttempts).toBe(MAX_IDENTIFY_ATTEMPTS);
    expect(emitted(events)[0]).toMatchObject({
      event_name: "profile.occupation_unresolved",
      payload: { reason: "ambiguous" },
    });
  });

  it("free text instead of a tap clears the chips and lets the next turn try again", async () => {
    const { svc } = make();
    const result = await svc.identify(outstanding, "nahi, main welding karta hoon", CTX);
    expect(result.patch).toEqual({ needsDisambiguation: false, disambiguationOffer: [] });
    expect(result.offer).toBeNull();
  });

  it("a chip whose domain the snapshot no longer describes falls back, never pins", async () => {
    const { svc } = make({ describe: null });
    const result = await svc.identify(outstanding, "darzi", CTX);
    expect(result.patch.occupation).toBeUndefined();
    expect(result.patch.identifyAttempts).toBe(MAX_IDENTIFY_ATTEMPTS);
  });
});

describe("giving up, and the growth queue", () => {
  it("the FIRST miss records nothing — the opening line is usually a greeting", async () => {
    const { svc, occupation, ai, events } = make();
    const result = await svc.identify(env(), "namaste", CTX);
    expect(result.patch.identifyAttempts).toBe(1);
    expect(ai.pseudonymize).not.toHaveBeenCalled();
    expect(occupation.recordUnresolved).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("the LAST miss queues the phrase, PSEUDONYMIZED FIRST", async () => {
    const { svc, occupation, ai } = make();
    await svc.identify(env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS - 1 }), "kharad ka kaam", CTX);
    // BL-19: the TURN'S OWN ids ride along, so the gateway hop lands in the same trace as the
    // request that provoked it instead of one `AiService.post` minted for itself.
    expect(ai.pseudonymize).toHaveBeenCalledWith("kharad ka kaam", {
      correlationId: "33333333-3333-4333-8333-333333333333",
      requestId: "req-1",
    });
    // The MASKED text, never the raw utterance — `unresolved_phrase`'s contract is
    // pseudonymized-only (SG-1).
    expect(occupation.recordUnresolved).toHaveBeenCalledWith("kharad ka kaam", "hi");
  });

  it("a BLOCKED pseudonymization drops the queue entry and never fails the turn", async () => {
    const { svc, occupation } = make({ pseudonymize: { pseudonymized_text: "", blocked: true } });
    const result = await svc.identify(
      env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS - 1 }),
      "mera number 9876543210 hai",
      CTX,
    );
    expect(occupation.recordUnresolved).not.toHaveBeenCalled();
    expect(result.patch.identifyAttempts).toBe(MAX_IDENTIFY_ATTEMPTS);
  });

  it("an unreachable pseudonymizer costs a queue entry, not an interview", async () => {
    const { svc, occupation } = make({ pseudonymize: null });
    const result = await svc.identify(
      env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS - 1 }),
      "kharad",
      CTX,
    );
    expect(occupation.recordUnresolved).not.toHaveBeenCalled();
    expect(result.patch.identifyAttempts).toBe(MAX_IDENTIFY_ATTEMPTS);
  });

  it("a DEGRADED ladder is an incident, not a catalogue gap — nothing is queued", async () => {
    // Feeding a down index into the growth queue would fill an ops backlog with phrases that
    // were never actually missing.
    const { svc, occupation, ai, events } = make({
      resolve: resolveResult({ status: "degraded" }),
    });
    await svc.identify(env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS - 1 }), "silai", CTX);
    expect(ai.pseudonymize).not.toHaveBeenCalled();
    expect(occupation.recordUnresolved).not.toHaveBeenCalled();
    expect(emitted(events)[0]?.payload).toMatchObject({ reason: "degraded" });
  });

  it("records the best score and deepest layer so a floor can be re-tuned against real misses", async () => {
    const { svc, events } = make({
      resolve: resolveResult({
        candidates: [{ ...CANDIDATE, confidence: 0.41, layer: "L2" }],
      }),
    });
    await svc.identify(env({ identifyAttempts: MAX_IDENTIFY_ATTEMPTS - 1 }), "kharad", CTX);
    expect(emitted(events)[0]?.payload).toMatchObject({
      reason: "below_floor",
      best_score: 0.41,
      deepest_layer: "l2_trigram",
    });
  });
});
