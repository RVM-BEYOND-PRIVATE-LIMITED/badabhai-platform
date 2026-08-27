import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANONICALIZATION_FLOOR,
  judge,
  type CandidateFacts,
  type Verdict,
} from "./promote-skills";
import {
  DEFAULT_HOLD_REGISTER,
  holdTripwireError,
  loadHoldRegister,
  reconcileHolds,
  type HoldRegister,
} from "./promotion-holds";

/** A candidate that passes everything. Mirrors the fixture in `promote-skills.test.ts`. */
const ok = (o: Partial<CandidateFacts> = {}): CandidateFacts => ({
  skill_id: "skill_x",
  status: "provisional",
  in_accepted_batch: true,
  active_edges: 1,
  aliases: 3,
  unembedded_aliases: 0,
  embedding_models: ["gemini-embedding-001"],
  eval_covered: true,
  best_correct_score: 0.9,
  no_regression: true,
  regression_detail: "ok",
  evidence_stale: false,
  reachable_aliases: 3,
  ...o,
});

const belowFloor = (id: string): Verdict =>
  judge(ok({ skill_id: id, best_correct_score: CANONICALIZATION_FLOOR - 0.05 }));

const register = (holds: HoldRegister["holds"]): HoldRegister => ({
  kind: "promotion-holds",
  why: "test",
  ruling: "test ruling",
  recorded_at: "2026-08-27",
  measured_from: {},
  improvement_queue: "test",
  holds,
});

const hold = (skill_id: string, criterion: HoldRegister["holds"][number]["criterion"]) => ({
  skill_id,
  criterion,
  category: "CORRECT_BUT_BELOW_FLOOR",
  best_correct_score: 0.7,
  gap_to_floor: 0.05,
  detail: "below floor",
});

// ===========================================================================
describe("a hold is a SELECTION, not a waiver", () => {
  it("removes the skill from the batch WITHOUT changing its verdict", () => {
    // The distinction the whole design rests on. `skill_b` still FAILS — it is simply not in
    // the set being promoted. If holding ever made a verdict pass, this is a waiver wearing a
    // different name.
    const verdicts = [judge(ok({ skill_id: "skill_a" })), belowFloor("skill_b")];
    const rec = reconcileHolds(verdicts, register([hold("skill_b", "RESOLVABLE_ABOVE_FLOOR")]));

    expect(rec.selected.map((v) => v.skill_id)).toEqual(["skill_a"]);
    expect(rec.held.map((v) => v.skill_id)).toEqual(["skill_b"]);
    const b = rec.held[0]!;
    expect(b.eligible).toBe(false);
    expect(b.blocking).toEqual(["RESOLVABLE_ABOVE_FLOOR"]);
    expect(b.criteria).toHaveLength(7);
    expect(b.criteria.every((c) => !c.waived)).toBe(true);
  });

  it("leaves the fail-closed rule intact INSIDE the selected set", () => {
    // Holding one below-floor skill does not license promoting another. The selected set still
    // contains a failure, so a caller applying the unchanged `blocked.length > 0` rule refuses.
    const verdicts = [belowFloor("skill_held"), belowFloor("skill_not_held")];
    const rec = reconcileHolds(verdicts, register([hold("skill_held", "RESOLVABLE_ABOVE_FLOOR")]));
    expect(rec.selected.filter((v) => !v.eligible).map((v) => v.skill_id)).toEqual(["skill_not_held"]);
  });

  it("partitions every candidate exactly once", () => {
    const verdicts = ["a", "b", "c", "d"].map((id) => judge(ok({ skill_id: id })));
    const rec = reconcileHolds(verdicts, register([hold("b", "RESOLVABLE_ABOVE_FLOOR")]));
    expect(rec.held.length + rec.selected.length).toBe(verdicts.length);
    expect(new Set([...rec.held, ...rec.selected].map((v) => v.skill_id)).size).toBe(4);
  });
});

// ===========================================================================
describe("property 1 — a hold authorises EXACTLY ONE criterion", () => {
  it("does NOT cover a second, unrelated failure", () => {
    // THE CASE THIS EXISTS TO CATCH. A skill held for a below-floor score later loses its
    // embeddings. Nobody authorised promoting-or-hiding a corpus-integrity defect, and a hold
    // list that quietly absorbed it would be exactly the silencer this design refuses to be.
    const broken = judge(
      ok({ skill_id: "skill_b", best_correct_score: 0.7, unembedded_aliases: 2 }),
    );
    expect(broken.blocking).toEqual(["FULLY_EMBEDDED", "RESOLVABLE_ABOVE_FLOOR"]);

    const rec = reconcileHolds([broken], register([hold("skill_b", "RESOLVABLE_ABOVE_FLOOR")]));
    expect(rec.unauthorised.map((d) => d.skill_id)).toEqual(["skill_b"]);
    expect(rec.unauthorised[0]?.actually_blocking).toEqual([
      "FULLY_EMBEDDED",
      "RESOLVABLE_ABOVE_FLOOR",
    ]);
    expect(holdTripwireError(rec, "promote:skills", "r.json")).toMatch(/UNAUTHORISED \(1\)/);
  });

  it("a hold for the WRONG criterion covers nothing", () => {
    const rec = reconcileHolds([belowFloor("skill_b")], register([hold("skill_b", "EVAL_COVERED")]));
    expect(rec.unauthorised).toHaveLength(1);
    expect(rec.unauthorised[0]?.authorised).toBe("EVAL_COVERED");
  });

  it("the tripwire naming an unauthorised hold is NOT WAIVABLE, and says so", () => {
    const rec = reconcileHolds(
      [judge(ok({ skill_id: "skill_b", best_correct_score: 0.7, active_edges: 0 }))],
      register([hold("skill_b", "RESOLVABLE_ABOVE_FLOOR")]),
    );
    expect(holdTripwireError(rec, "promote:skills", "r.json")).toMatch(/NOT WAIVABLE/);
  });
});

// ===========================================================================
describe("property 2 — a hold must still be TRUE", () => {
  it("a held skill that now passes everything is RELEASABLE, not silently held", () => {
    // The stale-register case, and the reason it must be loud: the ruling authorised a MEASURED
    // 62/34 split. A skill whose corpus work has landed is no longer on the side the owner put
    // it, so the authorisation stops describing the batch until someone re-records it.
    const rec = reconcileHolds(
      [judge(ok({ skill_id: "skill_fixed" }))],
      register([hold("skill_fixed", "RESOLVABLE_ABOVE_FLOOR")]),
    );
    expect(rec.releasable.map((d) => d.skill_id)).toEqual(["skill_fixed"]);
    expect(rec.selected).toHaveLength(0);
    expect(holdTripwireError(rec, "promote:skills", "r.json")).toMatch(/RELEASABLE \(1\)/);
  });

  it("deleting the entry is the way OUT of the queue, and it works", () => {
    const fixed = judge(ok({ skill_id: "skill_fixed" }));
    const rec = reconcileHolds([fixed], register([]));
    expect(rec.selected.map((v) => v.skill_id)).toEqual(["skill_fixed"]);
    expect(holdTripwireError(rec, "promote:skills", "r.json")).toBeNull();
  });
});

// ===========================================================================
describe("property 3 — omission is self-correcting", () => {
  it("a MISTYPED id does not promote the skill it meant to hold", () => {
    // The reassuring half of the design. A typo cannot cause an over-promotion: the real skill
    // stays selected, fails there, and the unchanged fail-closed rule refuses the whole run.
    const rec = reconcileHolds(
      [belowFloor("skill_thermostat_and_control_wiring")],
      register([hold("skill_thermostat_and_control_wirring", "RESOLVABLE_ABOVE_FLOOR")]),
    );
    expect(rec.selected.map((v) => v.skill_id)).toEqual(["skill_thermostat_and_control_wiring"]);
    expect(rec.selected[0]?.eligible).toBe(false);
    expect(rec.unknown).toEqual(["skill_thermostat_and_control_wirring"]);
  });

  it("an unmatched hold id is INFORMATIONAL, not a refusal — a register may span batches", () => {
    const rec = reconcileHolds(
      [judge(ok({ skill_id: "skill_a" }))],
      register([hold("skill_from_another_batch", "RESOLVABLE_ABOVE_FLOOR")]),
    );
    expect(rec.unknown).toEqual(["skill_from_another_batch"]);
    expect(holdTripwireError(rec, "promote:skills", "r.json")).toBeNull();
  });
});

// ===========================================================================
describe("loadHoldRegister — a malformed exclusion list must not degrade", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "holds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (o: unknown): string => {
    const p = join(dir, "r.json");
    writeFileSync(p, JSON.stringify(o), "utf8");
    return p;
  };

  it("a MISSING file throws — it is not the same claim as an empty register", () => {
    expect(() => loadHoldRegister(join(dir, "nope.json"))).toThrow(/does not exist/);
  });

  it("an EMPTY register is legal, and states explicitly that nothing is held", () => {
    expect(loadHoldRegister(write(register([]))).holds).toEqual([]);
  });

  it("refuses a register with no ruling — an unattributed exclusion list is an unsigned waiver", () => {
    expect(() => loadHoldRegister(write({ ...register([]), ruling: "  " }))).toThrow(/"ruling" is required/);
  });

  it("refuses the wrong kind", () => {
    expect(() => loadHoldRegister(write({ ...register([]), kind: "alias-exclusions" }))).toThrow(/kind must be/);
  });

  it("refuses a criterion that is not a criterion", () => {
    expect(() =>
      loadHoldRegister(write(register([{ ...hold("a", "EVAL_COVERED"), criterion: "BELOW_FLOOR" as never }]))),
    ).toThrow(/is not a promotion criterion/);
  });

  it("refuses the SAME skill held twice — two entries are a broader permission than either", () => {
    expect(() =>
      loadHoldRegister(
        write(register([hold("a", "RESOLVABLE_ABOVE_FLOOR"), hold("a", "EVAL_COVERED")])),
      ),
    ).toThrow(/held twice — ambiguous authorisation/);
  });
});

// ===========================================================================
describe("the SHIPPED register — owner ruling PROMOTION-SCOPE option B, 2026-08-27", () => {
  const shipped = loadHoldRegister(DEFAULT_HOLD_REGISTER);

  it("holds exactly 34 skills, every one for RESOLVABLE_ABOVE_FLOOR and nothing else", () => {
    // The ruling authorised a specific split. If a future edit holds a skill for a different
    // criterion, that is a new authorisation and this fails until someone records it.
    expect(shipped.holds).toHaveLength(34);
    expect([...new Set(shipped.holds.map((h) => h.criterion))]).toEqual(["RESOLVABLE_ABOVE_FLOOR"]);
  });

  it("splits 30 measured-below-floor and 4 never-measured, matching the improvement queue", () => {
    const byCategory = shipped.holds.reduce<Record<string, number>>((acc, h) => {
      acc[h.category] = (acc[h.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCategory).toEqual({ CORRECT_BUT_BELOW_FLOOR: 30, NO_CORRECT_CASE_IN_SWEEP: 4 });
  });

  it("EVERY held score is genuinely below the floor — no skill is held that could be promoted", () => {
    // The register is only legitimate if it records measurements rather than preferences.
    for (const h of shipped.holds) {
      if (h.category === "NO_CORRECT_CASE_IN_SWEEP") {
        expect(h.best_correct_score, h.skill_id).toBeNull();
        continue;
      }
      expect(h.best_correct_score, h.skill_id).not.toBeNull();
      expect(h.best_correct_score!, h.skill_id).toBeLessThan(CANONICALIZATION_FLOOR);
      expect(h.gap_to_floor!, h.skill_id).toBeCloseTo(CANONICALIZATION_FLOOR - h.best_correct_score!, 4);
    }
  });

  it("names the ruling and points at the improvement queue that will empty it", () => {
    expect(shipped.ruling).toMatch(/PROMOTION-SCOPE option B/);
    expect(shipped.ruling).toMatch(/must NOT be waived, deleted or promoted/);
    expect(shipped.improvement_queue).toMatch(/corpus-improvement-candidates-2026-08-26\.md/);
  });

  it("agrees, id for id, with the plan report it was measured from", () => {
    // THE ANTI-DRIFT PIN. The register is not a hand-typed list: it is the blocked set of a
    // recorded plan run. Anything held here that the measurement did not block is an invention.
    const plan = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", String(shipped.measured_from.plan_report)), "utf8"),
    ) as { verdicts: Verdict[] };
    const measuredBlocked = plan.verdicts.filter((v) => !v.eligible).map((v) => v.skill_id).sort();
    expect(shipped.holds.map((h) => h.skill_id).sort()).toEqual(measuredBlocked);
  });
});
