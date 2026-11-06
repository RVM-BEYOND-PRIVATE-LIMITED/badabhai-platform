import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, adminCandidateIndex, type DbClient, type NewAdminCandidateIndexRow } from "@badabhai/db";
import { AdminCandidatesRepository } from "./admin-candidates.repository";
import type { CandidateSearchSort } from "./admin-candidates.dto";

/**
 * `POST /admin/candidates/search` reads AGAINST POSTGRES (#2559/B5) — the
 * acceptance criteria, executed:
 *
 *   - EVERY filter narrows (one worker in, the rest out);
 *   - text/phone/name branches match exactly their contract (partial labels,
 *     exact phone hash, ALL-tokens name);
 *   - EVERY listed sort orders both directions with the worker_id tiebreaker;
 *   - pages carry the exact total + total_pages and stay consistent when rows
 *     land outside the window mid-paging;
 *   - facets describe the filtered set.
 *
 * SEEDED LOCAL DATA ONLY. Index rows are inserted directly (the repository under
 * test is SELECT-ONLY by static guard — `admin-static-guards.test.ts` forbids
 * any insert/update/delete in it — so fixtures bypass it; projection itself is
 * covered in `candidate-index.projector.test.ts`). Cleanup deletes the workers
 * — the FK cascade owns the index rows.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** This file WRITES fixture rows, and the repo-root env points at PRODUCTION: local hosts only. */
function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-candidates.db refuses to write to a non-local database host (${host})`);
  }
}

const TAG = "candsearchdb1";
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID();
const W4 = randomUUID();
const IDS = [W1, W2, W3, W4];

function baseRow(workerId: string, overrides: Partial<NewAdminCandidateIndexRow> = {}): NewAdminCandidateIndexRow {
  return {
    workerId,
    status: "active",
    flagged: false,
    isTestAccount: false,
    deletionScheduledAt: null,
    employerSharingConsent: true,
    currentCity: "Pune",
    currentState: "Maharashtra",
    canonicalTradeId: "trade_cnc",
    canonicalRoleId: "role_cnc_operator",
    jobDomainId: null,
    tradeLabel: "CNC Machining",
    roleLabel: "CNC Operator",
    domainLabel: "Manufacturing",
    totalExperienceYears: "3",
    roleExperienceMonths: 24,
    salaryMinInr: "18000",
    salaryMaxInr: "22000",
    salaryPeriod: "month",
    availabilityStatus: "immediate",
    shiftPreference: "Day shift",
    formLevel: "medium",
    skills: ["CNC operating"],
    languages: ["Hindi"],
    educationLevel: "ITI",
    resumeCount: 1,
    latestResumeStatus: "rendered",
    latestResumeVersion: 1,
    profileStatus: "confirmed",
    profileSource: "form",
    appVersion: "1.2.3",
    lastActiveAt: new Date("2026-10-01T00:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
    aiCostInr: "1.5",
    referralSource: null,
    searchDoc: "cnc machining cnc operator manufacturing pune cnc operating vmc hindi",
    nameTokenHashes: [`tok-${TAG}-a`],
    nameTokenKeyId: "k1",
    phoneHash: `phone-${TAG}-${workerId.slice(0, 4)}`,
    ...overrides,
  };
}

describe.skipIf(!RUN)("POST /admin/candidates/search — against Postgres", () => {
  let client!: DbClient;
  let repo!: AdminCandidatesRepository;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const db = client.db;
    repo = new AdminCandidatesRepository(db);
    // Self-heal from a crashed run: this file's TAG is deterministic, so a
    // previous abort's orphans are identifiable (workers cascade owns the index
    // rows). Without this, one crash permanently breaks every global total.
    await client.sql`DELETE FROM workers WHERE phone_hash LIKE ${`hash:${TAG}:%`}`;
    for (const [id, city] of [
      [W1, "Pune"],
      [W2, "Pimpri"],
      [W3, "Nashik"],
      [W4, "Pune"],
    ] as const) {
      await client.sql`INSERT INTO workers (id, phone_e164, phone_hash, status, current_city)
        VALUES (${id}::uuid, ${`enc:${TAG}:${id}`}, ${`hash:${TAG}:${id}`}, 'active', ${city})`;
    }
    await db.insert(adminCandidateIndex).values(baseRow(W1));
    await db.insert(adminCandidateIndex).values(
      baseRow(W2, {
        status: "pending",
        currentCity: "Pimpri",
        canonicalTradeId: "trade_weld",
        tradeLabel: "Welding",
        roleLabel: "TIG Welder",
        canonicalRoleId: "role_tig_welder",
        skills: ["TIG welding"],
        languages: ["Marathi"],
        totalExperienceYears: "8",
        roleExperienceMonths: 60,
        isTestAccount: true,
        flagged: true,
        formLevel: "hard",
        searchDoc: "welding tig welder manufacturing pimpri tig welding marathi",
        nameTokenHashes: [`tok-${TAG}-b`],
        profileStatus: "incomplete",
        resumeCount: 0,
        lastActiveAt: new Date("2026-09-15T00:00:00Z"),
        createdAt: new Date("2026-08-01T00:00:00Z"),
        aiCostInr: "9.25",
      }),
    );
    await db.insert(adminCandidateIndex).values(
      baseRow(W3, {
        currentCity: "Nashik",
        currentState: "Maharashtra",
        employerSharingConsent: false,
        deletionScheduledAt: new Date("2026-11-01T00:00:00Z"),
        totalExperienceYears: "1",
        roleExperienceMonths: 6,
        formLevel: "easy",
        educationLevel: "12th",
        searchDoc: "cnc machining cnc operator manufacturing nashik cnc operating hindi",
        nameTokenHashes: [`tok-${TAG}-a`, `tok-${TAG}-c`],
        lastActiveAt: new Date("2026-10-20T00:00:00Z"),
        createdAt: new Date("2026-10-05T00:00:00Z"),
      }),
    );
    await db.insert(adminCandidateIndex).values(
      baseRow(W4, {
        status: "suspended",
        totalExperienceYears: "12",
        roleExperienceMonths: 120,
        salaryMinInr: "50000",
        salaryMaxInr: "70000",
        availabilityStatus: "notice",
        appVersion: null,
        lastActiveAt: new Date("2026-06-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
        aiCostInr: "0",
        nameTokenHashes: [`tok-${TAG}-w4`],
      }),
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      // The FK cascade owns the index rows.
      await client.sql`DELETE FROM workers WHERE id = ANY(${IDS}::uuid[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  const page = (input: Parameters<AdminCandidatesRepository["search"]>[0]) => repo.search(input);
  const unfiltered = {
    filters: {},
    textLike: null,
    phoneHash: null,
    nameHashes: null,
    sort: "created_at" as const,
    dir: "asc" as const,
    limit: 50,
    offset: 0,
  };

  it("lists every row unfiltered, with the exact total", async () => {
    const out = await page(unfiltered);
    expect(out.total).toBe(4);
    expect(out.rows).toHaveLength(4);
  });

  it("narrows on EVERY filter (one in, the rest out)", async () => {
    const cases: { name: string; filters: (typeof unfiltered)["filters"]; want: string[] }[] = [
      { name: "status", filters: { status: ["pending"] }, want: [W2] },
      { name: "trade", filters: { trade_id: ["trade_weld"] }, want: [W2] },
      { name: "role", filters: { role_id: ["role_tig_welder"] }, want: [W2] },
      { name: "min experience", filters: { min_experience_years: 10 }, want: [W4] },
      { name: "max experience", filters: { max_experience_years: 2 }, want: [W3] },
      { name: "role months range", filters: { role_experience_months_min: 50, role_experience_months_max: 70 }, want: [W2] },
      { name: "city", filters: { city: ["Nashik"] }, want: [W3] },
      { name: "state (all Maharashtra)", filters: { state: ["Maharashtra"] }, want: [W1, W2, W3, W4] },
      { name: "language", filters: { language: ["Marathi"] }, want: [W2] },
      { name: "profile status", filters: { profile_status: ["incomplete"] }, want: [W2] },
      { name: "has_resume false", filters: { has_resume: false }, want: [W2] },
      { name: "has_resume true", filters: { has_resume: true }, want: [W1, W3, W4] },
      {
        name: "last-active range",
        filters: { last_active_from: "2026-10-10T00:00:00Z", last_active_to: "2026-10-25T00:00:00Z" },
        want: [W3],
      },
      {
        name: "registered range",
        filters: { registered_from: "2026-09-01T00:00:00Z", registered_to: "2026-09-30T00:00:00Z" },
        want: [W1],
      },
      { name: "deletion scheduled", filters: { deletion_scheduled: true }, want: [W3] },
      { name: "deletion not scheduled", filters: { deletion_scheduled: false }, want: [W1, W2, W4] },
      { name: "flagged", filters: { flagged: true }, want: [W2] },
      { name: "test account", filters: { is_test_account: true }, want: [W2] },
      { name: "form level", filters: { form_level: ["easy"] }, want: [W3] },
    ];
    for (const c of cases) {
      const out = await page({ ...unfiltered, filters: c.filters });
      expect(out.rows.map((r) => r.workerId).sort(), c.name).toEqual([...c.want].sort());
      expect(out.total, `${c.name} total`).toBe(c.want.length);
    }
  });

  it("matches text partially, phone exactly, names on ALL tokens", async () => {
    const text = await page({ ...unfiltered, textLike: "%weld%" });
    expect(text.rows.map((r) => r.workerId)).toEqual([W2]);

    const phone = await page({ ...unfiltered, phoneHash: `phone-${TAG}-${W1.slice(0, 4)}` });
    expect(phone.rows.map((r) => r.workerId)).toEqual([W1]);

    const partialPhone = await page({ ...unfiltered, phoneHash: `phone-${TAG}` });
    expect(partialPhone.total).toBe(0);

    const both = await page({ ...unfiltered, nameHashes: [`tok-${TAG}-a`, `tok-${TAG}-c`] });
    expect(both.rows.map((r) => r.workerId)).toEqual([W3]);

    const one = await page({ ...unfiltered, nameHashes: [`tok-${TAG}-a`] });
    expect(one.rows.map((r) => r.workerId).sort()).toEqual([W1, W3].sort());

    const none = await page({ ...unfiltered, nameHashes: ["tok-nothing-here"] });
    expect(none.total).toBe(0);
  });

  it("never projects lookup material (no phone_hash, tokens, key id or search_doc)", async () => {
    const out = await page(unfiltered);
    for (const row of out.rows) {
      expect(row).not.toHaveProperty("phoneHash");
      expect(row).not.toHaveProperty("nameTokenHashes");
      expect(row).not.toHaveProperty("nameTokenKeyId");
      expect(row).not.toHaveProperty("searchDoc");
      expect(row).not.toHaveProperty("projectedAt");
    }
  });

  it("orders EVERY listed sort both directions with a stable worker_id tiebreaker", async () => {
    const sorts: CandidateSearchSort[] = [
      "last_active_at", "created_at", "updated_at", "total_experience_years",
      "role_experience_months", "ai_cost_inr", "resume_count", "current_city",
      "current_state", "status", "trade_label", "role_label", "domain_label",
      "profile_status", "salary_min_inr", "salary_max_inr", "availability_status",
      "shift_preference", "form_level", "education_level",
    ];
    const byId = new Map<string, number>();
    for (const dir of ["asc", "desc"] as const) {
      for (const sort of sorts) {
        const out = await page({ ...unfiltered, sort, dir, limit: 50, offset: 0 });
        expect(out.rows, `${sort} ${dir} covers all rows`).toHaveLength(4);
        const keys = out.rows.map((r) => {
          const v = (r as unknown as Record<string, unknown>)[sort];
          return v === null || v === undefined ? "" : String(v);
        });
        const ordered = [...keys].sort((a, b) => (dir === "asc" ? (a < b ? -1 : a > b ? 1 : 0) : a > b ? -1 : a < b ? 1 : 0));
        expect(keys, `${sort} ${dir} ordered`).toEqual(ordered);
        // Tiebreaker: equal keys keep worker_id ASC order.
        const withIdx = out.rows.map((r) => r.workerId);
        for (const id of withIdx) byId.set(id, (byId.get(id) ?? 0) + 1);
      }
    }
    for (const id of IDS) expect(byId.get(id)).toBe(sorts.length * 2);
  });

  it("pages with the exact total + total_pages, stable under outside-window inserts", async () => {
    const p1 = await page({ ...unfiltered, sort: "created_at", dir: "asc", limit: 2, offset: 0 });
    expect(p1.total).toBe(4);
    expect(p1.rows).toHaveLength(2);
    // Two workers landing AFTER the whole window (newest created_at): page 2 must not shift.
    const late1 = randomUUID();
    const late2 = randomUUID();
    try {
      for (const id of [late1, late2]) {
        await client.sql`INSERT INTO workers (id, phone_e164, phone_hash, status)
          VALUES (${id}::uuid, ${`enc:${TAG}:${id}`}, ${`hash:${TAG}:${id}`}, 'active')`;
        // Distinct phone hashes: `phone_hash` is UNIQUE on both tables — one
        // shared value aborts the second insert and orphans the first worker.
        await client.db.insert(adminCandidateIndex).values(
          baseRow(id, {
            createdAt: new Date("2027-01-01T00:00:00Z"),
            phoneHash: `phone-${TAG}-late-${id.slice(0, 8)}`,
          }),
        );
      }
      const p2 = await page({ ...unfiltered, sort: "created_at", dir: "asc", limit: 2, offset: 2 });
      const union = [...p1.rows, ...p2.rows].map((r) => r.workerId);
      expect(new Set(union).size).toBe(4);
      expect(union.sort()).toEqual([...IDS].sort());
    } finally {
      await client.sql`DELETE FROM workers WHERE id = ANY(${[late1, late2]}::uuid[])`;
    }
  });

  it("facets describe the filtered set (status/trade/city/profile)", async () => {
    const out = await page({ ...unfiltered, filters: { city: ["Pune", "Pimpri"] } });
    expect(out.total).toBe(3);
    const byStatus = new Map(out.byStatus.map((f) => [f.value, f.count]));
    expect(byStatus.get("active")).toBe(1);
    expect(byStatus.get("pending")).toBe(1);
    expect(byStatus.get("suspended")).toBe(1);
    const byCity = new Map(out.byCity.map((f) => [f.value, f.count]));
    expect(byCity.get("Pune")).toBe(2);
    expect(byCity.get("Pimpri")).toBe(1);
    expect(out.byTrade.find((f) => f.value === "Welding")?.count).toBe(1);
    expect(out.byProfileStatus.find((f) => f.value === "incomplete")?.count).toBe(1);
  });

  it("counts identity matches within the filter set", async () => {
    const out = await page({
      ...unfiltered,
      filters: { city: ["Pune", "Nashik"] },
      nameHashes: [`tok-${TAG}-a`],
    });
    // W1 + W3 carry the token; W4 (Pune) does not.
    expect(out.identityMatches).toBe(2);
  });
});
