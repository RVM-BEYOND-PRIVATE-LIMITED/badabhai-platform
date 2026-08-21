/**
 * The shadow reducer.
 *
 * The property worth guarding is that it MEASURES and does not JUDGE. There is no pass/fail in
 * the return type and no way to pass a threshold in, because a tool that does both invites
 * someone to tune the judgement until the measurement passes — which is exactly what the plan's
 * own note warns against.
 */
import { describe, expect, it } from "vitest";

import { UNMEASURABLE_OFFLINE, percentile, summarizeShadow, type ShadowCase } from "./s3d-shadow-report";
import { poolComposition, statusesFor } from "./s3d-shadow-inputs";
import { PRE_PROMOTION_STATUSES, RETRIEVABLE_SKILL_STATUSES, type CorpusInput } from "./path-a-replay";
import type { SkillStatus } from "@badabhai/taxonomy";

const c = (
  caseId: string,
  aTop1: string | null,
  bTop1: string | null,
  aScore: number | null = 0.9,
  bScore: number | null = 0.8,
): ShadowCase => ({ caseId, jobDomainId: "jd1", aTop1, bTop1, aScore, bScore });

describe("signal 1 — empty-rate", () => {
  it("counts each path's empties independently", () => {
    const r = summarizeShadow([c("1", null, "s"), c("2", "s", null), c("3", "s", "s")]);
    expect(r.aEmpty).toBe(1);
    expect(r.bEmpty).toBe(1);
  });

  it("reports the delta as A minus B, so positive means Path A is worse", () => {
    // Sign convention matters: the plan aborts when A EXCEEDS B, so a reader must not have to
    // work out which way round the subtraction went.
    const r = summarizeShadow([c("1", null, "s"), c("2", null, "s"), c("3", "s", "s"), c("4", "s", "s")]);
    expect(r.emptyRateDelta).toBeCloseTo(0.5, 10);
  });

  it("is negative when Path B is the emptier one", () => {
    expect(summarizeShadow([c("1", "s", null)]).emptyRateDelta).toBeLessThan(0);
  });

  it("does not divide by zero on an empty case set", () => {
    expect(summarizeShadow([]).emptyRateDelta).toBe(0);
  });
});

describe("signal 2 — top-1 agreement", () => {
  it("only compares cases where BOTH paths resolved", () => {
    // Counting a one-sided empty as a "disagreement" would double-count signal 1 inside
    // signal 2, and the two abort on different things.
    const r = summarizeShadow([c("1", "x", null), c("2", null, "y"), c("3", "x", "x")]);
    expect(r.bothResolved).toBe(1);
    expect(r.agreeTop1).toBe(1);
    expect(r.disagreeTop1).toBe(0);
  });

  it("enumerates every disagreement, not just a count", () => {
    // The plan aborts on "ANY disagreement unclassified", which is unanswerable against a
    // number. The list is the deliverable.
    const r = summarizeShadow([c("1", "x", "y"), c("2", "p", "q")]);
    expect(r.disagreements.map((d) => d.caseId)).toEqual(["1", "2"]);
    expect(r.disagreements[0]).toMatchObject({ a: "x", b: "y" });
  });

  it("carries the score delta on each disagreement", () => {
    expect(summarizeShadow([c("1", "x", "y", 0.9, 0.5)]).disagreements[0]?.scoreDelta).toBeCloseTo(0.4, 6);
  });

  it("reports agreementRate as 0 rather than NaN when nothing resolved on both sides", () => {
    expect(summarizeShadow([c("1", null, null)]).agreementRate).toBe(0);
  });
});

describe("signal 3 — score delta distribution", () => {
  it("reports min / p50 / p95 / max over paired scores", () => {
    const cases = [0.1, 0.2, 0.3, 0.4, 0.5].map((d, i) => c(String(i), "x", "x", 0.5 + d, 0.5));
    const r = summarizeShadow(cases);
    expect(r.scoreDelta?.min).toBeCloseTo(0.1, 6);
    expect(r.scoreDelta?.max).toBeCloseTo(0.5, 6);
  });

  it("is null when no case has both scores", () => {
    expect(summarizeShadow([c("1", "x", "y", null, null)]).scoreDelta).toBeNull();
  });

  it("percentile is nearest-rank and clamps at both ends", () => {
    const s = [1, 2, 3, 4];
    expect(percentile(s, 0)).toBe(1);
    expect(percentile(s, 50)).toBe(2);
    expect(percentile(s, 100)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("it measures, it does not judge", () => {
  it("returns no pass/fail field of any kind", () => {
    const r = summarizeShadow([c("1", "x", "y")]) as unknown as Record<string, unknown>;
    for (const k of ["pass", "failed", "ok", "aborted", "threshold", "verdict"]) {
      expect(Object.keys(r)).not.toContain(k);
    }
  });

  it("names the signals it structurally cannot produce", () => {
    // Silence about a missing signal reads as "measured and fine". Each one says what it
    // would take to get it.
    const signals = UNMEASURABLE_OFFLINE.map((u) => u.signal);
    expect(signals).toContain("latency p95");
    expect(signals).toContain("unresolved_phrase volume");
    for (const u of UNMEASURABLE_OFFLINE) {
      expect(u.why.length, u.signal).toBeGreaterThan(10);
      expect(u.needs.length, u.signal).toBeGreaterThan(10);
    }
  });
});

describe("poolComposition — the report must diagnose, not guess", () => {
  const skill = (skillId: string, status: SkillStatus) => ({
    skillId,
    status,
    replacedBy: null,
    preMergeStatus: status,
  });
  const alias = (skillId: string, text: string, vector: number[] | null) => ({
    skillId,
    text,
    lang: "en" as const,
    domainId: "d1",
    vector,
  });

  function input(over: Partial<CorpusInput> = {}): CorpusInput {
    return {
      skills: [],
      aliases: [],
      edges: [],
      ...over,
    } as CorpusInput;
  }

  it("counts skills by status and alias-vector coverage within each", () => {
    const c = poolComposition(
      input({
        skills: [skill("a", "active"), skill("p1", "provisional"), skill("p2", "provisional")],
        aliases: [
          alias("a", "welder", [1]),
          alias("a", "welding", null),
          alias("p1", "grinder", null),
          alias("p2", "borer", null),
        ],
      }),
    );

    expect(c.skillsByStatus).toEqual({ active: 1, provisional: 2 });
    expect(c.aliasVectors["active"]).toEqual({ embedded: 1, total: 2 });
    expect(c.aliasVectors["provisional"]).toEqual({ embedded: 0, total: 2 });
  });

  it("counts as promotable ONLY a provisional skill that could actually be ranked", () => {
    // THE NUMBER THIS WHOLE FUNCTION EXISTS FOR. The report used to assert that Path A is empty
    // because skills are provisional, and therefore that promotion would fix it. A skill needs
    // BOTH a retrievable status and an embedded alias; promotion moves only the first. On the
    // real corpus this is 1 out of 111, which is why --if-promoted changes nothing.
    const c = poolComposition(
      input({
        skills: [skill("p1", "provisional"), skill("p2", "provisional"), skill("p3", "provisional")],
        aliases: [alias("p1", "has one", [1]), alias("p2", "none", null), alias("p3", "none either", null)],
      }),
    );

    expect(c.promotionWouldAdd).toBe(1);
  });

  it("does not count a provisional skill twice when several of its aliases are embedded", () => {
    const c = poolComposition(
      input({
        skills: [skill("p1", "provisional")],
        aliases: [alias("p1", "one", [1]), alias("p1", "two", [1]), alias("p1", "three", [1])],
      }),
    );

    expect(c.promotionWouldAdd).toBe(1);
  });

  it("counts no active skill as promotable — promotion is provisional -> active", () => {
    const c = poolComposition(
      input({ skills: [skill("a", "active")], aliases: [alias("a", "embedded", [1])] }),
    );

    expect(c.promotionWouldAdd).toBe(0);
  });
});

describe("statusesFor — the counterfactual widens exactly one thing", () => {
  it("is active-only for production, and never mutates the shared constant", () => {
    expect([...statusesFor("production")]).toEqual(["active"]);
    expect([...RETRIEVABLE_SKILL_STATUSES]).toEqual(["active"]);
  });

  it("adds provisional — and nothing else — for the counterfactual", () => {
    // Reusing PRE_PROMOTION_STATUSES rather than building a second list is what keeps this in
    // step with `db:replay:path-a --include-provisional`; if they drifted, two tools would
    // answer the same question differently.
    expect([...statusesFor("if_promoted")].sort()).toEqual(["active", "provisional"]);
    expect(statusesFor("if_promoted")).toBe(PRE_PROMOTION_STATUSES);
  });

  it("never admits deprecated — a retired skill must not come back through a counterfactual", () => {
    expect([...statusesFor("if_promoted")]).not.toContain("deprecated");
  });
});
