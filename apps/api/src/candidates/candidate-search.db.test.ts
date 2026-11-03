import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { MatchConfigService } from "../match/match-config.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { decodeCandidateCursor } from "./candidate-search.cursor";
import { CandidateSearchRepository } from "./candidate-search.repository";
import { CandidateSearchService } from "./candidate-search.service";
import { CandidateSearchSchema, type CandidateSearchInput } from "./candidate-search.dto";

/**
 * `POST /payer/candidates/search` AGAINST POSTGRES — the E2 invariant, executed:
 *
 *   a worker who has not consented to `employer_sharing` never appears in a candidate search
 *   result, in either mode, and is never counted in `matched` or in `total`.
 *
 * …and its siblings: `wants = false` skills are invisible, a leaving or suspended worker is
 * absent, the LATEST consent row decides (the E0 exit appends a row rather than revoking), the
 * order is the documented total order at every page size, and an unrecorded city/tenure excludes
 * nobody. SEEDED LOCAL DATA ONLY (R-E4): a count here is a fact about this fixture.
 *
 * The pool is GLOBAL, so this database may hold other rows. Every count is asserted as a DELTA
 * against a baseline taken before the fixture is written (CI runs DB suites with
 * `--no-file-parallelism`, so nothing else writes meanwhile), and every membership/order claim is
 * made over the fixture's own ids inside a full walk of every page.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/**
 * This file WRITES fixture rows, and the repo-root env file points `DATABASE_URL` at PRODUCTION,
 * so the suite refuses any host but a local one before it touches anything.
 */
function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`candidate-search.db refuses to write to a non-local database host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const PAYER = randomUUID();
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `cand-db-${TAG}` };

type Consent = { purposes: string[]; revoked?: boolean; ageDays: number };
interface Fixture {
  status?: "active" | "pending" | "suspended";
  leaving?: boolean;
  city: string | null;
  consents: Consent[];
  skills: { id: string; months: number; wants?: boolean }[];
  tenure?: { industry: string; months: number }[];
}

const SHARING = ["profiling", "resume_generation", "employer_sharing"];
const MFG = "ind_industrial_manufacturing";
const QC = "ind_quick_commerce";
const TURNER = "mskill_cnc_turner";
const VMC = "mskill_vmc_operator"; // related to TURNER (relatedMatchSkills)
const TIG = "mskill_tig_welder";
const RIDER = "mskill_delivery_rider";
/** Every ineligible fixture lives here, so the city facet can prove it never leaks them. */
const INELIGIBLE_CITY = "Nagpur";

const FIXTURES = {
  // ── ELIGIBLE (8) ──────────────────────────────────────────────────────────────────────────
  turner: {
    city: "Pune",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TURNER, months: 48 }],
    tenure: [{ industry: MFG, months: 60 }],
  },
  turnerOld: {
    city: "Chennai",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TURNER, months: 12 }],
    tenure: [{ industry: MFG, months: 12 }],
  },
  twoRoles: {
    status: "pending",
    city: "Mumbai",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [
      { id: TURNER, months: 6 },
      { id: VMC, months: 30 },
    ],
    tenure: [{ industry: MFG, months: 36 }],
  },
  vmcVeteran: {
    city: "pune ", // a raw spelling the city filter must still resolve to Pune
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: VMC, months: 48 }],
    tenure: [{ industry: MFG, months: 50 }],
  },
  vmc: {
    city: null, // unrecorded city
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: VMC, months: 24 }],
    // no tenure row: unrecorded industry tenure
  },
  welder: {
    city: "Pune",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TIG, months: 60 }],
    tenure: [{ industry: MFG, months: 66 }],
  },
  unwantedTurner: {
    city: "Delhi",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [
      { id: TURNER, months: 60, wants: false }, // turned off: must be invisible
      { id: TIG, months: 30 },
    ],
    tenure: [{ industry: MFG, months: 24 }],
  },
  rider: {
    city: "Pune",
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: RIDER, months: 24 }],
    tenure: [{ industry: QC, months: 24 }],
  },
  // ── INELIGIBLE (8) — each one a separate way to be outside the pool ─────────────────────
  noConsent: { city: INELIGIBLE_CITY, consents: [], skills: [{ id: TURNER, months: 120 }] },
  profilingOnly: {
    city: INELIGIBLE_CITY,
    consents: [{ purposes: ["profiling"], ageDays: 1 }],
    skills: [{ id: TURNER, months: 120 }],
  },
  revoked: {
    city: INELIGIBLE_CITY,
    consents: [{ purposes: SHARING, revoked: true, ageDays: 1 }],
    skills: [{ id: TURNER, months: 120 }],
  },
  optedOut: {
    // The E0 exit APPENDS a newer row without employer_sharing and leaves the old one unrevoked.
    city: INELIGIBLE_CITY,
    consents: [
      { purposes: SHARING, ageDays: 10 },
      { purposes: ["profiling", "resume_generation"], ageDays: 1 },
    ],
    skills: [{ id: TURNER, months: 120 }],
  },
  wantsOff: {
    city: INELIGIBLE_CITY,
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TURNER, months: 120, wants: false }],
  },
  leaving: {
    leaving: true,
    city: INELIGIBLE_CITY,
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TURNER, months: 120 }],
  },
  suspended: {
    status: "suspended",
    city: INELIGIBLE_CITY,
    consents: [{ purposes: SHARING, ageDays: 1 }],
    skills: [{ id: TURNER, months: 120 }],
  },
  noSkills: { city: INELIGIBLE_CITY, consents: [{ purposes: SHARING, ageDays: 1 }], skills: [] },
} satisfies Record<string, Fixture>;

type Key = keyof typeof FIXTURES;
const ID = Object.fromEntries(Object.keys(FIXTURES).map((k) => [k, randomUUID()])) as Record<Key, string>;
const KEY_OF = new Map(Object.entries(ID).map(([k, v]) => [v, k as Key]));
const ELIGIBLE: Key[] = ["turner", "turnerOld", "twoRoles", "vmcVeteran", "vmc", "welder", "unwantedTurner", "rider"];
const INELIGIBLE: Key[] = ["noConsent", "profilingOnly", "revoked", "optedOut", "wantsOff", "leaving", "suspended", "noSkills"];

describe.skipIf(!RUN)("POST /payer/candidates/search — against Postgres", () => {
  let client!: DbClient;
  let service!: CandidateSearchService;
  let repo!: CandidateSearchRepository;
  const before = new Map<string, { total: number; matched: number; unrecorded: number }>();
  let citiesBefore: string[] = [];

  const BASELINES: Record<string, CandidateSearchInput> = {
    all: {},
    turner: { skill_ids: [TURNER] },
    pune: { city: "Pune" },
    exp3to5: { experience: "3_5" },
    indexp1to3: { industry_experience: "1_3" },
    qc: { industry_id: QC, industry_experience: "1_3" },
  };

  const page = (body: CandidateSearchInput) =>
    service.search(PAYER, CandidateSearchSchema.parse(body), CTX);

  /** Every page, in order. Returns the fixture keys in the order served, plus the last counts. */
  async function walk(body: CandidateSearchInput, limit = 50) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let last: Awaited<ReturnType<typeof page>> | null = null;
    for (let i = 0; i < 10_000; i += 1) {
      last = await page({ ...body, limit, cursor });
      seen.push(...last.candidates.map((c) => c.workerId));
      if (last.nextCursor === null) break;
      cursor = last.nextCursor;
    }
    const mine = seen.map((id) => KEY_OF.get(id)).filter((k): k is Key => k !== undefined);
    return { seen, mine, last: last!, rows: last!.candidates };
  }

  const delta = (name: string, now: { total: number; matched: number; unrecorded: number }) => {
    const b = before.get(name)!;
    return { total: now.total - b.total, matched: now.matched - b.matched, unrecorded: now.unrecorded - b.unrecorded };
  };

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 2 });
    const events = new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
    repo = new CandidateSearchRepository(client.db);
    service = new CandidateSearchService(
      repo,
      new WorkerSkillsRepository(client.db),
      { get: async () => DEFAULT_MATCH_CONFIG } as unknown as MatchConfigService,
      events,
    );
    await ensureSkills(client);
    for (const [name, body] of Object.entries(BASELINES)) {
      const r = await page({ ...body, limit: 1 });
      before.set(name, { total: r.total, matched: r.matched, unrecorded: r.unrecorded });
    }
    citiesBefore = (await service.filters()).cities;
    await seed(client);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await cleanup(client);
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("THE INVARIANT: every eligible fixture is served, no ineligible one ever is, and total counts exactly the eight", async () => {
    const { seen, mine, last } = await walk({});
    expect(new Set(mine)).toEqual(new Set(ELIGIBLE));
    for (const k of INELIGIBLE) expect(seen).not.toContain(ID[k]);
    expect(delta("all", last).total).toBe(ELIGIBLE.length);
    // `total` is the population the walk actually served — nothing counted that cannot be shown.
    expect(last.total).toBe(seen.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("strict mode never surfaces an ineligible worker either, whatever the filter", async () => {
    for (const body of [{ skill_ids: [TURNER] }, { city: INELIGIBLE_CITY }, { experience: "10_plus" as const }]) {
      const { seen } = await walk({ ...body, strict: true });
      for (const k of INELIGIBLE) expect(seen).not.toContain(ID[k]);
    }
  });

  it("unfiltered order: the rank key alone (role months, industry months, then id)", async () => {
    const { mine } = await walk({});
    expect(mine).toEqual(["welder", "turner", "vmcVeteran", "twoRoles", "unwantedTurner", "rider", "vmc", "turnerOld"]);
  });

  it("the same total order at every page size — no gap, no repeat", async () => {
    const big = await walk({ skill_ids: [TURNER] }, 50);
    for (const size of [1, 2, 3, 7]) {
      const small = await walk({ skill_ids: [TURNER] }, size);
      expect(small.seen).toEqual(big.seen);
    }
  });

  it("a role filter REORDERS (matches first, related next, nobody removed) and counts its matches", async () => {
    const { mine, last } = await walk({ skill_ids: [TURNER] });
    expect(mine).toEqual([
      "turner", // holds the role, 48 months
      "turnerOld", // holds it, 12
      "twoRoles", // holds it (6) — leads with it under this filter
      "vmcVeteran", // RELATED, 48 ≥ the 36-month floor → tier-1 ordering, still not a match
      "vmc", // related, 24 → tier 2
      "welder", // neither → tier 3, by months
      "unwantedTurner", // his turner skill is OFF, so he is a welder here
      "rider",
    ]);
    expect(delta("all", last).total).toBe(ELIGIBLE.length);
    expect(delta("turner", last)).toMatchObject({ matched: 3, unrecorded: 0 });
  });

  it("the role-filtered card: matchTier, lead role, and a switched-off skill never shown", async () => {
    const byKey = new Map<Key, Awaited<ReturnType<typeof page>>["candidates"][number]>();
    let cursor: string | null = null;
    do {
      const r = await page({ skill_ids: [TURNER], limit: 50, cursor });
      for (const c of r.candidates) {
        const k = KEY_OF.get(c.workerId);
        if (k) byKey.set(k, c);
      }
      cursor = r.nextCursor;
    } while (cursor);
    expect(byKey.get("twoRoles")).toMatchObject({
      matchesFilters: true,
      matchTier: 1,
      role: { id: TURNER, label: "CNC Turner" },
      otherRoles: [{ id: VMC, label: "VMC Operator" }],
      skillMonths: 6,
      industryMonths: 36,
      city: "Mumbai",
    });
    expect(byKey.get("vmcVeteran")).toMatchObject({ matchesFilters: false, matchTier: 2, city: "Pune" });
    expect(byKey.get("welder")).toMatchObject({ matchesFilters: false, matchTier: null });
    const unwanted = byKey.get("unwantedTurner")!;
    expect(unwanted.role.id).toBe(TIG);
    expect(JSON.stringify(unwanted)).not.toContain(TURNER);
  });

  it("strict role filter: only the matches, total still the whole pool", async () => {
    const { mine, last } = await walk({ skill_ids: [TURNER], strict: true });
    expect(mine).toEqual(["turner", "turnerOld", "twoRoles"]);
    expect(delta("all", last).total).toBe(ELIGIBLE.length);
  });

  it("city: case/spacing-insensitive; an unrecorded city is kept even by strict, counted apart, never a match (ADR-0040 §4)", async () => {
    const strict = await walk({ city: "pune", strict: true });
    // The four recorded matches lead; the unrecorded one follows them (filter_match is definite).
    expect(strict.mine).toEqual(["welder", "turner", "vmcVeteran", "rider", "vmc"]);
    expect(delta("pune", strict.last)).toMatchObject({ matched: 4, unrecorded: 1 });
    // Non-strict keeps everyone: the matches first, then everyone else by the rank key.
    const all = await walk({ city: "Pune" });
    expect(all.mine).toEqual([
      "welder",
      "turner",
      "vmcVeteran",
      "rider",
      "twoRoles",
      "unwantedTurner",
      "vmc",
      "turnerOld",
    ]);
  });

  it("years in role: the lead role's bucketed months, [min, max)", async () => {
    const { mine, last } = await walk({ experience: "3_5", strict: true });
    expect(mine).toEqual(["turner", "vmcVeteran"]); // 48 and 48; the welder's 60 is the next bucket
    expect(delta("exp3to5", last)).toMatchObject({ matched: 2, unrecorded: 0 });
  });

  it("years in industry: an unrecorded tenure is kept by strict, counted as unrecorded, never as a match", async () => {
    const { mine, last } = await walk({ industry_experience: "1_3", strict: true });
    expect(mine).toEqual(["unwantedTurner", "rider", "turnerOld", "vmc"]);
    expect(delta("indexp1to3", last)).toMatchObject({ matched: 3, unrecorded: 1 });
  });

  it("industry: the lead role's industry (and its tenure) — the rider is the one quick-commerce match", async () => {
    const { mine, last } = await walk({ industry_id: QC, industry_experience: "1_3", strict: true });
    // The industry is always recorded, so a manufacturing worker is a definite "no" — even the
    // one whose tenure is unrecorded.
    expect(mine).toEqual(["rider"]);
    expect(delta("qc", last)).toMatchObject({ matched: 1, unrecorded: 0 });
  });

  it("every page carries the counts, and the last page has no cursor", async () => {
    const first = await page({ limit: 1 });
    const second = await page({ limit: 1, cursor: first.nextCursor });
    expect(second.total).toBe(first.total);
    expect(second.candidates[0]?.workerId).not.toBe(first.candidates[0]?.workerId);
    expect((await walk({}, 50)).last.nextCursor).toBeNull();
  });

  it("an anchor who LEAVES the pool between pages: the walk resumes at the next row, no repeat", async () => {
    // Find a page boundary that lands on one of this fixture's single-skill workers.
    let cursor: string | null = null;
    const served: string[] = [];
    let anchorKey: Key | undefined;
    for (let i = 0; i < 10_000 && anchorKey === undefined; i += 1) {
      const r = await page({ limit: 1, cursor });
      served.push(...r.candidates.map((c) => c.workerId));
      cursor = r.nextCursor;
      if (cursor === null) break;
      const k = KEY_OF.get(decodeCandidateCursor(cursor)!.workerId);
      if (k !== undefined && FIXTURES[k].skills.length === 1) anchorKey = k;
    }
    expect(anchorKey).toBeDefined();
    const anchor = ID[anchorKey!];
    await client.sql`UPDATE worker_skill SET wants = false WHERE worker_id = ${anchor}::uuid`;
    try {
      const rest: string[] = [];
      while (cursor !== null) {
        const r = await page({ limit: 1, cursor });
        rest.push(...r.candidates.map((c) => c.workerId));
        cursor = r.nextCursor;
      }
      expect(rest).not.toContain(anchor); // he left — and he is not shown again
      for (const id of rest) expect(served).not.toContain(id); // no repeat across the boundary
      // …and no skip: what was served before plus what came after IS the new full order.
      const full = (await walk({})).seen;
      expect([...served.filter((id) => id !== anchor), ...rest]).toEqual(full);
    } finally {
      await client.sql`UPDATE worker_skill SET wants = true WHERE worker_id = ${anchor}::uuid`;
    }
  });

  it("the city facet offers the pool's canonical cities and never an ineligible worker's", async () => {
    const { cities } = await service.filters();
    for (const c of ["Pune", "Chennai", "Mumbai", "Delhi"]) expect(cities).toContain(c);
    if (!citiesBefore.includes(INELIGIBLE_CITY)) expect(cities).not.toContain(INELIGIBLE_CITY);
  });

  it("writes one PII-free payer.candidate_search_performed per page", async () => {
    const rows = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
        AND event_name = 'payer.candidate_search_performed'`;
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows.map((r) => r.payload));
    for (const id of Object.values(ID)) expect(text).not.toContain(id);
    expect(text).not.toContain("Pune");
  });
});

async function ensureSkills(client: DbClient): Promise<void> {
  // The D1 vocabulary rows these fixtures name — a no-op where D1 has run (match-feed-order.db's upsert).
  const rows: [string, string, string, string][] = [
    [TURNER, "CNC Turner", "cnc-machining", MFG],
    [VMC, "VMC Operator", "vmc-machining", MFG],
    [TIG, "TIG Welder", "welding", MFG],
    [RIDER, "Delivery Rider", "last-mile-delivery", QC],
  ];
  for (const [id, label, domain, industry] of rows) {
    await client.sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${id}, ${label}, ${domain}, 'rvm', 'active', 'match_skill', ${industry})
      ON CONFLICT (skill_id) DO NOTHING`;
  }
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const [key, f] of Object.entries(FIXTURES) as [Key, Fixture][]) {
    const id = ID[key];
    // NO PII: synthetic markers for the two NOT NULL phone columns; the city is not identity.
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, deletion_scheduled_at, current_city)
      VALUES (${id}::uuid, ${`enc:cand-${TAG}-${key}`}, ${`hash:cand-${TAG}-${key}`},
              ${f.status ?? "active"}, ${f.leaving ? sql`now() + interval '7 days'` : null}, ${f.city})`;
    for (const c of f.consents) {
      await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at, revoked_at)
        VALUES (${id}::uuid, 'test', ${JSON.stringify(c.purposes)}::jsonb,
                now() - make_interval(days => ${c.ageDays}::int),
                ${c.revoked ? sql`now()` : null})`;
    }
    for (const s of f.skills) {
      const industry = s.id === RIDER ? QC : MFG;
      await sql`
        INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
        VALUES (${id}::uuid, ${s.id}, ${industry}, ${s.months}, ${s.wants ?? true}, 'ops')`;
    }
    for (const t of f.tenure ?? []) {
      await sql`
        INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
        VALUES (${id}::uuid, ${t.industry}, ${t.months})`;
    }
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  const ids = Object.values(ID);
  await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
  // worker_skill / worker_industry_tenure / worker_consents CASCADE from workers.
  await sql`DELETE FROM workers WHERE id = ANY(${ids}::uuid[])`;
}
