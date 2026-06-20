import { describe, it, expect, afterEach } from "vitest";
import { uuidSchema } from "@badabhai/validators";
import {
  StubJobSource,
  createStubJobSourceOrThrow,
  jobSignalRowToJobSpec,
  JobsTableJobSource,
  type JobSource,
} from "./reach.job-source";
import { roleIdsForTradeKey } from "../resume/trade-content";
import type { JobSignalRow, ReachRepository } from "./reach.repository";
import { rankWorkersForJob, type WorkerSignals } from "@badabhai/reach-engine";
import { getTableColumns } from "drizzle-orm";
import { jobs } from "@badabhai/db";

describe("StubJobSource fixtures", () => {
  const source: JobSource = new StubJobSource();

  it("every fixture jobId parses as a UUID (guards the feed.shown.job_id contract, D6)", async () => {
    const jobs = await source.listOpenJobSpecs();
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      // feed.shown.job_id validates as uuidSchema — a non-UUID stub id would throw
      // at createEvent. Each fixture id MUST pass.
      expect(uuidSchema.safeParse(j.jobId).success).toBe(true);
    }
  });

  it("getJobSpec returns the matching fixture, null for an unknown id", async () => {
    const jobs = await source.listOpenJobSpecs();
    const first = jobs[0]!;
    const found = await source.getJobSpec(first.jobId);
    expect(found?.jobId).toBe(first.jobId);
    expect(await source.getJobSpec("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("fixtures carry ONLY JobSpec fields — no employer name/contact (faceless)", async () => {
    const jobs = await source.listOpenJobSpecs();
    const allowed = new Set([
      "jobId",
      "roleIds",
      "location",
      "city",
      "maxTravelKm",
      "minExperienceYears",
      "maxExperienceYears",
      "payMin",
      "payMax",
      "neededBy",
    ]);
    for (const j of jobs) {
      for (const key of Object.keys(j)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it("returns defensive copies (callers can't mutate the shared fixtures)", async () => {
    const a = await source.listOpenJobSpecs();
    a[0]!.roleIds.push("tampered");
    const b = await source.listOpenJobSpecs();
    expect(b[0]!.roleIds).not.toContain("tampered");
  });
});

describe("createStubJobSourceOrThrow — D6 production gate", () => {
  const prev = process.env.NODE_ENV;

  // Restore NODE_ENV after each case so env never leaks into other tests.
  afterEach(() => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it("builds the stub in development/test (dev shortcut allowed)", () => {
    process.env.NODE_ENV = "test";
    expect(createStubJobSourceOrThrow()).toBeInstanceOf(StubJobSource);
  });

  it("THROWS in production — the stub must never silently serve fixtures", () => {
    process.env.NODE_ENV = "production";
    expect(() => createStubJobSourceOrThrow()).toThrow();
  });

  it("THROWS when NODE_ENV is unset (fail-closed via isDevEnv)", () => {
    delete process.env.NODE_ENV;
    expect(() => createStubJobSourceOrThrow()).toThrow();
  });
});

const JID = "a1f0c0de-0003-4a00-8000-000000000003";

function makeRow(over: Partial<JobSignalRow> = {}): JobSignalRow {
  return {
    jobId: JID,
    tradeKey: "vmc_operator",
    city: "Rajkot",
    payMin: 18000,
    payMax: 28000,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: "immediate",
    ...over,
  };
}

describe("jobSignalRowToJobSpec — faceless row→JobSpec mapper (ADR-0011 real jobs)", () => {
  it("maps a machining trade to the bridge's taxonomy role ids (Role factor can match)", () => {
    const spec = jobSignalRowToJobSpec(makeRow({ tradeKey: "vmc_operator" }));
    expect(spec.roleIds).toEqual(roleIdsForTradeKey("vmc_operator"));
    // The worker's canonical_role_id is `role_*`; the bridge must yield that form.
    expect(spec.roleIds).toContain("role_vmc_operator");
    expect(spec.roleIds.length).toBeGreaterThan(0);
  });

  it("maps a non-machining trade to [] (no Phase-1 worker role — correctly unmatched)", () => {
    const spec = jobSignalRowToJobSpec(makeRow({ tradeKey: "fitter" }));
    expect(spec.roleIds).toEqual([]);
  });

  it("passes the coarse city slug through (engine Distance uses the city-slug fallback)", () => {
    const spec = jobSignalRowToJobSpec(makeRow({ city: "Pune" }));
    expect(spec.city).toBe("Pune");
    // No coordinates are stored/derived — the engine neutral-handles a missing centroid.
    expect(spec.location).toBeUndefined();
  });

  it("turns NULL pay/experience/neededBy into undefined (engine neutral-defaults)", () => {
    const spec = jobSignalRowToJobSpec(
      makeRow({ payMin: null, payMax: null, minExperienceYears: null, maxExperienceYears: null, neededBy: null }),
    );
    expect(spec.payMin).toBeUndefined();
    expect(spec.payMax).toBeUndefined();
    expect(spec.minExperienceYears).toBeUndefined();
    expect(spec.maxExperienceYears).toBeUndefined();
    expect(spec.neededBy).toBeUndefined();
  });

  it("carries the real signal values when present", () => {
    const spec = jobSignalRowToJobSpec(makeRow());
    expect(spec.payMin).toBe(18000);
    expect(spec.payMax).toBe(28000);
    expect(spec.minExperienceYears).toBe(2);
    expect(spec.maxExperienceYears).toBe(5);
    expect(spec.neededBy).toBe("immediate");
  });

  it("FACELESS (TD36c): the JobSpec exposes ONLY engine fields — no title/area/payer_id", () => {
    // Even if a row were somehow handed extra keys, the mapper reads only the
    // projected signal fields, so the JobSpec can never carry free text / a payer link.
    const spec = jobSignalRowToJobSpec(
      makeRow({ title: "ACME Tools — VMC", area: "GIDC", payerId: "p-1" } as Partial<JobSignalRow>),
    );
    const allowed = new Set([
      "jobId",
      "roleIds",
      "location",
      "city",
      "maxTravelKm",
      "minExperienceYears",
      "maxExperienceYears",
      "payMin",
      "payMax",
      "neededBy",
    ]);
    for (const key of Object.keys(spec)) expect(allowed.has(key)).toBe(true);
    expect(Object.keys(spec)).not.toContain("title");
    expect(Object.keys(spec)).not.toContain("area");
    expect(Object.keys(spec)).not.toContain("payerId");
  });
});

describe("JobsTableJobSource — serves the real jobs table via the faceless projection", () => {
  const rows: JobSignalRow[] = [
    makeRow({ jobId: JID, tradeKey: "vmc_operator" }),
    makeRow({ jobId: "a1f0c0de-0006-4a00-8000-000000000006", tradeKey: "cnc_programmer", city: "Bengaluru" }),
  ];
  const fakeRepo = {
    listOpenJobSignalRows: async () => rows,
    findJobSignalRowById: async (id: string) => rows.find((r) => r.jobId === id),
  } as unknown as ReachRepository;
  const source = new JobsTableJobSource(fakeRepo);

  it("listOpenJobSpecs maps every open row to a JobSpec (count in == count out)", async () => {
    const specs = await source.listOpenJobSpecs();
    expect(specs).toHaveLength(rows.length);
    expect(specs.map((s) => s.jobId)).toEqual(rows.map((r) => r.jobId));
    for (const s of specs) expect(uuidSchema.safeParse(s.jobId).success).toBe(true);
  });

  it("getJobSpec maps the matching row, null for an unknown id", async () => {
    const found = await source.getJobSpec(JID);
    expect(found?.jobId).toBe(JID);
    expect(found?.roleIds).toContain("role_vmc_operator");
    expect(await source.getJobSpec("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

// ============================================================================
// BOOST-INERT — posting boost is DATA-ONLY and never enters ranking.
//
// ADR-0013 ("pricing/boost never rank"); ADR-0011/0012 defer boost ranking. Boost
// lives ONLY in `posting_boosts` (on `job_postings`) + the `job_posting.boosted`
// event — never on the `jobs` demand-side source, never in the `JobSignalRow`
// projection, never in `jobSignalRowToJobSpec`. These tests LOCK that a posting's
// boost can change NEITHER the rank vector NOR floor membership (hot/pushEligible),
// because there is no channel for it to reach the engine. This is the deferral
// guard — it does NOT implement boost ranking.
// ============================================================================
describe("BOOST-INERT — posting boost never reaches the RANK core (ADR-0013 deferral lock)", () => {
  it("the demand-side `jobs` table has NO boost column (boost cannot enter JobSignalRow)", () => {
    // The faceless JobSignalRow projects from `jobs`; if `jobs` grew a boost column a
    // future projection could leak it into a JobSpec. Lock it at the source: `jobs`
    // carries no boost field at all (boost lives on its OWN table, `posting_boosts`).
    const cols = Object.values(getTableColumns(jobs)).map((c) => c.name.toLowerCase());
    for (const c of cols) {
      expect(c, `jobs.${c} must not be a boost signal`).not.toContain("boost");
    }
  });

  it("the row→JobSpec mapper ignores any boost-ish fields (no boost channel exists)", () => {
    const plain = jobSignalRowToJobSpec(makeRow({ tradeKey: "vmc_operator" }));
    // Even if a row were somehow handed boost fields, the mapper reads only the
    // projected demand signals — so the JobSpec is byte-identical and carries no boost.
    const withBoost = jobSignalRowToJobSpec({
      ...makeRow({ tradeKey: "vmc_operator" }),
      boost_tier: "all_candidates",
      boosted: true,
      boost_ends_at: "2026-12-31T00:00:00Z",
    } as unknown as JobSignalRow);
    expect(withBoost).toEqual(plain);
    for (const k of Object.keys(withBoost)) {
      expect(k.toLowerCase(), `JobSpec.${k} must not be a boost field`).not.toContain("boost");
    }
  });

  it("toggling a posting's boost changes NEITHER the rank vector NOR floor membership", () => {
    // A fixed, mixed pool: on-trade above-floor, on-trade weaker, and an off-trade
    // worker (role_* form; jobs map trade_key → role_* via roleIdsForTradeKey).
    const pool: WorkerSignals[] = [
      {
        workerId: "w-on-strong",
        roleId: "role_vmc_operator",
        city: "Rajkot",
        lastActiveDaysAgo: 1,
        availability: "immediate",
        experienceYears: 4,
        expectedSalary: 18000,
      },
      { workerId: "w-on-weak", roleId: "role_vmc_operator", city: "Mumbai", lastActiveDaysAgo: 45 },
      {
        workerId: "w-off",
        roleId: "role_unrelated_trade",
        city: "Mumbai",
        lastActiveDaysAgo: 90,
        availability: "not_looking",
        expectedSalary: 999999,
      },
    ];
    const baseSpec = jobSignalRowToJobSpec(makeRow({ tradeKey: "vmc_operator", city: "Rajkot" }));
    const boostedSpec = jobSignalRowToJobSpec({
      ...makeRow({ tradeKey: "vmc_operator", city: "Rajkot" }),
      boost_tier: "all_candidates",
      boosted: true,
    } as unknown as JobSignalRow);

    const a = rankWorkersForJob(baseSpec, pool);
    const b = rankWorkersForJob(boostedSpec, pool);
    // Identical rank vector (order) …
    expect(b.map((r) => r.workerId)).toEqual(a.map((r) => r.workerId));
    // … and identical floor membership (the hot + pushEligible sets are unchanged).
    expect(b.map((r) => r.hot)).toEqual(a.map((r) => r.hot));
    expect(b.map((r) => r.pushEligible)).toEqual(a.map((r) => r.pushEligible));
  });
});
