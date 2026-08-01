import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG, rankKeyCompare, type MatchConfig } from "@badabhai/match-engine";
import { MatchCandidatesService } from "./match-candidates.service";
import type { CandidateRow } from "./match-feed.repository";
import { OPS_LIST_CAP } from "../common/pagination";

/**
 * MOMENT ⑥ — the company's paid candidate list (ADR-0036 §2, E16/E18).
 *
 * The list is ORDERED BY THE SQL. What this service owns is the LABELLING of that
 * order, and the label is what a payer reads before spending ₹40 — so the tests here
 * are about the two things that make the list honest:
 *
 *   1. `effectiveTier` reproduces the owner's tier-with-floor ruling EXACTLY at the
 *      boundary (35 / 36 / 37 against a 36-month floor), from the CONFIG's floor and
 *      not a constant. A label that disagrees with the SQL's `CASE` would explain the
 *      list wrongly while looking perfectly plausible;
 *   2. the RAW `match_tier` survives promotion (E18) — a floor-promoted related-skill
 *      candidate must still be badged "related", because the company bought breadth
 *      and is entitled to see what it is looking at.
 *
 * The service must ALSO not re-sort. That is asserted directly, by handing it rows in
 * an order the rank key would not produce and requiring it to pass them through.
 */

const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CREATED = new Date("2026-07-20T08:00:00.000Z");

function candidate(id: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    applicationId: id,
    workerId: `w-${id}`,
    matchTier: 1,
    skillMonths: 24,
    industryMonths: 48,
    lastWorkedAt: "2026-06-01",
    createdAt: CREATED,
    engineVersion: "v1.0",
    matchedSkillId: "mskill_vmc_operator",
    ...over,
  };
}

function setup(rows: CandidateRow[], cfg: Partial<MatchConfig> = {}) {
  const repo = { listCandidates: vi.fn(async () => rows) };
  const config = { get: vi.fn(async () => ({ ...DEFAULT_MATCH_CONFIG, ...cfg })) };
  return { svc: new MatchCandidatesService(repo as never, config as never), repo, config };
}

describe("MatchCandidatesService — tier-with-floor at the boundary (owner ruling, E3)", () => {
  // The floor is 36 months. 35 is a related-skill man who has NOT cleared it; 36 is the
  // exact month he does. Getting this off by one either sells a payer a two-year
  // adjacent-trade man as an exact match, or buries a ten-year one.
  const FLOOR = DEFAULT_MATCH_CONFIG.tierFloorMonths;

  it("36 = the floor promotes into tier-1 ORDERING (>=, not >)", async () => {
    const { svc } = setup([candidate("a", { matchTier: 2, skillMonths: FLOOR })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.effectiveTier).toBe(1);
  });

  it("35 = one month short stays tier 2", async () => {
    const { svc } = setup([candidate("a", { matchTier: 2, skillMonths: FLOOR - 1 })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.effectiveTier).toBe(2);
  });

  it("37 = past the floor stays promoted", async () => {
    const { svc } = setup([candidate("a", { matchTier: 2, skillMonths: FLOOR + 1 })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.effectiveTier).toBe(1);
  });

  it("KEEPS the raw tier 2 across the boundary (E18 — the badge survives promotion)", async () => {
    const { svc } = setup([
      candidate("a", { matchTier: 2, skillMonths: FLOOR - 1 }),
      candidate("b", { matchTier: 2, skillMonths: FLOOR }),
      candidate("c", { matchTier: 2, skillMonths: FLOOR + 120 }),
    ]);
    const out = await svc.listForPosting(JOB);

    // Promotion changes the ORDER he competes in. It never changes what he actually is.
    expect(out.applicants.map((a) => a.matchTier)).toEqual([2, 2, 2]);
    expect(out.applicants.map((a) => a.effectiveTier)).toEqual([2, 1, 1]);
  });

  it("a tier-1 man is tier 1 at ZERO months (the floor only ever promotes)", async () => {
    const { svc } = setup([candidate("a", { matchTier: 1, skillMonths: 0 })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.effectiveTier).toBe(1);
  });

  it("UNKNOWN months never promote a related candidate (null is not 'enough')", async () => {
    // `skill_months IS NULL` means we never learned it. Treating unknown as clearing a
    // three-year floor would promote every coarse-history row into tier 1.
    const { svc } = setup([candidate("a", { matchTier: 2, skillMonths: null })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.effectiveTier).toBe(2);
  });

  it("treats any tier > 1 as related (a stray 3 does not slip past the floor)", async () => {
    const { svc } = setup([
      candidate("a", { matchTier: 3, skillMonths: FLOOR - 1 }),
      candidate("b", { matchTier: 3, skillMonths: FLOOR }),
    ]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants.map((a) => a.effectiveTier)).toEqual([2, 1]);
    expect(out.applicants.map((a) => a.matchTier)).toEqual([3, 3]);
  });

  it("a null tier yields a null tier — never a fabricated 1 or 2", async () => {
    const { svc } = setup([candidate("a", { matchTier: null, skillMonths: 120 })]);
    const out = await svc.listForPosting(JOB);
    expect(out.applicants[0]!.matchTier).toBeNull();
    expect(out.applicants[0]!.effectiveTier).toBeNull();
  });
});

describe("MatchCandidatesService — the floor is CONFIG, and the SQL gets the same one", () => {
  it("moves with the configured floor (24 promotes a 24-month related man)", async () => {
    const { svc } = setup(
      [
        candidate("a", { matchTier: 2, skillMonths: 23 }),
        candidate("b", { matchTier: 2, skillMonths: 24 }),
      ],
      { tierFloorMonths: 24 },
    );
    const out = await svc.listForPosting(JOB);
    // Under the default 36-month floor BOTH of these would be tier 2. The threshold is
    // ops-editable config (ADR-0036 §8), not a constant compiled into the service.
    expect(out.applicants.map((a) => a.effectiveTier)).toEqual([2, 1]);
  });

  it("passes THAT SAME floor to the query, so label and ORDER BY cannot disagree", async () => {
    const { svc, repo } = setup([], { tierFloorMonths: 24 });
    await svc.listForPosting(JOB);
    // The rank tuple exists twice (comparator + SQL). If the service labelled with 24
    // while the SQL sorted on 36, the list would be ordered by one rule and explained
    // by another — the exact failure the repository's parity note warns about.
    expect(repo.listCandidates).toHaveBeenCalledWith(JOB, 24, OPS_LIST_CAP);
  });
});

describe("MatchCandidatesService — the ORDER is the SQL's; this service only numbers it", () => {
  it("preserves the repository order even when it contradicts the rank key", async () => {
    // Deliberately upside down: a 6-month tier-1 man ahead of a 120-month tier-1 man.
    // The service must NOT 'fix' this — a second sort here would be a third
    // implementation of the rank rule, and the one nobody tests against the index.
    const rows = [
      candidate("low", { skillMonths: 6 }),
      candidate("high", { skillMonths: 120 }),
    ];
    const { svc } = setup(rows);
    const out = await svc.listForPosting(JOB);

    expect(out.applicants.map((a) => a.applicationId)).toEqual(["low", "high"]);
    expect(out.applicants.map((a) => a.rank)).toEqual([1, 2]);
  });

  it("echoes the posting id it was asked for", async () => {
    const { svc } = setup([]);
    const out = await svc.listForPosting(JOB);
    expect(out).toEqual({ jobId: JOB, applicants: [] });
  });
});

describe("MatchCandidatesService — the row a payer reads before paying", () => {
  it("passes the frozen snapshot through unchanged (E16: inputs, never a score)", async () => {
    const { svc } = setup([
      candidate("a", {
        skillMonths: 42,
        industryMonths: 60,
        lastWorkedAt: "2026-05-15",
        engineVersion: "v1.0",
      }),
    ]);
    const out = await svc.listForPosting(JOB);

    expect(out.applicants[0]).toMatchObject({
      skillMonths: 42,
      industryMonths: 60,
      lastWorkedAt: "2026-05-15",
      engineVersion: "v1.0",
    });
  });

  it("labels the matched skill, and returns null for one outside the closed set", async () => {
    const { svc } = setup([
      candidate("a", { matchedSkillId: "mskill_cnc_turner" }),
      candidate("b", { matchedSkillId: "mskill_not_a_real_skill" }),
      candidate("c", { matchedSkillId: null }),
    ]);
    const out = await svc.listForPosting(JOB);

    expect(out.applicants.map((a) => a.matchedSkillLabel)).toEqual(["CNC Turner", null, null]);
  });

  it("stays FACELESS — exactly the DTO keys, no name/phone/employer can ride along", async () => {
    const { svc } = setup([candidate("a")]);
    const out = await svc.listForPosting(JOB);

    expect(Object.keys(out.applicants[0]!).sort()).toEqual(
      [
        "applicationId",
        "effectiveTier",
        "engineVersion",
        "industryMonths",
        "lastWorkedAt",
        "matchTier",
        "matchedSkillLabel",
        "rank",
        "skillMonths",
        "workerId",
      ].sort(),
    );
  });
});

describe("MatchCandidatesService.toRankInputs — the null semantics the SQL encodes", () => {
  it("maps a NULL month count to -1, so unknown sorts BELOW a real zero", () => {
    const [unknown, zero] = MatchCandidatesService.toRankInputs([
      candidate("unknown", { skillMonths: null, industryMonths: null }),
      candidate("zero", { skillMonths: 0, industryMonths: 0 }),
    ]);

    expect(unknown!.skillMonths).toBe(-1);
    expect(unknown!.industryMonths).toBe(-1);
    // ...and the comparator must ACT on that: "we don't know" loses to a measured 0.
    // COALESCE(x, 0) in either place would make these tie and the order arbitrary.
    expect(rankKeyCompare(unknown!, zero!, DEFAULT_MATCH_CONFIG)).toBeGreaterThan(0);
  });

  it("carries createdAt through as the spec's last_active_at, and the id as stable_hash", () => {
    const [only] = MatchCandidatesService.toRankInputs([candidate("app-1")]);
    expect(only!.lastActiveAt).toBe(CREATED.toISOString());
    expect(only!.id).toBe("app-1");
  });

  it("normalises the tier so the comparator sees the same 1|2 the SQL's CASE does", () => {
    const mapped = MatchCandidatesService.toRankInputs([
      candidate("a", { matchTier: 1 }),
      candidate("b", { matchTier: 2 }),
      candidate("c", { matchTier: null }),
    ]);
    expect(mapped.map((m) => m.matchTier)).toEqual([1, 2, 2]);
  });

  it("re-sorting the mapped rows reproduces the floor boundary (comparator parity)", () => {
    // The same 35-vs-36 boundary, now through the COMPARATOR rather than the label: a
    // 36-month related man outranks a 12-month exact man, a 35-month one does not.
    const rows = [
      candidate("exact-12", { matchTier: 1, skillMonths: 12 }),
      candidate("related-35", { matchTier: 2, skillMonths: 35 }),
      candidate("related-36", { matchTier: 2, skillMonths: 36 }),
    ];
    const ordered = MatchCandidatesService.toRankInputs(rows)
      .slice()
      .sort((a, b) => rankKeyCompare(a, b, DEFAULT_MATCH_CONFIG))
      .map((r) => r.id);

    expect(ordered).toEqual(["related-36", "exact-12", "related-35"]);
  });
});
