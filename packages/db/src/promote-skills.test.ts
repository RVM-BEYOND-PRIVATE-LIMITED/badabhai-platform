/**
 * The promotion POLICY, tested without a database.
 *
 * Promotion is the single operation that makes a skill publishable — since Phase 7 Gate A,
 * `skill.status = 'active'` is what `SkillsRepository.canonicalAliasRows` filters on. So the
 * interesting assertions here are all about REFUSING: refusing to promote something
 * unmeasured, unembedded, unreachable or already retired, refusing to promote a batch
 * partially, and refusing to overwrite the evidence of a previous run.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  blockingHistogram,
  CRITERIA,
  isCriterion,
  judge,
  reportPath,
  writeReport,
  type CandidateFacts,
  type Criterion,
  type PromotionReport,
} from "./promote-skills";

/** A candidate that passes everything. Each test breaks exactly one thing. */
const ok = (o: Partial<CandidateFacts> = {}): CandidateFacts => ({
  skill_id: "skill_x",
  status: "provisional",
  in_accepted_batch: true,
  active_edges: 2,
  aliases: 2,
  unembedded_aliases: 0,
  embedding_models: ["gemini-embedding-001"],
  eval_covered: true,
  ...o,
});

const blocked = (f: CandidateFacts, waived?: Criterion[]): Criterion[] =>
  judge(f, new Set(waived ?? [])).blocking;

describe("the criteria set", () => {
  it("is closed", () => {
    expect(isCriterion("EVAL_COVERED")).toBe(true);
    expect(isCriterion("LOOKS_FINE")).toBe(false);
    expect(CRITERIA).toHaveLength(5);
  });

  it("judges EVERY criterion on every candidate, pass or fail", () => {
    // A bare eligible:true/false hides which rule did the work, and at review time the
    // binding rule is the only interesting part.
    const v = judge(ok());
    expect(v.criteria.map((c) => c.criterion).sort()).toEqual([...CRITERIA].sort());
    expect(v.criteria.every((c) => c.detail.length > 0)).toBe(true);
  });
});

describe("judge — a fully-qualified candidate", () => {
  it("is eligible", () => {
    const v = judge(ok());
    expect(v.eligible).toBe(true);
    expect(v.blocking).toEqual([]);
  });
});

describe("judge — IS_PROVISIONAL", () => {
  it("refuses a skill that is already active (a silent no-op otherwise)", () => {
    expect(blocked(ok({ status: "active" }))).toContain("IS_PROVISIONAL");
  });

  it("refuses to RESURRECT a deprecated skill", () => {
    // A human retired this. Promotion must never be the thing that undoes that, and
    // "deprecated" must not be quietly skipped as if it were absent.
    expect(blocked(ok({ status: "deprecated" }))).toContain("IS_PROVISIONAL");
  });

  it("refuses a skill id with no row at all", () => {
    const v = judge(ok({ status: null }));
    expect(v.blocking).toContain("IS_PROVISIONAL");
    expect(v.criteria.find((c) => c.criterion === "IS_PROVISIONAL")?.detail).toMatch(/not found/);
  });
});

describe("judge — ACTIVE_EDGE", () => {
  it("refuses a skill with no active edge — it would be unreachable anyway", () => {
    // Retrieval scopes through job_domain_skill. Promoting an unwired skill changes nothing
    // except making the audit trail claim something is live when it cannot be returned.
    expect(blocked(ok({ active_edges: 0 }))).toContain("ACTIVE_EDGE");
  });

  it("accepts a single edge", () => {
    expect(blocked(ok({ active_edges: 1 }))).toEqual([]);
  });
});

describe("judge — FULLY_EMBEDDED", () => {
  it("refuses a partially embedded skill, and says how many are missing", () => {
    // Live and findable only through whichever aliases happen to have vectors is the worst
    // of both worlds — it looks healthy and silently under-retrieves.
    const v = judge(ok({ aliases: 3, unembedded_aliases: 1 }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toBe(
      "1 of 3 aliases unembedded",
    );
  });

  it("refuses a skill embedded with the MOCK sentinel", () => {
    const v = judge(ok({ embedding_models: ["mock-embedding"] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toMatch(/sentinel/);
  });

  it("refuses a skill whose aliases span TWO models", () => {
    // Every vector is real and the space is still incoherent — distances across two models
    // are not comparable, which a null-check cannot see.
    const v = judge(ok({ embedding_models: ["gemini-embedding-001", "text-embedding-3"] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toMatch(/span 2 models/);
  });

  it("refuses a skill with no aliases at all", () => {
    // 0 unembedded of 0 aliases is vacuously "complete"; it is also unretrievable.
    const v = judge(ok({ aliases: 0, unembedded_aliases: 0, embedding_models: [] }));
    expect(v.blocking).toContain("FULLY_EMBEDDED");
    expect(v.criteria.find((c) => c.criterion === "FULLY_EMBEDDED")?.detail).toBe("no aliases at all");
  });
});

describe("judge — EVAL_COVERED", () => {
  it("refuses a skill no evaluation case has ever exercised", () => {
    // The strict rule: promote only what has been measured. On the current corpus it admits
    // 61 of 98, which is exactly why it is named and waivable rather than silently assumed
    // in either direction.
    expect(blocked(ok({ eval_covered: false }))).toContain("EVAL_COVERED");
  });

  it("can be WAIVED, and the waiver is recorded on the criterion", () => {
    const v = judge(ok({ eval_covered: false }), new Set<Criterion>(["EVAL_COVERED"]));
    expect(v.eligible).toBe(true);
    expect(v.blocking).toEqual([]);
    const c = v.criteria.find((x) => x.criterion === "EVAL_COVERED");
    expect(c?.passed).toBe(false); // still FAILED...
    expect(c?.waived).toBe(true); // ...and the report says it was waived, not that it passed
  });

  it("a waiver does not excuse the OTHER criteria", () => {
    const v = judge(ok({ eval_covered: false, active_edges: 0 }), new Set<Criterion>(["EVAL_COVERED"]));
    expect(v.eligible).toBe(false);
    expect(v.blocking).toEqual(["ACTIVE_EDGE"]);
  });
});

describe("judge — GATE_ACCEPTED", () => {
  it("refuses a skill that is not in an accepted batch", () => {
    expect(blocked(ok({ in_accepted_batch: false }))).toContain("GATE_ACCEPTED");
  });
});

describe("judge — several failures at once", () => {
  it("names every blocking criterion, not just the first", () => {
    // An operator fixing one blocker at a time from a report that shows one blocker at a
    // time will run this five times.
    const v = judge(ok({ status: "active", active_edges: 0, eval_covered: false, unembedded_aliases: 1 }));
    expect(v.blocking.sort()).toEqual(
      ["ACTIVE_EDGE", "EVAL_COVERED", "FULLY_EMBEDDED", "IS_PROVISIONAL"].sort(),
    );
  });
});

describe("blockingHistogram", () => {
  it("tallies which criterion held back how many candidates", () => {
    const vs = [
      judge(ok({ eval_covered: false })),
      judge(ok({ eval_covered: false })),
      judge(ok({ active_edges: 0 })),
      judge(ok()),
    ];
    expect(blockingHistogram(vs)).toEqual({ ACTIVE_EDGE: 1, EVAL_COVERED: 2 });
  });

  it("is empty when everything is eligible", () => {
    expect(blockingHistogram([judge(ok()), judge(ok())])).toEqual({});
  });
});

describe("the audit report", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promo-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const report = (o: Partial<PromotionReport> = {}): PromotionReport => ({
    script: "promote:skills",
    mode: "APPLY",
    generated_at: "2026-08-17T00:00:00.000Z",
    batch_dir: "batch_x",
    fixture: "retrieval-v2.jsonl",
    waived: [],
    candidates: 1,
    eligible: 1,
    blocked: 0,
    promoted: ["skill_x"],
    skipped_concurrent: [],
    verdicts: [judge(ok())],
    notes: [],
    ...o,
  });

  it("writes a readable record", () => {
    const p = writeReport(report(), join(dir, "r.json"));
    const back = JSON.parse(readFileSync(p, "utf8")) as PromotionReport;
    expect(back.promoted).toEqual(["skill_x"]);
    expect(back.verdicts[0]?.criteria).toHaveLength(5);
  });

  it("REFUSES to overwrite — a promotion report is evidence, not a scratch file", () => {
    const p = join(dir, "r.json");
    writeReport(report(), p);
    expect(() => writeReport(report({ promoted: ["other"] }), p)).toThrow(/immutable evidence/);
  });

  it("makes an ISO stamp filesystem-safe", () => {
    expect(reportPath("2026-08-17T05:41:39.559Z", dir)).toBe(
      join(dir, "promotion-2026-08-17T05_41_39.559Z.json"),
    );
  });

  it("records enough to REVERT: the ids that actually moved", () => {
    // Reversibility rests entirely on this list, and it is the APPLIED set, not the eligible
    // set — a row the concurrency guard skipped was never promoted and must not be reverted.
    const r = report({ eligible: 2, promoted: ["a"], skipped_concurrent: ["b"] });
    const p = writeReport(r, join(dir, "r.json"));
    const back = JSON.parse(readFileSync(p, "utf8")) as PromotionReport;
    expect(back.promoted).toEqual(["a"]);
    expect(back.skipped_concurrent).toEqual(["b"]);
  });

  it("a PLAN report records that nothing moved", () => {
    const r = report({ mode: "PLAN", promoted: [] });
    const back = JSON.parse(readFileSync(writeReport(r, join(dir, "p.json")), "utf8")) as PromotionReport;
    expect(back.mode).toBe("PLAN");
    expect(back.promoted).toEqual([]);
  });

  it("carries the waiver list, so a waived promotion is never indistinguishable from a clean one", () => {
    const r = report({ waived: ["EVAL_COVERED"] });
    const back = JSON.parse(readFileSync(writeReport(r, join(dir, "w.json")), "utf8")) as PromotionReport;
    expect(back.waived).toEqual(["EVAL_COVERED"]);
  });
});

describe("the CURRENT corpus, judged", () => {
  it("blocks the 37 skills the fixture never exercises", () => {
    // A regression guard on the policy against real numbers: 98 candidates, 61 covered.
    // If someone loosens EVAL_COVERED, this is what changes.
    const covered = 61;
    const total = 98;
    const vs = [
      ...Array.from({ length: covered }, (_, i) => judge(ok({ skill_id: `c${i}` }))),
      ...Array.from({ length: total - covered }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }))),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(61);
    expect(blockingHistogram(vs)).toEqual({ EVAL_COVERED: 37 });
  });

  it("admits all 98 only when EVAL_COVERED is explicitly waived", () => {
    const w = new Set<Criterion>(["EVAL_COVERED"]);
    const vs = [
      ...Array.from({ length: 61 }, (_, i) => judge(ok({ skill_id: `c${i}` }), w)),
      ...Array.from({ length: 37 }, (_, i) => judge(ok({ skill_id: `u${i}`, eval_covered: false }), w)),
    ];
    expect(vs.filter((v) => v.eligible)).toHaveLength(98);
  });
});
