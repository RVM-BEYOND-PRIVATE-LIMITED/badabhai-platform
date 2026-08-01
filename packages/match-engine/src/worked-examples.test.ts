import { matchSkillLabel, type IndustryId, type MatchSkillId } from "@badabhai/taxonomy";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG } from "./config";
import { calendarMonthsOf, computeIndustryTenure, mergeIntervals, tenureFor } from "./tenure";
import { matchTierFor, resolveReachSet, wantedSkillIds } from "./reach";
import { effectiveTier, interleaveMaxPerCompany, rankKeyCompare, skillMonthsFor } from "./rank";
import type { FeedRow, RankInputs, WorkerSkillRow } from "./types";

/**
 * MATCHING V1 RELEASE GATE — Part 8 of `docs/specs/matching-algorithm-v1.md`,
 * executed. One table row per printed case, E1..E18, each named for its spec id.
 *
 * If a case here fails, V1 does not ship: the spec and the code have diverged and one
 * of them is wrong.
 *
 * EVERY NUMBER IS DERIVED, NOT DECLARED. `industryMonths` in particular is produced by
 * calling `computeIndustryTenure` on the case's rows — never hand-written into the
 * `RankInputs`. The first build of this package hand-wrote it, which is exactly how a
 * wrong tenure function passed a green suite: the comparator got tested twice and the
 * tenure function never.
 *
 * Reference job throughout (spec Part 8 header): VMC OPERATOR · Manufacturing, related
 * HMC Operator · CNC Setter-Operator · CNC Turner.
 *
 * ONE DELIBERATE DIVERGENCE FROM THE PRINTED TEXT, E3 — the 2026-07-31 owner ruling
 * (Part 9 #1, option b). The case says so at the assertion.
 *
 * Cases about the database or an endpoint (E12, E13, E15, E16, E17) assert the
 * ENGINE-LEVEL contract that makes the endpoint behaviour possible and carry an
 * `// integration:` note naming what apps/api still has to do.
 */

const cfg = DEFAULT_MATCH_CONFIG;

const VMC: MatchSkillId = "mskill_vmc_operator";
const HMC: MatchSkillId = "mskill_hmc_operator";
const SETTER: MatchSkillId = "mskill_cnc_setter_operator";
const TURNER: MatchSkillId = "mskill_cnc_turner";
const GENERAL: MatchSkillId = "mskill_cnc_operator_general";
const FITTER: MatchSkillId = "mskill_fitter";
const RIDER: MatchSkillId = "mskill_delivery_rider";
const CARPENTER: MatchSkillId = "mskill_carpenter";

const MFG: IndustryId = "ind_industrial_manufacturing";
/**
 * The spec's second industry is QUICK-COMMERCE (E1) and CONSTRUCTION (E7). The V1
 * `INDUSTRIES` vocabulary carries Manufacturing and Quick-commerce today, so
 * `ind_quick_commerce` also stands in for Construction in E7. What is under test is the
 * ARITHMETIC — skill months cross industries, industry months do not — and that is
 * identical whichever two industry ids are used. Minting Construction is a taxonomy
 * decision, not a test fixture.
 */
const OTHER: IndustryId = "ind_quick_commerce";

const ACTIVE_AT = "2026-07-01T00:00:00.000Z";

/** An UNDATED skill row — the coarse launch shape (`derive.ts` produces exactly this). */
function row(
  skillId: MatchSkillId,
  monthsBucketed: number,
  over: Partial<WorkerSkillRow> = {},
): WorkerSkillRow {
  return {
    skillId,
    industryId: MFG,
    monthsBucketed,
    wants: true,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

/**
 * A DATED skill row. `end` is exclusive, so 2023-01-01..2025-01-01 is the spec's
 * "Jan 2023 – Dec 2024" = 24 months.
 */
function stint(
  skillId: MatchSkillId,
  start: string,
  end: string | null,
  monthsBucketed: number,
  over: Partial<WorkerSkillRow> = {},
): WorkerSkillRow {
  return { ...row(skillId, monthsBucketed, over), startedAt: start, endedAt: end };
}

function rank(over: Partial<RankInputs> & { id: string }): RankInputs {
  return {
    matchTier: 1,
    skillMonths: 0,
    industryMonths: 0,
    lastWorkedAt: null,
    lastActiveAt: ACTIVE_AT,
    ...over,
  };
}

function order(rows: readonly RankInputs[]): string[] {
  return [...rows].sort((a, b) => rankKeyCompare(a, b, cfg)).map((r) => r.id);
}

/** The spec's printed key: (match_tier, skill_months, industry_months). */
function rankKey(r: RankInputs): [number, number, number] {
  return [r.matchTier, r.skillMonths, r.industryMonths];
}

interface CandidateInput {
  id: string;
  rows: readonly WorkerSkillRow[];
  postedSkillIds: readonly MatchSkillId[];
  jobIndustryId: IndustryId;
  totalYears?: number | null;
  untickedIds?: readonly MatchSkillId[];
  lastWorkedAt?: string | null;
}

/**
 * The pipeline apps/api will run per candidate (spec moments ③ and ⑤), assembled from
 * the engine's own exports and nothing else. `null` means "not visible" — no reach.
 *
 * `industryMonths` comes out of `computeIndustryTenure`. Nothing in this file writes
 * that number by hand.
 *
 * integration: apps/api owns the SQL that produces `worker_skill` and `job_reach`, and
 * must not re-implement any of the arithmetic below.
 */
function candidate(input: CandidateInput): RankInputs | null {
  const reach = resolveReachSet({
    postedSkillIds: input.postedSkillIds,
    relatedDefault: cfg.relatedSkillsDefault,
    untickedIds: input.untickedIds,
  });
  const wanted = wantedSkillIds(input.rows);
  const inReach = wanted.filter((id) => reach.reachSkillIds.includes(id));
  if (inReach.length === 0) return null;

  const matchTier = matchTierFor(inReach, reach.postedSkillIds);
  if (matchTier === null) return null;

  const tenure = computeIndustryTenure(input.rows, input.totalYears ?? null, cfg.monthBucket);
  return rank({
    id: input.id,
    matchTier,
    skillMonths: skillMonthsFor({
      workerRows: input.rows,
      postedSkillIds: reach.postedSkillIds,
      matchedTier: matchTier,
    }),
    industryMonths: tenureFor(tenure, input.jobIndustryId),
    lastWorkedAt: input.lastWorkedAt ?? null,
  });
}

/** `candidate` where the case guarantees visibility — keeps the assertions readable. */
function visible(input: CandidateInput): RankInputs {
  const result = candidate(input);
  expect(result, `${input.id} must be visible`).not.toBeNull();
  return result as RankInputs;
}

function longestRun(rows: readonly { payerKey: string }[]): number {
  let best = 0;
  let current = 0;
  let key: string | null = null;
  for (const r of rows) {
    if (r.payerKey === key) current += 1;
    else {
      key = r.payerKey;
      current = 1;
    }
    if (current > best) best = current;
  }
  return best;
}

interface WorkedExample {
  id: string;
  title: string;
  check: () => void;
}

const EXAMPLES: WorkedExample[] = [
  {
    id: "E1",
    title: "the founder's case — Zomato + CNC. Rider 24 mo · CNC Turner 24 mo",
    check: () => {
      // Dated rows in two industries, so the TENURE FUNCTION has to keep them apart
      // rather than the fixture doing it for it.
      const rows = [
        stint(RIDER, "2021-01-01", "2023-01-01", 24, { industryId: OTHER }),
        stint(TURNER, "2023-01-01", "2025-01-01", 24),
      ];
      const tenure = computeIndustryTenure(rows, null, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(24);
      expect(tenureFor(tenure, OTHER)).toBe(24);

      // Row 1 — VMC Operator, CNC Turner TICKED -> Visible, (2, 24, 24).
      const ticked = visible({ id: "ramesh", rows, postedSkillIds: [VMC], jobIndustryId: MFG });
      expect(rankKey(ticked)).toEqual([2, 24, 24]);

      // "His delivery months contribute nothing to a factory job either way": the 24
      // quick-commerce months appear in neither column.
      expect(ticked.skillMonths).toBe(24); // not 48
      expect(ticked.industryMonths).toBe(24); // not 48

      // Row 2 — CNC Turner UNTICKED by the company -> Not visible.
      expect(
        candidate({ id: "ramesh", rows, postedSkillIds: [VMC], jobIndustryId: MFG, untickedIds: [TURNER] }),
      ).toBeNull();

      // Same outcome through the OTHER Part 2 condition: he does not want that work.
      const notWanted = [rows[0] as WorkerSkillRow, { ...(rows[1] as WorkerSkillRow), wants: false }];
      expect(candidate({ id: "ramesh", rows: notWanted, postedSkillIds: [VMC], jobIndustryId: MFG })).toBeNull();

      // Row 3 — a CNC Turner job -> Visible, (1, 24, 24).
      expect(rankKey(visible({ id: "ramesh", rows, postedSkillIds: [TURNER], jobIndustryId: MFG }))).toEqual([1, 24, 24]);

      // ...and symmetrically his factory months are invisible on a delivery job.
      expect(rankKey(visible({ id: "ramesh", rows, postedSkillIds: [RIDER], jobIndustryId: OTHER }))).toEqual([1, 24, 24]);
    },
  },
  {
    id: "E2",
    title: "full ordering on one job — X(1,48,48) · Y(1,24,48) · Z(1,24,24) · R(2,24,24)",
    check: () => {
      // X · 48 mo VMC.
      const X = visible({
        id: "X", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(VMC, "2021-01-01", "2025-01-01", 48)],
      });
      // Y · 24 mo VMC + 24 mo CNC Turner, BOTH Manufacturing, consecutive stints.
      // industry_months = 24 + 24 = 48 — a SUM of merged stints. This is the number the
      // first implementation got wrong by returning a max over rows.
      const Y = visible({
        id: "Y", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [
          stint(VMC, "2023-01-01", "2025-01-01", 24),
          stint(TURNER, "2021-01-01", "2023-01-01", 24),
        ],
      });
      // Z · 24 mo VMC.
      const Z = visible({
        id: "Z", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(VMC, "2023-01-01", "2025-01-01", 24)],
      });
      // R · 24 mo CNC Turner, no VMC -> related.
      const R = visible({
        id: "R", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2023-01-01", "2025-01-01", 24)],
      });

      expect(rankKey(X)).toEqual([1, 48, 48]);
      expect(rankKey(Y)).toEqual([1, 24, 48]);
      expect(rankKey(Z)).toEqual([1, 24, 24]);
      expect(rankKey(R)).toEqual([2, 24, 24]);

      // R stays TIER 2 under the ruling: 24 months is below the 36-month floor.
      expect(effectiveTier(R.matchTier, R.skillMonths, cfg.tierFloorMonths)).toBe(2);

      expect(order([R, Z, Y, X])).toEqual(["X", "Y", "Z", "R"]);
      expect(order([X, Y, Z, R])).toEqual(["X", "Y", "Z", "R"]);

      // "Y beats Z on his CNC years — because their VMC months are level." Invariant B
      // in one line: industry months spoke only after skill months tied.
      expect(Y.skillMonths).toBe(Z.skillMonths);
      expect(Y.industryMonths).toBeGreaterThan(Z.industryMonths);
    },
  },
  {
    id: "E3",
    title: "the sharp edge — RULED 2026-07-31: the floor promotes the veteran",
    check: () => {
      // B · 6 mo VMC, nothing else.
      const B = visible({
        id: "B", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(VMC, "2024-07-01", "2025-01-01", 6)],
      });
      // C · 120 mo CNC Turner.
      const C = visible({
        id: "C", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2015-01-01", "2025-01-01", 120)],
      });
      expect(rankKey(B)).toEqual([1, 6, 6]);
      expect(rankKey(C)).toEqual([2, 120, 120]);

      // THE SPEC PRINTS B ABOVE C. That printed order is the STRICT-TIER behaviour the
      // owner REJECTED on 2026-07-31 (Part 9 ruling #1, option b — tier-with-floor at
      // 36). Under the ruling C's effective tier becomes 1 and C ranks ABOVE B.
      //
      // DO NOT "FIX" THIS BACK TO THE PRINTED ORDER. If a future ruling restores strict
      // tier, it must change `tierFloorMonths` and edit this case in the same diff.
      expect(effectiveTier(C.matchTier, C.skillMonths, cfg.tierFloorMonths)).toBe(1);
      expect(order([B, C])).toEqual(["C", "B"]);

      // The badge does not lie about it: he is still a tier-2 (related) match.
      expect(C.matchTier).toBe(2);

      // The rejected behaviour, MEASURED rather than described: with the floor out of
      // reach the comparator reproduces the spec's printed order exactly.
      const strictTier = { ...cfg, tierFloorMonths: Number.MAX_SAFE_INTEGER };
      expect(rankKeyCompare(B, C, strictTier)).toBeLessThan(0);
    },
  },
  {
    id: "E4",
    title: "duration unknown — (1, 0, …) last within tier 1, never dropped",
    check: () => {
      // "Maine VMC chalaya hai" — he cannot say how long. No months, no dates.
      const unknown = visible({
        id: "unknown", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [row(VMC, 0)], totalYears: null,
      });
      expect(rankKey(unknown)).toEqual([1, 0, 0]);

      const known = visible({
        id: "known", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(VMC, "2023-01-01", "2025-01-01", 24)],
      });
      const relatedBelowFloor = visible({
        id: "related", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2022-07-01", "2025-01-01", 30)],
      });

      // Last within tier 1...
      expect(order([unknown, known])).toEqual(["known", "unknown"]);
      // ...but above a related-skill worker, and NEVER dropped.
      expect(order([relatedBelowFloor, unknown])).toEqual(["unknown", "related"]);

      // THE RULING NARROWS THE SPEC SENTENCE. E4 as printed says "still above EVERY
      // related-skill worker". Under tier-with-floor that holds only for related workers
      // BELOW the floor: a 120-month floored turner now sorts ABOVE a 0-month exact VMC
      // hand. That is a genuine consequence of ruling #1, asserted deliberately here so
      // nobody meets it for the first time in production.
      const flooredVeteran = visible({
        id: "veteran", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2015-01-01", "2025-01-01", 120)],
      });
      expect(order([unknown, flooredVeteran])).toEqual(["veteran", "unknown"]);
      // 36 is the boundary and it is INCLUSIVE — exactly at the floor, the same result.
      const atFloor = visible({
        id: "atfloor", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2022-01-01", "2025-01-01", 36)],
      });
      expect(order([unknown, atFloor])).toEqual(["atfloor", "unknown"]);
    },
  },
  {
    id: "E5",
    title: "multi-skill posting [CNC Turner, VMC Operator] — skill_months = max = 36",
    check: () => {
      // Worker has CNC Turner 36 mo, VMC 12 mo. BOTH are posted.
      const rows = [
        stint(TURNER, "2021-01-01", "2024-01-01", 36),
        stint(VMC, "2024-01-01", "2025-01-01", 12),
      ];
      const result = visible({ id: "multi", rows, postedSkillIds: [TURNER, VMC], jobIndustryId: MFG });

      expect(result.matchTier).toBe(1); // holds a posted skill
      expect(result.skillMonths).toBe(36); // MAX across matched posted skills
      expect(result.skillMonths).not.toBe(48); // never a sum: he is hired for ONE of them

      // The spec does not print E5's third column; it follows from moment ②
      // (36 + 12 consecutive months in Manufacturing).
      expect(result.industryMonths).toBe(48);
    },
  },
  {
    id: "E6",
    title: "exact AND related — best tier wins, months are the exact skill's: (1, 12, 72)",
    check: () => {
      // VMC 12 mo + CNC Turner 60 mo, on a VMC job.
      const rows = [
        stint(TURNER, "2019-01-01", "2024-01-01", 60),
        stint(VMC, "2024-01-01", "2025-01-01", 12),
      ];
      const result = visible({ id: "both", rows, postedSkillIds: [VMC], jobIndustryId: MFG });

      // Best tier wins.
      expect(result.matchTier).toBe(1);
      // 12 — the EXACT skill — NOT 60. Counting the related months would sell the payer
      // five years on a machine this vacancy is not for.
      expect(result.skillMonths).toBe(12);
      // "His CNC years still lift him via industry_months": 72 = 12 + 60, DERIVED.
      expect(result.industryMonths).toBe(72);
      expect(rankKey(result)).toEqual([1, 12, 72]);

      expect(matchTierFor([VMC, TURNER], [VMC])).toBe(1);
      expect(matchTierFor([TURNER], [VMC])).toBe(2);
    },
  },
  {
    id: "E7",
    title: "same skill, two industries — skill_months 42, industry_months 24",
    check: () => {
      // A Fitter with 24 mo in Manufacturing and 18 mo in Construction, on a
      // Manufacturing Fitter job. (Construction stands in as `OTHER` — see the header.)
      const rows = [
        stint(FITTER, "2021-01-01", "2023-01-01", 24),
        stint(FITTER, "2023-01-01", "2024-07-01", 18, { industryId: OTHER }),
      ];

      // "A fitter is a fitter, wherever he fitted" (ruling #3): the SKILL sums.
      expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [FITTER], matchedTier: 1 })).toBe(42);

      // Industry governs industry_months only — Manufacturing sees 24 of the 42.
      const tenure = computeIndustryTenure(rows, null, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(24);
      expect(tenureFor(tenure, OTHER)).toBe(18);

      const result = visible({ id: "fitter", rows, postedSkillIds: [FITTER], jobIndustryId: MFG });
      expect(rankKey(result)).toEqual([1, 42, 24]);

      // THE E7/E8 INTERACTION, asserted: skill_months (42) legitimately EXCEEDS
      // industry_months (24) because the skill spans two industries. The E8 clamp is
      // therefore per-industry and must never compare a skill against a cross-industry
      // sum — doing so would force Manufacturing to 42 and break this case.
      expect(result.skillMonths).toBeGreaterThan(result.industryMonths);
    },
  },
  {
    id: "E8",
    title: "data integrity — clamp industry_months = MAX(industry_months, skill_months)",
    check: () => {
      // Common in voice-extracted data: he said "three years on the VMC", but the only
      // dates we captured cover twelve months. The dated sum alone would read 12.
      const rows = [stint(VMC, "2024-01-01", "2025-01-01", 36)];
      const tenure = computeIndustryTenure(rows, null, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(36);

      // ...and with no dates at all, the coarse total is the floor and the clamp still
      // lifts the industry to the skill.
      const undated = computeIndustryTenure([row(VMC, 36)], 2, cfg.monthBucket);
      expect(tenureFor(undated, MFG)).toBe(36);

      const result = visible({ id: "clamped", rows, postedSkillIds: [VMC], jobIndustryId: MFG });
      expect(rankKey(result)).toEqual([1, 36, 36]);
      // Impossible in reality, so never rendered: WITHIN one industry the skill can
      // never exceed the tenure.
      expect(result.industryMonths).toBeGreaterThanOrEqual(result.skillMonths);
    },
  },
  {
    id: "E9",
    title: "overlapping stints — VMC and tool-setting in the SAME job is 24, not 48",
    check: () => {
      // VMC Operator Jan 2023 – Dec 2024, and setting tools in the same job. Two skill
      // rows, one span of the man's life.
      const rows = [
        stint(VMC, "2023-01-01", "2025-01-01", 24),
        stint(SETTER, "2023-01-01", "2025-01-01", 24),
      ];
      const tenure = computeIndustryTenure(rows, null, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(24); // NOT 48

      const result = visible({ id: "same-job", rows, postedSkillIds: [VMC], jobIndustryId: MFG });
      expect(rankKey(result)).toEqual([1, 24, 24]);

      // The merge itself, at the interval level.
      expect(mergeIntervals(rows.map((r) => ({ start: r.startedAt as string, end: r.endedAt })))).toEqual([
        { start: "2023-01-01", end: "2025-01-01" },
      ]);
      // A partial overlap merges to the union, not the sum; genuinely disjoint stints
      // still add up (that is E2·Y).
      expect(calendarMonthsOf([
        { start: "2020-01-01", end: "2021-07-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ])).toBe(24);
      expect(calendarMonthsOf([
        { start: "2018-01-01", end: "2019-01-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ])).toBe(24);
    },
  },
  {
    id: "E10",
    title: "job-hopper vs long-stayer — 24 mo VMC either way, IDENTICAL rank key",
    check: () => {
      // One 24-month stint...
      const stayerRows = [stint(VMC, "2023-01-01", "2025-01-01", 24)];
      // ...versus four six-month jobs, back to back.
      const hopperRows = [
        stint(VMC, "2023-01-01", "2023-07-01", 6),
        stint(VMC, "2023-07-01", "2024-01-01", 6),
        stint(VMC, "2024-01-01", "2024-07-01", 6),
        stint(VMC, "2024-07-01", "2025-01-01", 6),
      ];
      expect(tenureFor(computeIndustryTenure(stayerRows, null, cfg.monthBucket), MFG)).toBe(24);
      expect(tenureFor(computeIndustryTenure(hopperRows, null, cfg.monthBucket), MFG)).toBe(24);

      const stayer = visible({ id: "stayer", rows: stayerRows, postedSkillIds: [VMC], jobIndustryId: MFG });
      const hopper = visible({ id: "hopper", rows: hopperRows, postedSkillIds: [VMC], jobIndustryId: MFG });

      // "Identical Rank Key." Job-hopping is not scored — there is no column for it.
      expect(rankKey(hopper)).toEqual(rankKey(stayer));
      expect(rankKeyCompare({ ...hopper, id: "same" }, { ...stayer, id: "same" }, cfg)).toBe(0);
      // Only the stable hash separates them.
      expect(order([stayer, hopper])).toEqual(["hopper", "stayer"]);

      // integration: the number of employers is an ATTRIBUTE on the card (policy A-5)
      // and must never reach the rank inputs.
    },
  },
  {
    id: "E11",
    title: "complete tie — last_active_at, then stable_hash. Never random at read time",
    check: () => {
      // last_active_at speaks first...
      const recent = rank({ id: "zzz", matchTier: 1, skillMonths: 24, industryMonths: 24, lastActiveAt: "2026-07-29T00:00:00.000Z" });
      const stale = rank({ id: "aaa", matchTier: 1, skillMonths: 24, industryMonths: 24, lastActiveAt: "2026-07-01T00:00:00.000Z" });
      expect(order([stale, recent])).toEqual(["zzz", "aaa"]);

      // ...and on a COMPLETE tie the stable hash decides. Same answer every time.
      const tied = ["delta", "alpha", "charlie", "bravo"].map((id) =>
        rank({ id, matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2026-01-01" }),
      );
      const expected = ["alpha", "bravo", "charlie", "delta"];
      expect(order(tied)).toEqual(expected);
      expect(order([...tied].reverse())).toEqual(expected);
      expect(order(tied)).toEqual(expected);
      // A list that reorders between page loads looks broken to a man who just paid.
    },
  },
  {
    id: "E12",
    title: "nobody wants the skill — reach falls to related, then to zero (ops alert)",
    check: () => {
      const posted = [VMC];

      // Ten men hold it, none has wants = true. They are history, not supply.
      const unwilling = [row(VMC, 48, { wants: false })];
      expect(wantedSkillIds(unwilling)).toEqual([]);
      expect(matchTierFor(wantedSkillIds(unwilling), posted)).toBeNull();
      expect(candidate({ id: "unwilling", rows: unwilling, postedSkillIds: posted, jobIndustryId: MFG })).toBeNull();

      // Reach falls to the RELATED skills — a turner who does want the work.
      const turner = [stint(TURNER, "2023-01-01", "2025-01-01", 24)];
      expect(matchTierFor(wantedSkillIds(turner), posted)).toBe(2);
      expect(candidate({ id: "turner", rows: turner, postedSkillIds: posted, jobIndustryId: MFG })).not.toBeNull();

      // If that is also zero: nobody. Men are never force-fed a job.
      const carpenter = [row(CARPENTER, 120)];
      expect(matchTierFor(wantedSkillIds(carpenter), posted)).toBeNull();
      expect(candidate({ id: "carpenter", rows: carpenter, postedSkillIds: posted, jobIndustryId: MFG })).toBeNull();

      // integration: when related reach is ALSO zero, apps/api must raise the OPS ALERT
      // (the ADR-0021 PACE pattern) and must not widen the reach set on its own —
      // policy B-10, "never silently widens beyond the curated relations".
    },
  },
  {
    id: "E13",
    title: "zero reach at posting — tell the company on the form, before they pay",
    check: () => {
      // The posting is well-formed and has a reach set; a carpenter has no curated
      // relations, so the reach set is the posted skill alone.
      const reach = resolveReachSet({ postedSkillIds: [CARPENTER], relatedDefault: cfg.relatedSkillsDefault });
      expect(reach.reachSkillIds).toEqual([CARPENTER]);
      expect(reach.suggestedRelatedIds).toEqual([]);

      // The REACH COUNTER counts WORKERS, and here it reads 0.
      const fleet = [
        [stint(VMC, "2020-01-01", "2025-01-01", 60)],
        [stint(TURNER, "2015-01-01", "2025-01-01", 120)],
        [stint(RIDER, "2023-01-01", "2025-01-01", 24, { industryId: OTHER })],
      ];
      const reachCount = fleet
        .map((rows, i) => candidate({ id: `w${i}`, rows, postedSkillIds: [CARPENTER], jobIndustryId: MFG }))
        .filter((c): c is RankInputs => c !== null).length;
      expect(reachCount).toBe(0);

      // integration: apps/api must surface that 0 ON THE FORM, before payment, and
      // refuse the charge — "never take money for a posting into a void". It must never
      // pad the page with off-trade workers; `boostSupplyFloor` guards the same failure
      // on the boost path.
    },
  },
  {
    id: "E14",
    title: "one company floods the feed — maximum 2 consecutive cards from one company",
    check: () => {
      const feed: FeedRow[] = [
        { jobId: "a1", payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
        { jobId: "a2", payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
        { jobId: "a3", payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
        { jobId: "b1", payerKey: "bharat", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
        { jobId: "a4", payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
        { jobId: "c1", payerKey: "chirag", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z" },
      ];
      const out = interleaveMaxPerCompany(feed, cfg.maxConsecutiveSameCompany);
      expect(out.map((r) => r.jobId)).toEqual(["a1", "a2", "b1", "a3", "a4", "c1"]);
      expect(longestRun(out)).toBeLessThanOrEqual(cfg.maxConsecutiveSameCompany);
      expect(out.map((r) => r.jobId).sort()).toEqual(feed.map((r) => r.jobId).sort());

      // DEGRADES HONESTLY: when one company owns the whole page the run is unavoidable.
      // The rule cannot conjure a second employer, so it emits the rows in their
      // original order rather than hiding any of them.
      const monopoly: FeedRow[] = ["m1", "m2", "m3", "m4"].map((jobId) => ({
        jobId, payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z",
      }));
      const degraded = interleaveMaxPerCompany(monopoly, cfg.maxConsecutiveSameCompany);
      expect(degraded.map((r) => r.jobId)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(longestRun(degraded)).toBe(4);

      // integration: moment ④ orders the feed `boosted DESC, published_at DESC` BEFORE
      // this rule is applied; boost reorders, it never ADDS a job (policy B-13).
    },
  },
  {
    id: "E15",
    title: "worker matches on two skills of one job — ONE application, best tier, highest months",
    check: () => {
      // The job posts BOTH skills and he holds both. This is exactly the case E6 is
      // not: there, CNC Turner was merely RELATED and contributed no skill months.
      const rows = [
        stint(TURNER, "2019-01-01", "2024-01-01", 60),
        stint(VMC, "2024-01-01", "2025-01-01", 12),
      ];
      const result = visible({ id: "app-1", rows, postedSkillIds: [VMC, TURNER], jobIndustryId: MFG });
      expect(result.matchTier).toBe(1); // best tier
      expect(result.skillMonths).toBe(60); // highest skill_months across the matched posted skills

      // ONE application: two rows carrying the same id are INDISTINGUISHABLE to the
      // comparator, which returns 0. The engine cannot establish uniqueness — that has
      // to be a constraint.
      expect(rankKeyCompare(result, { ...result }, cfg)).toBe(0);
      expect(rankKeyCompare(result, { ...result, id: "app-2" }, cfg)).toBeLessThan(0);

      // integration: packages/db must carry UNIQUE(worker_id, job_id) on `application`
      // and apps/api must return the EXISTING application rather than inserting a second.
    },
  },
  {
    id: "E16",
    title: "worker updates his profile after applying — the company's list does not move",
    check: () => {
      const a = Object.freeze(rank({ id: "a", matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2024-01-01" }));
      const b = Object.freeze(rank({ id: "b", matchTier: 2, skillMonths: 48, industryMonths: 48, lastWorkedAt: "2019-01-01" }));

      // The comparator reads the frozen snapshot and only the frozen snapshot.
      const first = rankKeyCompare(a, b, cfg);
      expect(rankKeyCompare(a, b, cfg)).toBe(first);
      expect([a, b].sort((x, y) => rankKeyCompare(x, y, cfg)).map((r) => r.id)).toEqual(["b", "a"]);
      expect(a).toEqual({
        matchTier: 1, skillMonths: 24, industryMonths: 24,
        lastWorkedAt: "2024-01-01", lastActiveAt: ACTIVE_AT, id: "a",
      });

      // Time enters as DATA. An ongoing stint contributes 0 without an explicit `asOf`;
      // the package has no clock to quietly count up to "now" with.
      const ongoing = [stint(VMC, "2020-01-01", null, 0)];
      expect(tenureFor(computeIndustryTenure(ongoing, null, cfg.monthBucket), MFG)).toBe(0);
      expect(tenureFor(computeIndustryTenure(ongoing, null, cfg.monthBucket, "2022-01-01"), MFG)).toBe(24);

      // integration: moment ⑤ — apps/api must SNAPSHOT match_tier, skill_months,
      // industry_months, last_worked_at and engine_version onto the application row at
      // apply time. Re-deriving them at read time is what makes a paid list move.
    },
  },
  {
    id: "E17",
    title: "the one-tag worker — Related Skills rescue him",
    check: () => {
      // A man leaves the conversation with a single skill tag, and it is not the posted
      // one. Without relations his feed is empty.
      const oneTag = [stint(TURNER, "2023-01-01", "2025-01-01", 24)];
      const reach = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: cfg.relatedSkillsDefault });
      expect([...reach.suggestedRelatedIds].sort()).toEqual([HMC, SETTER, TURNER].sort());
      expect(reach.reachSkillIds).toContain(TURNER);
      expect(rankKey(visible({ id: "one-tag", rows: oneTag, postedSkillIds: [VMC], jobIndustryId: MFG }))).toEqual([2, 24, 24]);

      // "One tag reaches roughly three to four times as many jobs as before" — the
      // multiplier IS the curated relation, measured rather than claimed: every posted
      // skill in the vocabulary that reaches a CNC-Turner-only worker.
      const reachingPostings = ([VMC, HMC, SETTER, TURNER, GENERAL, FITTER, RIDER, CARPENTER] as const).filter(
        (posted) => matchTierFor([TURNER], [posted]) !== null,
      );
      expect(reachingPostings).toContain(TURNER); // the exact one he would have had alone
      expect(reachingPostings).toEqual([VMC, SETTER, TURNER, GENERAL]);
      expect(reachingPostings.length).toBeGreaterThanOrEqual(3); // the doc's "three to four times"

      // integration: apps/api must still flag `low_tag_worker`, queue a re-profiling
      // nudge, and track `avg_skill_tags_per_worker` — below 2, the CONVERSATION is the
      // bug, not the algorithm.
    },
  },
  {
    id: "E18",
    title: "related-skill workers on the card — badge it, never promote it silently",
    check: () => {
      const veteran = visible({
        id: "veteran", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(TURNER, "2021-01-01", "2025-01-01", 48)],
      });
      // Promoted for ORDERING by the floor...
      expect(effectiveTier(veteran.matchTier, veteran.skillMonths, cfg.tierFloorMonths)).toBe(1);
      // ...but `matchTier` still says what he actually is, so the card can be honest
      // before the company spends ₹40.
      expect(veteran.matchTier).toBe(2);

      // The badge text is derivable from the vocabulary alone.
      expect(`${matchSkillLabel(TURNER)} — related to ${matchSkillLabel(VMC)}`).toBe(
        "CNC Turner — related to VMC Operator",
      );

      // The badge is a LABEL, never a penalty and never a promotion: an exact match with
      // the same months ties with him all the way down to the stable hash.
      const exact = visible({
        id: "exact", jobIndustryId: MFG, postedSkillIds: [VMC],
        rows: [stint(VMC, "2021-01-01", "2025-01-01", 48)],
      });
      expect(rankKeyCompare({ ...veteran, id: "x" }, { ...exact, id: "x" }, cfg)).toBe(0);

      // integration: `job_reach.matched_skill_id` (moment ③) must ride onto the
      // application row so the card knows WHICH related skill to name. It is display
      // only and must never enter `RankInputs`.
    },
  },
];

describe("Matching V1 — Part 8 worked examples", () => {
  it("covers E1..E18 exactly once", () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual(Array.from({ length: 18 }, (_, i) => `E${i + 1}`));
  });

  it.each(EXAMPLES)("$id — $title", ({ check }) => {
    check();
  });
});

describe("Matching V1 — Part 4 proof against the three required cases", () => {
  it("① industry breaks ties but never crosses", () => {
    const X = visible({
      id: "X", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [stint(VMC, "2021-01-01", "2025-01-01", 48)],
    });
    const Y = visible({
      id: "Y", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [
        stint(VMC, "2023-01-01", "2025-01-01", 24),
        stint(TURNER, "2021-01-01", "2023-01-01", 24),
      ],
    });
    const Z = visible({
      id: "Z", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [stint(VMC, "2023-01-01", "2025-01-01", 24)],
    });
    expect([rankKey(X), rankKey(Y), rankKey(Z)]).toEqual([
      [1, 48, 48],
      [1, 24, 48],
      [1, 24, 24],
    ]);
    expect(order([Z, Y, X])).toEqual(["X", "Y", "Z"]);
  });

  it("② six months never crosses two years", () => {
    // A · 24 mo VMC, nothing else -> (1, 24, 24)
    const A = visible({
      id: "A", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [stint(VMC, "2023-01-01", "2025-01-01", 24)],
    });
    // B · 6 mo VMC + 240 mo factory work -> (1, 6, 246). industry_months = 6 + 240.
    const B = visible({
      id: "B", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [
        stint(GENERAL, "2004-07-01", "2024-07-01", 240),
        stint(VMC, "2024-07-01", "2025-01-01", 6),
      ],
    });
    expect(rankKey(A)).toEqual([1, 24, 24]);
    expect(rankKey(B)).toEqual([1, 6, 246]);
    // "Twenty years cannot buy eighteen months on the machine." Invariant B, in the
    // spec's own numbers.
    expect(order([B, A])).toEqual(["A", "B"]);
  });

  it("③ related skills are reached, and ranked below", () => {
    const Z = visible({
      id: "Z", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [stint(VMC, "2023-01-01", "2025-01-01", 24)],
    });
    const R = visible({
      id: "R", jobIndustryId: MFG, postedSkillIds: [VMC],
      rows: [stint(TURNER, "2023-01-01", "2025-01-01", 24)],
    });
    expect(rankKey(Z)).toEqual([1, 24, 24]);
    expect(rankKey(R)).toEqual([2, 24, 24]);
    expect(order([R, Z])).toEqual(["Z", "R"]);
  });
});
