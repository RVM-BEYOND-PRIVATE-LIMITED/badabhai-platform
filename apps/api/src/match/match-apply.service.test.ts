import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import { MatchApplyService, type RankSnapshot } from "./match-apply.service";

/**
 * MOMENT ⑤ — "Worker swipes apply" (ADR-0036 §5, spec Part 6).
 *
 * This is the one irreversible moment in V1: the rank inputs are snapshotted onto the
 * application and FROZEN (E16). A snapshot that is computed wrongly, or that is quietly
 * recomputed later, cannot be detected downstream — the list still renders, it is just
 * ordered by numbers that no longer describe the decision anyone made. So the
 * assertions below are on the NUMBERS, and the engine (`skillMonthsFor`) is the real
 * one: stubbing it would let this suite pass while every stored snapshot was wrong.
 *
 * `skillMonthsFor` and `matchSkillIndustry` are pure, so they are used, not mocked. The
 * stub boundary is the database.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const VMC = "mskill_vmc_operator";
const TURNER = "mskill_cnc_turner"; // curated RELATED of the VMC
const HMC = "mskill_hmc_operator"; // curated RELATED of the VMC
const RIDER = "mskill_delivery_rider"; // a different industry, and NO relations at all
const MFG = "ind_industrial_manufacturing";
const QCOM = "ind_quick_commerce";

type SkillRow = { skillId: string; industryId: string; monthsBucketed: number; wants: boolean };

function row(skillId: string, monthsBucketed: number, industryId = MFG): SkillRow {
  return { skillId, industryId, monthsBucketed, wants: true };
}

function setup(opts: {
  reach?: { matchTier: 1 | 2; matchedSkillId: string } | undefined;
  posting?: { matchSkillIds: string[]; reachSkillIds: string[] } | undefined;
  rows?: SkillRow[];
  industryMonths?: number;
  config?: Partial<MatchConfig>;
} = {}) {
  const cfg: MatchConfig = { ...DEFAULT_MATCH_CONFIG, ...opts.config };
  const reach = "reach" in opts ? opts.reach : { matchTier: 1 as const, matchedSkillId: VMC };
  const posting =
    "posting" in opts ? opts.posting : { matchSkillIds: [VMC], reachSkillIds: [VMC, TURNER, HMC] };

  const skills = {
    findReachRow: vi.fn(async () => reach),
    findPostingSkillSets: vi.fn(async () => posting),
    listSkillRows: vi.fn(async () => opts.rows ?? [row(VMC, 24)]),
    findIndustryMonths: vi.fn(async (_workerId: string, _industryId: string) =>
      opts.industryMonths ?? 0,
    ),
  };
  const config = { get: vi.fn(async () => cfg) };
  const db = { execute: vi.fn(), select: vi.fn() };

  const svc = new MatchApplyService(db as never, skills as never, config as never);
  return { svc, skills, config, db, cfg };
}

describe("buildSnapshot — the reach row is the gate and the 404 carries no oracle", () => {
  it("404s identically for 'never reached you' and 'no such posting'", async () => {
    const noReach = await setup({ reach: undefined })
      .svc.buildSnapshot(WORKER, POSTING)
      .catch((e: unknown) => e);
    const noPosting = await setup({ posting: undefined })
      .svc.buildSnapshot(WORKER, POSTING)
      .catch((e: unknown) => e);

    // A worker who can tell "this posting exists but excluded me" from "this posting
    // does not exist" can enumerate the whole board by id. The two bodies must be
    // byte-identical, not merely both 404.
    expect(noReach).toBeInstanceOf(NotFoundException);
    expect(noPosting).toBeInstanceOf(NotFoundException);
    expect((noReach as NotFoundException).message).toBe("Job not found");
    expect((noReach as NotFoundException).message).toBe(
      (noPosting as NotFoundException).message,
    );
    expect((noReach as NotFoundException).getResponse()).toEqual(
      (noPosting as NotFoundException).getResponse(),
    );
  });

  it("does not even look the posting up when there is no reach row", async () => {
    const d = setup({ reach: undefined });
    await expect(d.svc.buildSnapshot(WORKER, POSTING)).rejects.toBeInstanceOf(NotFoundException);
    // The gate is the reach row. Reading further would be work done for a worker who
    // was never shown the job.
    expect(d.skills.findPostingSkillSets).not.toHaveBeenCalled();
    expect(d.skills.listSkillRows).not.toHaveBeenCalled();
  });
});

describe("buildSnapshot — E5/E6: WHICH skill's months are snapshotted", () => {
  it("E5 — a multi-skill posting takes the MAX across the posted skills he holds, not a sum", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC, TURNER], reachSkillIds: [VMC, TURNER, HMC] },
      reach: { matchTier: 1, matchedSkillId: TURNER },
      rows: [row(VMC, 12), row(TURNER, 60)],
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // He is hired for ONE of them. 72 would be a fabricated career.
    expect(snap.skillMonths).toBe(60);
  });

  it("E6 — a tier-1 match counts the EXACT skill's months even when a related skill is longer", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC, TURNER, HMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      rows: [row(VMC, 6), row(TURNER, 120)],
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // 120 here would sell the payer ten years on a lathe as ten years on a VMC.
    expect(snap.skillMonths).toBe(6);
  });

  it("E6 — a tier-2 match counts the RELATED skill he actually matched on", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC, TURNER, HMC] },
      reach: { matchTier: 2, matchedSkillId: TURNER },
      rows: [row(TURNER, 24), row(HMC, 6)],
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    expect(snap.skillMonths).toBe(24);
  });

  it("E7 — the same skill in two industries SUMS (turning is turning)", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      rows: [row(VMC, 18), row(VMC, 24, QCOM)],
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    expect(snap.skillMonths).toBe(42);
  });

  it("months a worker holds in an UNPOSTED, UNRELATED trade contribute nothing (E1)", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC, TURNER, HMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      rows: [row(VMC, 6), row(RIDER, 240, QCOM)],
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // Twenty years of delivery is twenty years of delivery. It is not machining time.
    expect(snap.skillMonths).toBe(6);
  });
});

describe("buildSnapshot — industry months come from the MATCHED skill's industry (E8)", () => {
  it("looks tenure up under the matched skill's industry, not a hard-coded one", async () => {
    const d = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      industryMonths: 90,
      rows: [row(VMC, 24)],
    });
    await d.svc.buildSnapshot(WORKER, POSTING);
    expect(d.skills.findIndustryMonths).toHaveBeenCalledWith(WORKER, MFG);
  });

  it("follows the matched skill into a DIFFERENT industry", async () => {
    const d = setup({
      posting: { matchSkillIds: [RIDER], reachSkillIds: [RIDER] },
      reach: { matchTier: 1, matchedSkillId: RIDER },
      rows: [row(RIDER, 24, QCOM)],
      industryMonths: 30,
    });
    const snap = await d.svc.buildSnapshot(WORKER, POSTING);
    // Reading the posting's own industry column instead would credit a rider with
    // manufacturing tenure the moment a legacy posting was converted.
    expect(d.skills.findIndustryMonths).toHaveBeenCalledWith(WORKER, QCOM);
    expect(snap.industryMonths).toBe(30);
  });

  it("clamps industry months UP to skill months (invariant B's floor)", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      rows: [row(VMC, 60)],
      industryMonths: 6,
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // You cannot have sixty months on a VMC and six months in manufacturing. Left
    // unclamped, a stale tenure row would sort a veteran below a novice on key #3.
    expect(snap.industryMonths).toBe(60);
  });

  it("keeps a LARGER industry tenure (the clamp is a floor, never a ceiling)", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC] },
      reach: { matchTier: 1, matchedSkillId: VMC },
      rows: [row(VMC, 60)],
      industryMonths: 144,
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    expect(snap.industryMonths).toBe(144);
  });

  it("a legacy non-vocabulary matched skill queries no tenure and falls back to skill months", async () => {
    const d = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC] },
      reach: { matchTier: 1, matchedSkillId: "legacy_trade_key" },
      rows: [row(VMC, 18)],
      industryMonths: 999,
    });
    const snap = await d.svc.buildSnapshot(WORKER, POSTING);
    expect(d.skills.findIndustryMonths).not.toHaveBeenCalled();
    expect(snap.industryMonths).toBe(18);
  });
});

describe("buildSnapshot — the frozen fields are the RAW inputs, never a decision", () => {
  it("carries the RAW match_tier: the floor promotion belongs to ordering, not the row (E18)", async () => {
    const { svc } = setup({
      posting: { matchSkillIds: [VMC], reachSkillIds: [VMC, TURNER] },
      reach: { matchTier: 2, matchedSkillId: TURNER },
      rows: [row(TURNER, 120)], // 120 >= tierFloorMonths (36): he ORDERS as tier 1…
      config: { tierFloorMonths: 36 },
    });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // …but he is still a RELATED match, and the company paying ₹40 must see that badge.
    // Storing 1 here would make the E18 badge unrecoverable from history forever.
    expect(snap.matchTier).toBe(2);
    expect(snap.skillMonths).toBe(120);
  });

  it("stamps the engine version from CONFIG, so a rank is always replayable", async () => {
    const { svc } = setup({ config: { engineVersion: "v9.9-test" } });
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    // A hard-coded "v1.0" would silently mislabel every application written after the
    // next rule change — and the replay corpus is the one thing V1 cannot rebuild.
    expect(snap.engineVersion).toBe("v9.9-test");
  });

  it("records last_worked_at as NULL at launch (E4 duration-unknown), never a fabricated date", async () => {
    const { svc } = setup();
    const snap = await svc.buildSnapshot(WORKER, POSTING);
    expect(snap.lastWorkedAt).toBeNull();
  });
});

/* ─────────────────────────── upsertDecision ─────────────────────────── */

/** Chunks of a drizzle `sql` template: string fragments, or a bound value. */
function isTextChunk(c: unknown): c is { value: string[] } {
  return typeof c === "object" && c !== null && Array.isArray((c as { value?: unknown }).value);
}

function statementOf(db: { execute: ReturnType<typeof vi.fn> }): {
  text: string;
  params: unknown[];
} {
  const arg = db.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] } | undefined;
  const chunks = arg?.queryChunks ?? [];
  return {
    text: chunks
      .map((c) => (isTextChunk(c) ? c.value.join("") : " ? "))
      .join("")
      .replace(/\s+/g, " "),
    params: chunks.filter((c) => !isTextChunk(c)),
  };
}

const SNAPSHOT: RankSnapshot = {
  matchTier: 1,
  skillMonths: 60,
  industryMonths: 72,
  lastWorkedAt: null,
  engineVersion: "v1.0",
};

function applySetup(returning: Record<string, unknown>[]) {
  const db = { execute: vi.fn(async () => returning), select: vi.fn() };
  const svc = new MatchApplyService(db as never, { } as never, { } as never);
  return { svc, db };
}

const STORED = {
  id: "33333333-3333-4333-8333-333333333333",
  inserted: true,
  match_tier: 2,
  skill_months: 6,
  industry_months: 12,
  last_worked_at: "2024-03-01",
  engine_version: "v0.9",
};

describe("upsertDecision — one statement, no read-then-write (the E16 race guard)", () => {
  it("issues exactly ONE statement and never re-reads the row first", async () => {
    const { svc, db } = applySetup([STORED]);
    await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 3,
      snapshot: SNAPSHOT,
      previousAction: null,
    });
    // Deciding the flip in TypeScript would race two concurrent applies and could
    // rewrite a frozen snapshot between the read and the write.
    expect(db.execute).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("binds all five snapshot columns, in order, into the INSERT", async () => {
    const { svc, db } = applySetup([STORED]);
    await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: "wants_it",
      sourceSurface: "feed",
      rank: 3,
      snapshot: SNAPSHOT,
      previousAction: null,
    });
    // A dropped column here writes NULL rank inputs onto a real application, and the
    // replay corpus loses that row permanently.
    expect(statementOf(db).params).toEqual([
      WORKER,
      POSTING,
      "applied",
      "wants_it",
      "feed",
      3,
      1, // match_tier
      60, // skill_months
      72, // industry_months
      null, // last_worked_at
      "v1.0", // engine_version
    ]);
  });

  it("binds NULLs for the snapshot when there is none (a skip carries no rank inputs)", async () => {
    const { svc, db } = applySetup([{ ...STORED, match_tier: null, engine_version: null }]);
    await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "skipped",
      reason: null,
      sourceSurface: "feed",
      rank: null,
      snapshot: null,
      previousAction: null,
    });
    expect(statementOf(db).params.slice(6)).toEqual([null, null, null, null, null]);
  });

  it("guards EVERY snapshot column behind the skip→apply flip CASE", async () => {
    const { svc, db } = applySetup([STORED]);
    await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 1,
      snapshot: SNAPSHOT,
      previousAction: "skipped",
    });

    // SHAPE GUARD, not a semantic one: what the CASE actually DOES on conflict can only
    // be proven against Postgres (rank-parity.test.ts owns that). What this catches is a
    // column quietly losing its guard — after which a re-apply would overwrite a frozen
    // snapshot, which is exactly what E16 forbids.
    const { text } = statementOf(db);
    for (const col of [
      "match_tier",
      "skill_months",
      "industry_months",
      "last_worked_at",
      "engine_version",
    ]) {
      expect(
        text,
        `${col} must be written only on a skip→apply flip`,
      ).toContain(
        `${col} = CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied' THEN EXCLUDED.${col} ELSE applications.${col} END`,
      );
    }
  });
});

describe("upsertDecision — the returned snapshot is the STORED row, never the input (E16)", () => {
  it("reports what the database kept, even when the caller passed different numbers", async () => {
    const { svc } = applySetup([STORED]);
    const out = await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 1,
      // A re-apply computed FRESH inputs off a profile the worker has since edited…
      snapshot: { matchTier: 1, skillMonths: 120, industryMonths: 120, lastWorkedAt: "2026-07-31", engineVersion: "v1.0" },
      previousAction: "applied",
    });

    // …and the row the company already paid to see does not move. Echoing the input
    // here would make the whole freeze cosmetic while every test still passed.
    expect(out.snapshot).toEqual({
      matchTier: 2,
      skillMonths: 6,
      industryMonths: 12,
      lastWorkedAt: "2024-03-01",
      engineVersion: "v0.9",
    });
    expect(out.applicationId).toBe(STORED.id);
  });

  it("returns NO snapshot for a row that never carried one", async () => {
    const { svc } = applySetup([{ ...STORED, match_tier: null, engine_version: null }]);
    const out = await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "skipped",
      reason: null,
      sourceSurface: "feed",
      rank: null,
      snapshot: null,
      previousAction: null,
    });
    // Null, not a zero-filled snapshot: "no decision was ranked" and "ranked at zero
    // months" are different facts, and the replay corpus has to tell them apart.
    expect(out.snapshot).toBeNull();
  });

  it("treats a row missing its engine_version as unsnapshotted (an unreplayable rank is no rank)", async () => {
    const { svc } = applySetup([{ ...STORED, engine_version: null }]);
    const out = await svc.upsertDecision({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: null,
      snapshot: SNAPSHOT,
      previousAction: null,
    });
    expect(out.snapshot).toBeNull();
  });

  it("reads a half-written row's missing months as ZERO, never undefined", async () => {
    const { svc } = applySetup([
      { ...STORED, match_tier: 1, skill_months: null, industry_months: null, last_worked_at: null },
    ]);
    const out = await svc.upsertDecision({
      workerId: WORKER, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: null, snapshot: SNAPSHOT, previousAction: null,
    });
    // `undefined` months reach `rankKeyCompare` as NaN deltas, and a comparator that
    // returns NaN gives a different order on every sort. Zero is the honest floor.
    expect(out.snapshot).toEqual({
      matchTier: 1,
      skillMonths: 0,
      industryMonths: 0,
      lastWorkedAt: null,
      engineVersion: STORED.engine_version,
    });
  });

  it("normalises the stored tier to the 1|2 domain", async () => {
    const one = await applySetup([{ ...STORED, match_tier: 1 }]).svc.upsertDecision({
      workerId: WORKER, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: null, snapshot: SNAPSHOT, previousAction: null,
    });
    const other = await applySetup([{ ...STORED, match_tier: 7 }]).svc.upsertDecision({
      workerId: WORKER, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: null, snapshot: SNAPSHOT, previousAction: null,
    });
    expect(one.snapshot?.matchTier).toBe(1);
    // Anything that is not an exact match is a related match — never a third tier that
    // `effectiveTier` and the feed's ORDER BY would disagree about.
    expect(other.snapshot?.matchTier).toBe(2);
  });

  it("reports `inserted` from the row, and a flip only from a NON-applied previous action", async () => {
    const cases: { previous: string | null; flipped: boolean }[] = [
      { previous: null, flipped: false }, // brand new row: an insert, not a flip
      { previous: "skipped", flipped: true }, // the one genuine flip
      { previous: "applied", flipped: false }, // a double tap re-decides nothing
    ];
    for (const c of cases) {
      const { svc } = applySetup([{ ...STORED, inserted: false }]);
      const out = await svc.upsertDecision({
        workerId: WORKER, jobPostingId: POSTING, action: "applied", reason: null,
        sourceSurface: "feed", rank: null, snapshot: SNAPSHOT, previousAction: c.previous,
      });
      expect(out.flippedToApplied, `previous=${c.previous ?? "none"}`).toBe(c.flipped);
      expect(out.inserted).toBe(false);
    }
  });

  it("throws rather than reporting a success when the statement returned nothing", async () => {
    const { svc } = applySetup([]);
    await expect(
      svc.upsertDecision({
        workerId: WORKER, jobPostingId: POSTING, action: "applied", reason: null,
        sourceSurface: "feed", rank: null, snapshot: SNAPSHOT, previousAction: null,
      }),
    ).rejects.toThrow(/Failed to upsert/);
  });
});

describe("findDecision — the caller's pre-read", () => {
  function chainSetup(rows: { id: string; action: string }[]) {
    const limit = vi.fn(async () => rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })), execute: vi.fn() };
    const svc = new MatchApplyService(db as never, {} as never, {} as never);
    return { svc, limit };
  }

  it("returns the existing decision", async () => {
    const { svc, limit } = chainSetup([{ id: STORED.id, action: "skipped" }]);
    await expect(svc.findDecision(WORKER, POSTING)).resolves.toEqual({
      id: STORED.id,
      action: "skipped",
    });
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("returns undefined when the worker has never decided on the posting", async () => {
    const { svc } = chainSetup([]);
    await expect(svc.findDecision(WORKER, POSTING)).resolves.toBeUndefined();
  });
});
