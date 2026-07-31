import type { IndustryId, MatchSkillId } from "@badabhai/taxonomy";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG } from "./config";
import { calendarMonthsOf, computeIndustryTenure, mergeIntervals, tenureFor } from "./tenure";
import { matchTierFor, resolveReachSet, wantedSkillIds } from "./reach";
import { effectiveTier, interleaveMaxPerCompany, rankKeyCompare, skillMonthsFor } from "./rank";
import type { FeedRow, RankInputs, WorkerSkillRow } from "./types";

/**
 * MATCHING V1 RELEASE GATE — the eighteen worked examples, E1..E18.
 *
 * The ratified document argues the algorithm through eighteen worked cases. This file
 * is those cases, executable, one table row each. If a case here fails, V1 does not
 * ship — the document and the code have diverged and one of them is wrong.
 *
 * The reference job throughout is the document's own: a VMC OPERATOR vacancy, whose
 * curated related skills are HMC Operator, CNC Setter-Operator and CNC Turner.
 *
 * ONE DELIBERATE DIVERGENCE, E3. The document illustrates STRICT tier ordering, where
 * a six-month exact match beats a ten-year related one. The owner ruled on 2026-07-31
 * that V1 ships TIER-WITH-FLOOR at 36 months, which inverts that specific
 * illustration. E3 below asserts the RULED behaviour, not the printed one, and says
 * so at the case.
 *
 * Cases that are really about the database or an endpoint (E13, E15, E16) assert the
 * ENGINE-LEVEL contract that makes the endpoint behaviour possible, and carry an
 * `// integration:` note naming what apps/api still has to assert.
 */

const cfg = DEFAULT_MATCH_CONFIG;

const VMC: MatchSkillId = "mskill_vmc_operator";
const HMC: MatchSkillId = "mskill_hmc_operator";
const SETTER: MatchSkillId = "mskill_cnc_setter_operator";
const TURNER: MatchSkillId = "mskill_cnc_turner";
const PROGRAMMER: MatchSkillId = "mskill_cnc_programmer";
const RIDER: MatchSkillId = "mskill_delivery_rider";
const CARPENTER: MatchSkillId = "mskill_carpenter";

const MFG: IndustryId = "ind_industrial_manufacturing";
const QCOM: IndustryId = "ind_quick_commerce";

const CREATED = "2026-07-01T00:00:00.000Z";

/** A worker skill row. Defaults match the coarse launch shape (wants, no stint dates). */
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

function rank(over: Partial<RankInputs> & { id: string }): RankInputs {
  return {
    matchTier: 1,
    skillMonths: 0,
    industryMonths: 0,
    lastWorkedAt: null,
    createdAt: CREATED,
    ...over,
  };
}

function order(rows: readonly RankInputs[]): string[] {
  return [...rows].sort((a, b) => rankKeyCompare(a, b, cfg)).map((r) => r.id);
}

/** The document's printed key: (matchTier, skillMonths, industryMonths). */
function docKey(r: RankInputs): [number, number, number] {
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
 * The pipeline apps/api will run per candidate, assembled from the engine's own
 * exports and nothing else. `null` means "not visible for this job" — no reach.
 *
 * integration: apps/api owns the DB query that produces `rows` and the reach set, and
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

interface WorkedExample {
  id: string;
  title: string;
  check: () => void;
}

const EXAMPLES: WorkedExample[] = [
  {
    id: "E1",
    title: "the founder's case — a Zomato rider who also ran a CNC lathe",
    check: () => {
      // 24 months riding for a quick-commerce platform AND 24 months on a CNC lathe.
      const rows = [row(RIDER, 24, { industryId: QCOM }), row(TURNER, 24)];

      // On the VMC job: CNC Turner is a RELATED skill, so he is visible at tier 2.
      const visible = candidate({ id: "founder", rows, postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: 2 });
      expect(visible).not.toBeNull();
      expect(docKey(visible as RankInputs)).toEqual([2, 24, 24]);

      // The delivery months contribute NOTHING to a factory job: they belong to a
      // different skill in a different industry, and neither column can see them.
      expect((visible as RankInputs).skillMonths).toBe(24); // not 48
      expect((visible as RankInputs).industryMonths).toBe(24); // MFG only, not 48

      // UNTICKED by the payer: CNC Turner leaves the reach set, and with it, him.
      expect(
        candidate({ id: "founder", rows, postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: 2, untickedIds: [TURNER] }),
      ).toBeNull();

      // UNTICKED by the worker (`wants: false`) — same outcome, different reason.
      const notWanted = [row(RIDER, 24, { industryId: QCOM }), row(TURNER, 24, { wants: false })];
      expect(
        candidate({ id: "founder", rows: notWanted, postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: 2 }),
      ).toBeNull();

      // On a CNC TURNER job he is an exact match: (1, 24, 24).
      const exact = candidate({ id: "founder", rows, postedSkillIds: [TURNER], jobIndustryId: MFG, totalYears: 2 });
      expect(docKey(exact as RankInputs)).toEqual([1, 24, 24]);

      // And on a quick-commerce job his factory months are equally invisible.
      const riderJob = candidate({ id: "founder", rows, postedSkillIds: [RIDER], jobIndustryId: QCOM, totalYears: 2 });
      expect(docKey(riderJob as RankInputs)).toEqual([1, 24, 24]);
    },
  },
  {
    id: "E2",
    title: "the base ordering — X(1,48,48) < Y(1,24,48) < Z(1,24,24) < R(2,24,24)",
    check: () => {
      const X = rank({ id: "X", matchTier: 1, skillMonths: 48, industryMonths: 48 });
      const Y = rank({ id: "Y", matchTier: 1, skillMonths: 24, industryMonths: 48 });
      const Z = rank({ id: "Z", matchTier: 1, skillMonths: 24, industryMonths: 24 });
      const R = rank({ id: "R", matchTier: 2, skillMonths: 24, industryMonths: 24 });
      // R stays in tier 2: 24 months is below the 36-month floor.
      expect(effectiveTier(R.matchTier, R.skillMonths, cfg.tierFloorMonths)).toBe(2);
      expect(order([R, Z, Y, X])).toEqual(["X", "Y", "Z", "R"]);
      expect(order([X, Y, Z, R])).toEqual(["X", "Y", "Z", "R"]);
    },
  },
  {
    id: "E3",
    title: "six months exact vs ten years related — RULED: the floor promotes the veteran",
    check: () => {
      // THE DOCUMENT prints strict tier ordering here: B (6 months on the exact skill)
      // above C (120 months on a related one). The owner ruled on 2026-07-31 that V1
      // ships TIER-WITH-FLOOR at 36 months, which DELIBERATELY INVERTS this case: no
      // supervisor would put a six-month VMC hand above a ten-year turner.
      const B = rank({ id: "B", matchTier: 1, skillMonths: 6, industryMonths: 6 });
      const C = rank({ id: "C", matchTier: 2, skillMonths: 120, industryMonths: 120 });

      expect(effectiveTier(C.matchTier, C.skillMonths, cfg.tierFloorMonths)).toBe(1);
      expect(order([B, C])).toEqual(["C", "B"]);

      // The badge does not lie about it: he is still a TIER-2 (related) match.
      expect(C.matchTier).toBe(2);

      // Under the document's strict-tier reading (floor unreachable) B would win —
      // recorded so the divergence is measurable, not just asserted in prose.
      const strictTier = { ...cfg, tierFloorMonths: Number.MAX_SAFE_INTEGER };
      expect(rankKeyCompare(B, C, strictTier)).toBeLessThan(0);
    },
  },
  {
    id: "E4",
    title: "duration unknown — 0 months, last within tier 1, still above every below-floor tier 2",
    check: () => {
      const known = rank({ id: "known", matchTier: 1, skillMonths: 24, industryMonths: 24 });
      const unknown = rank({ id: "unknown", matchTier: 1, skillMonths: 0, industryMonths: 0 });
      const relatedBelowFloor = rank({ id: "related", matchTier: 2, skillMonths: 30, industryMonths: 30 });
      const relatedAtFloor = rank({ id: "veteran", matchTier: 2, skillMonths: 36, industryMonths: 36 });

      // Last within tier 1...
      expect(order([unknown, known])).toEqual(["known", "unknown"]);
      // ...but still above a related worker who has not cleared the floor.
      expect(order([relatedBelowFloor, unknown])).toEqual(["unknown", "related"]);
      // A promoted veteran does outrank him — that is the ruling, not a bug.
      expect(order([unknown, relatedAtFloor])).toEqual(["veteran", "unknown"]);

      // "Unknown" is 0 months, never a guess: a null total years never invents time.
      const derivedUnknown = candidate({
        id: "unknown", rows: [row(VMC, 0)], postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: null,
      });
      expect(docKey(derivedUnknown as RankInputs)).toEqual([1, 0, 0]);
    },
  },
  {
    id: "E5",
    title: "multi-skill posting — months are the MAX across the posted skills he holds",
    check: () => {
      const rows = [row(VMC, 12), row(PROGRAMMER, 30)];
      const result = candidate({
        id: "multi", rows, postedSkillIds: [VMC, PROGRAMMER], jobIndustryId: MFG, totalYears: null,
      });
      // MAX, not SUM: he will be hired to do ONE of them.
      expect(docKey(result as RankInputs)).toEqual([1, 30, 30]);
      expect((result as RankInputs).skillMonths).not.toBe(42);
    },
  },
  {
    id: "E6",
    title: "exact AND related — best tier wins, and the months are the EXACT skill's",
    check: () => {
      const rows = [row(VMC, 12), row(TURNER, 60)];
      const result = candidate({ id: "both", rows, postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: null });

      // Tier 1 on the strength of the exact skill...
      expect((result as RankInputs).matchTier).toBe(1);
      // ...and 12 months, NOT the related skill's 60. Counting those would sell the
      // payer five years on a machine this vacancy is not for.
      expect((result as RankInputs).skillMonths).toBe(12);
      expect(matchTierFor([VMC, TURNER], [VMC])).toBe(1);
      expect(matchTierFor([TURNER], [VMC])).toBe(2);
    },
  },
  {
    id: "E7",
    title: "same skill, two industries — skill months SUM to 42, industry months stay 24",
    check: () => {
      // The V1 INDUSTRIES vocabulary has two entries today, so the second industry is
      // `ind_quick_commerce` standing in for the second manufacturing vertical the
      // document describes (auto components vs pumps). What is under test is the
      // ARITHMETIC — skill months cross industries, industry months do not — and that
      // is identical whichever two industry ids are used.
      const rows = [row(TURNER, 24), row(TURNER, 18, { industryId: QCOM })];

      expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [TURNER], matchedTier: 1 })).toBe(42);

      const tenure = computeIndustryTenure(rows, null, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(24);
      expect(tenureFor(tenure, QCOM)).toBe(18);

      const result = candidate({ id: "two-industries", rows, postedSkillIds: [TURNER], jobIndustryId: MFG });
      expect(docKey(result as RankInputs)).toEqual([1, 42, 24]);
    },
  },
  {
    id: "E8",
    title: "the clamp — industry months can never be less than skill months in that industry",
    check: () => {
      // He says "two years total" but the row says 36 months on the VMC. The clamp
      // takes the larger: a man cannot have less time in an industry than on a machine
      // that only exists in it.
      const rows = [row(VMC, 36)];
      const tenure = computeIndustryTenure(rows, 2, cfg.monthBucket);
      expect(tenureFor(tenure, MFG)).toBe(36);

      const result = candidate({ id: "clamped", rows, postedSkillIds: [VMC], jobIndustryId: MFG, totalYears: 2 });
      expect(docKey(result as RankInputs)).toEqual([1, 36, 36]);
      expect((result as RankInputs).industryMonths).toBeGreaterThanOrEqual(
        (result as RankInputs).skillMonths,
      );
    },
  },
  {
    id: "E9",
    title: "overlapping stints merge to 24 months, not 48",
    check: () => {
      // Two employers, the same 24-month window (a double-counted record, or a man on
      // two payrolls). Summing gives 48 and would be a lie.
      const stints = [
        { start: "2020-01-01", end: "2022-01-01" },
        { start: "2020-01-01", end: "2022-01-01" },
      ];
      expect(calendarMonthsOf(stints)).toBe(24);
      expect(mergeIntervals(stints)).toEqual([{ start: "2020-01-01", end: "2022-01-01" }]);

      // Partial overlap merges to the union, not the sum.
      const partial = [
        { start: "2020-01-01", end: "2021-07-01" }, // 18
        { start: "2021-01-01", end: "2022-01-01" }, // 12  -> sum 30, union 24
      ];
      expect(calendarMonthsOf(partial)).toBe(24);

      // Genuinely separate stints still add up.
      const disjoint = [
        { start: "2018-01-01", end: "2019-01-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ];
      expect(calendarMonthsOf(disjoint)).toBe(24);
      expect(mergeIntervals(disjoint)).toHaveLength(2);
    },
  },
  {
    id: "E10",
    title: "job-hopper and long-stayer with the same total produce identical keys",
    check: () => {
      // Six four-month stints, back to back, vs one 24-month stint.
      const hopper = [
        { start: "2020-01-01", end: "2020-05-01" },
        { start: "2020-05-01", end: "2020-09-01" },
        { start: "2020-09-01", end: "2021-01-01" },
        { start: "2021-01-01", end: "2021-05-01" },
        { start: "2021-05-01", end: "2021-09-01" },
        { start: "2021-09-01", end: "2022-01-01" },
      ];
      const stayer = [{ start: "2020-01-01", end: "2022-01-01" }];
      expect(calendarMonthsOf(hopper)).toBe(24);
      expect(calendarMonthsOf(stayer)).toBe(24);

      // Same months in, same key out. V1 does not punish a man for changing employer;
      // there is no "stability" column to punish him with.
      const a = candidate({ id: "hopper", rows: [row(VMC, 24)], postedSkillIds: [VMC], jobIndustryId: MFG });
      const b = candidate({ id: "stayer", rows: [row(VMC, 24)], postedSkillIds: [VMC], jobIndustryId: MFG });
      expect(docKey(a as RankInputs)).toEqual(docKey(b as RankInputs));
      // Identical on every key column; only the id separates them.
      expect(rankKeyCompare({ ...(a as RankInputs), id: "same" }, { ...(b as RankInputs), id: "same" }, cfg)).toBe(0);
      expect(order([b as RankInputs, a as RankInputs])).toEqual(["hopper", "stayer"]);
    },
  },
  {
    id: "E11",
    title: "a complete tie falls to the stable id tiebreak, never to chance",
    check: () => {
      const tied = ["delta", "alpha", "charlie", "bravo"].map((id) =>
        rank({ id, matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2026-01-01" }),
      );
      const expected = ["alpha", "bravo", "charlie", "delta"];
      expect(order(tied)).toEqual(expected);
      expect(order([...tied].reverse())).toEqual(expected);
      // Run it again: the same answer, because there is nothing else to consult.
      expect(order(tied)).toEqual(expected);
    },
  },
  {
    id: "E12",
    title: "nobody wants the posted skill — reach falls to related, then to zero",
    check: () => {
      const posted = [VMC];

      // Step 1: a man who HAS the VMC row but does not want that work is not supply.
      const unwilling = [row(VMC, 48, { wants: false })];
      expect(wantedSkillIds(unwilling)).toEqual([]);
      expect(matchTierFor(wantedSkillIds(unwilling), posted)).toBeNull();
      expect(candidate({ id: "unwilling", rows: unwilling, postedSkillIds: posted, jobIndustryId: MFG })).toBeNull();

      // Step 2: reach falls to the RELATED skills — a turner who wants the work.
      const turner = [row(TURNER, 24)];
      expect(matchTierFor(wantedSkillIds(turner), posted)).toBe(2);
      expect(candidate({ id: "turner", rows: turner, postedSkillIds: posted, jobIndustryId: MFG })).not.toBeNull();

      // Step 3: then zero. A carpenter is neither exact nor related.
      const carpenter = [row(CARPENTER, 120)];
      expect(matchTierFor(wantedSkillIds(carpenter), posted)).toBeNull();
      expect(candidate({ id: "carpenter", rows: carpenter, postedSkillIds: posted, jobIndustryId: MFG })).toBeNull();
    },
  },
  {
    id: "E13",
    title: "zero reach — the reach set exists, the supply does not",
    check: () => {
      const reach = resolveReachSet({ postedSkillIds: [CARPENTER], relatedDefault: cfg.relatedSkillsDefault });
      // The posting is well-formed: it has a reach set. Carpenter has no curated
      // relations, so the reach set is the posted skill alone.
      expect(reach.reachSkillIds).toEqual([CARPENTER]);
      expect(reach.suggestedRelatedIds).toEqual([]);

      // Nobody in this fleet can qualify, and the engine says so rather than padding.
      const fleet = [[row(VMC, 60)], [row(TURNER, 120)], [row(RIDER, 24, { industryId: QCOM })]];
      const candidates = fleet
        .map((rows, i) => candidate({ id: `w${i}`, rows, postedSkillIds: [CARPENTER], jobIndustryId: MFG }))
        .filter((c): c is RankInputs => c !== null);
      expect(candidates).toEqual([]);

      // integration: apps/api must return an EMPTY applicant list and tell the payer
      // plainly ("no one yet"), never widen the reach set to fill the page, and never
      // charge a boost against it (see `boostSupplyFloor`).
    },
  },
  {
    id: "E14",
    title: "the feed shows at most two consecutive cards from one company",
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
      // Nothing was dropped to achieve it.
      expect(out.map((r) => r.jobId).sort()).toEqual(feed.map((r) => r.jobId).sort());

      // DEGRADES HONESTLY: when one company owns the whole page the run is
      // unavoidable. The rule cannot conjure a second employer, so it emits the rows
      // in their original order rather than hiding any of them.
      const monopoly: FeedRow[] = ["m1", "m2", "m3", "m4"].map((jobId) => ({
        jobId, payerKey: "acme", boosted: false, publishedAt: "2026-07-01T00:00:00.000Z",
      }));
      const degraded = interleaveMaxPerCompany(monopoly, cfg.maxConsecutiveSameCompany);
      expect(degraded.map((r) => r.jobId)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(longestRun(degraded)).toBe(4);
    },
  },
  {
    id: "E15",
    title: "one application per (worker, job) — the engine cannot break a duplicate tie",
    check: () => {
      const a = rank({ id: "application-1", matchTier: 1, skillMonths: 24, industryMonths: 24 });
      const duplicate = { ...a };
      // Two rows carrying the same id are INDISTINGUISHABLE to the comparator: it
      // returns 0 and the order between them is undefined. That is the engine-level
      // statement of the rule — uniqueness cannot be established here.
      expect(rankKeyCompare(a, duplicate, cfg)).toBe(0);
      // A different id always resolves, so a genuinely distinct application never ties.
      expect(rankKeyCompare(a, { ...a, id: "application-2" }, cfg)).toBeLessThan(0);

      // integration: packages/db must carry UNIQUE(worker_id, job_posting_id) on
      // applications and apps/api must return the EXISTING application (idempotent)
      // rather than inserting a second one.
    },
  },
  {
    id: "E16",
    title: "inputs are frozen — the comparator reads the snapshot and nothing live",
    check: () => {
      const a = Object.freeze(rank({ id: "a", matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2024-01-01" }));
      const b = Object.freeze(rank({ id: "b", matchTier: 2, skillMonths: 48, industryMonths: 48, lastWorkedAt: "2019-01-01" }));

      // Frozen inputs: any attempt to mutate would throw in module strict mode.
      const first = rankKeyCompare(a, b, cfg);
      const second = rankKeyCompare(a, b, cfg);
      expect(second).toBe(first);
      expect([...[a, b].sort((x, y) => rankKeyCompare(x, y, cfg))].map((r) => r.id)).toEqual(["b", "a"]);
      expect(a).toEqual({ matchTier: 1, skillMonths: 24, industryMonths: 24, lastWorkedAt: "2024-01-01", createdAt: CREATED, id: "a" });

      // Time enters as DATA. An open-ended stint contributes 0 without an explicit
      // `asOf`; the package has no clock to fall back on.
      const ongoing = [{ start: "2020-01-01", end: null }];
      expect(calendarMonthsOf(ongoing)).toBe(0);
      expect(calendarMonthsOf(ongoing, "2022-01-01")).toBe(24);

      // integration: apps/api must SNAPSHOT months, tier and lastWorkedAt onto the
      // application row at apply time, so a payer's list cannot re-order under him
      // between two page loads.
    },
  },
  {
    id: "E17",
    title: "a one-tag worker is still reached, through the curated relation",
    check: () => {
      const reach = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: cfg.relatedSkillsDefault });
      expect(reach.suggestedRelatedIds.sort()).toEqual([HMC, SETTER, TURNER].sort());
      expect(reach.reachSkillIds).toContain(TURNER);

      // He has exactly ONE tag and it is not the posted skill. Without relations his
      // feed would be empty; with them he is a tier-2 candidate.
      const oneTag = [row(TURNER, 24)];
      const result = candidate({ id: "one-tag", rows: oneTag, postedSkillIds: [VMC], jobIndustryId: MFG });
      expect(docKey(result as RankInputs)).toEqual([2, 24, 24]);
    },
  },
  {
    id: "E18",
    title: "the related badge survives promotion — matchTier and effectiveTier are distinct",
    check: () => {
      const veteran = rank({ id: "veteran", matchTier: 2, skillMonths: 48, industryMonths: 48 });
      // Promoted for ORDERING...
      expect(effectiveTier(veteran.matchTier, veteran.skillMonths, cfg.tierFloorMonths)).toBe(1);
      // ...but the row still says what he actually is, so the card can read
      // "related skill: CNC Turner" instead of claiming he runs a VMC.
      expect(veteran.matchTier).toBe(2);

      const exact = rank({ id: "exact", matchTier: 1, skillMonths: 48, industryMonths: 48 });
      // Same effective tier, same months: they tie down to the id. The badge is a
      // LABEL, never a penalty — and never a promotion either.
      expect(rankKeyCompare({ ...veteran, id: "x" }, { ...exact, id: "x" }, cfg)).toBe(0);
    },
  },
];

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

describe("Matching V1 — the eighteen worked examples", () => {
  it("covers E1..E18 exactly once", () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual(
      Array.from({ length: 18 }, (_, i) => `E${i + 1}`),
    );
  });

  it.each(EXAMPLES)("$id — $title", ({ check }) => {
    check();
  });
});
