import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { AdminEmptyFeedRepository } from "./admin-empty-feed.repository";
import { AdminEmptyFeedService } from "./admin-empty-feed.service";

/**
 * #2569 against Postgres — the acceptance criterion, executed:
 *
 *   - a seeded worker with NO job in the active feed appears; adding an open job removes them;
 *   - a worker who applied to only SOME open jobs is NOT empty (the applied exclusion is real);
 *   - test accounts are excluded by default and included on request;
 *   - suspended workers are not counted;
 *   - the legacy, union and V1 arms each follow their feed's rule (open + decisions + reach/
 *     wanted-skill/twin guards);
 *   - trade/city buckets and offset paging are exact.
 *
 * The assertions compare the SAME seeded world the feed reads: open `jobs`/`job_postings`,
 * `applications`, `worker_skill` and `job_reach`.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-empty-feed.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const TRADE = "role_cnc_operator";
const JOB1 = randomUUID();
const JOB2 = randomUUID();
const JOB3 = randomUUID();
const POSTING = randomUUID();
const SKILL_A = `mskill_empty_feed_a_${TAG}`;
const SKILL_B = `mskill_empty_feed_b_${TAG}`;

interface SeedWorker {
  id: string;
  city: string | null;
  tradeId: string | null;
  profileStatus: "draft" | "extracted" | "confirmed" | null;
  status: "active" | "suspended";
  test: boolean;
  createdAt: Date;
}

function worker(overrides: Partial<SeedWorker> = {}): SeedWorker {
  return {
    id: randomUUID(),
    city: "Pune",
    tradeId: TRADE,
    profileStatus: "confirmed",
    status: "active",
    test: false,
    createdAt: new Date(Date.now() - 10 * 86400_000),
    ...overrides,
  };
}

describe.skipIf(!RUN)("#2569 empty-feed list — against Postgres", () => {
  let client!: DbClient;
  let service!: AdminEmptyFeedService;
  let repo!: AdminEmptyFeedRepository;

  // The seeded cast. `EMPTY` and `NO_PROFILE` applied to every job that exists at first.
  const EMPTY = worker();
  const NO_PROFILE = worker({ city: null, tradeId: null, profileStatus: null, createdAt: new Date() });
  const HAS_JOB = worker({ createdAt: new Date(Date.now() - 5 * 86400_000) });
  const APPLIED_SOME = worker({ city: "Delhi" });
  const TEST = worker({ test: true });
  const SUSPENDED = worker({ status: "suspended", city: "Mumbai" });
  const UNION_WANTS_A = worker({ city: "Nashik" });
  const UNION_WANTS_B = worker({ city: "Nagpur" });
  const V1_REACHED = worker({ city: "Thane" });

  const all = [
    EMPTY,
    NO_PROFILE,
    HAS_JOB,
    APPLIED_SOME,
    TEST,
    SUSPENDED,
    UNION_WANTS_A,
    UNION_WANTS_B,
    V1_REACHED,
  ];

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new AdminEmptyFeedRepository(client.db);
    service = new AdminEmptyFeedService(repo, {
      MATCH_V1_ENABLED: false,
      FEED_POSTINGS_UNION_ENABLED: false,
    } as ServerConfig);

    for (const w of all) {
      await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, is_test_account, current_city, created_at)
        VALUES (${w.id}::uuid, ${`enc:${w.id}`}, ${`hmac:${w.id}`}, ${w.status},
                ${w.test}, ${w.city}, ${w.createdAt.toISOString()}::timestamptz)
      `;
      if (w.profileStatus !== null) {
        await client.sql`
          INSERT INTO worker_profiles (worker_id, profile_status, canonical_trade_id)
          VALUES (${w.id}::uuid, ${w.profileStatus}, ${w.tradeId})
        `;
      }
    }

    for (const id of [JOB1, JOB2]) {
      await client.sql`
        INSERT INTO jobs (id, trade_key, title, city, status)
        VALUES (${id}::uuid, 'cnc_operator', 'CNC Operator', 'Pune', 'open')
      `;
    }

    // EMPTY / NO_PROFILE / TEST / SUSPENDED applied to BOTH open jobs → no feed.
    for (const w of [EMPTY, NO_PROFILE, TEST, SUSPENDED]) {
      for (const jobId of [JOB1, JOB2]) {
        await client.sql`
          INSERT INTO applications (worker_id, job_id, action)
          VALUES (${w.id}::uuid, ${jobId}::uuid, 'applied')
        `;
      }
    }
    // APPLIED_SOME applied to only ONE job → still has the other → not empty.
    await client.sql`
      INSERT INTO applications (worker_id, job_id, action)
      VALUES (${APPLIED_SOME.id}::uuid, ${JOB1}::uuid, 'applied')
    `;

    // Union arm fixtures: a skill vocabulary + an open published posting reaching skill A.
    const skillRows: ReadonlyArray<readonly [string, string]> = [
      [SKILL_A, "Empty-feed skill A"],
      [SKILL_B, "Empty-feed skill B"],
    ];
    for (const [skillId, label] of skillRows) {
      await client.sql`
        INSERT INTO skill (skill_id, label_en, source, kind, status)
        VALUES (${skillId}, ${label}, 'rvm', 'match_skill', 'active')
      `;
    }
    await client.sql`
      INSERT INTO job_postings
        (id, created_by, org_label, role_title, vacancy_band, status, published_at, reach_skill_ids)
      VALUES
        (${POSTING}::uuid, ${randomUUID()}::uuid, 'Empty Feed Co', 'CNC Operator', '1',
         'open', now(), ${JSON.stringify([SKILL_A])}::jsonb)
    `;
    const unionWants: ReadonlyArray<readonly [SeedWorker, string]> = [
      [UNION_WANTS_A, SKILL_A],
      [UNION_WANTS_B, SKILL_B],
    ];
    for (const [w, skillId] of unionWants) {
      await client.sql`
        INSERT INTO worker_skill (worker_id, skill_id, industry_id, source, wants)
        VALUES (${w.id}::uuid, ${skillId}, 'ind_industrial_manufacturing', 'interview', true)
      `;
    }

    // V1 arm fixture: a materialized reach row for the one posting.
    await client.sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${POSTING}::uuid, ${V1_REACHED.id}::uuid, 1, ${SKILL_A})
    `;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      // Workers first: their cascades clear worker_skill (which FKs skill), applications and
      // job_reach, so the reference rows can be deleted in any order after this.
      await client.sql`
        DELETE FROM workers WHERE id = ANY(${all.map((w) => w.id)}::uuid[])
      `;
      await client.sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
      await client.sql`DELETE FROM jobs WHERE id = ANY(${[JOB1, JOB2, JOB3]}::uuid[])`;
      await client.sql`DELETE FROM skill WHERE skill_id = ANY(${[SKILL_A, SKILL_B]}::text[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("legacy arm: lists only workers with NO open job left, with trade/city/profile/age", async () => {
    const page = await service.list({ page: 1, page_size: 50, include_test_accounts: false });
    expect(page.feed_mode).toBe("jobs");
    expect(page.total).toBe(2);
    expect(page.workers.map((w) => w.worker_id).sort()).toEqual(
      [EMPTY.id, NO_PROFILE.id].sort(),
    );

    const empty = page.workers.find((w) => w.worker_id === EMPTY.id)!;
    expect(empty).toMatchObject({
      trade_id: TRADE,
      trade_name: "CNC Operator",
      city: "Pune",
      profile_status: "confirmed",
    });
    expect(empty.days_since_signup).toBeGreaterThanOrEqual(9);
    const noProfile = page.workers.find((w) => w.worker_id === NO_PROFILE.id)!;
    expect(noProfile).toMatchObject({
      trade_id: null,
      trade_name: null,
      city: null,
      profile_status: null,
      days_since_signup: 0,
    });

    // Applied to ONE of two open jobs is NOT empty; test/suspended are excluded.
    for (const id of [HAS_JOB.id, APPLIED_SOME.id, TEST.id, SUSPENDED.id]) {
      expect(page.workers.some((w) => w.worker_id === id)).toBe(false);
    }

    expect(page.counts.by_trade).toEqual(
      expect.arrayContaining([
        { trade_id: TRADE, trade_name: "CNC Operator", count: 1 },
        { trade_id: null, trade_name: null, count: 1 },
      ]),
    );
    expect(page.counts.by_city).toEqual(
      expect.arrayContaining([
        { city: "Pune", count: 1 },
        { city: null, count: 1 },
      ]),
    );
  });

  it("adding an OPEN job removes both; closing it brings them back", async () => {
    await client.sql`
      INSERT INTO jobs (id, trade_key, title, city, status)
      VALUES (${JOB3}::uuid, 'cnc_operator', 'CNC Operator', 'Pune', 'open')
    `;
    expect((await service.list({ page: 1, page_size: 50, include_test_accounts: false })).total).toBe(
      0,
    );

    await client.sql`UPDATE jobs SET status = 'closed' WHERE id = ${JOB3}::uuid`;
    expect((await service.list({ page: 1, page_size: 50, include_test_accounts: false })).total).toBe(
      2,
    );
  });

  it("test accounts are excluded by default and included on request", async () => {
    const withTests = await service.list({
      page: 1,
      page_size: 50,
      include_test_accounts: true,
    });
    expect(withTests.total).toBe(3);
    expect(withTests.workers.some((w) => w.worker_id === TEST.id)).toBe(true);
    // Suspended is still excluded even when test accounts are included.
    expect(withTests.workers.some((w) => w.worker_id === SUSPENDED.id)).toBe(false);
  });

  it("pages by offset with exact total/total_pages", async () => {
    const first = await service.list({ page: 1, page_size: 1, include_test_accounts: false });
    const second = await service.list({ page: 2, page_size: 1, include_test_accounts: false });
    expect(first.total).toBe(2);
    expect(first.total_pages).toBe(2);
    expect(first.workers).toHaveLength(1);
    expect(second.workers).toHaveLength(1);
    expect(first.workers[0]!.worker_id).not.toBe(second.workers[0]!.worker_id);
  });

  it("union arm: an open published posting reaching the worker's WANTED skill counts", async () => {
    // Close the legacy jobs so only the postings arm can make a worker non-empty.
    await client.sql`UPDATE jobs SET status = 'closed' WHERE id = ANY(${[JOB1, JOB2]}::uuid[])`;

    const page = await repo.page({
      mode: "union",
      includeTestAccounts: false,
      page: 1,
      pageSize: 100,
    });
    const ids = page.workers.map((w) => w.worker_id);
    // UNION_WANTS_A is reached by the posting; UNION_WANTS_B is not.
    expect(ids).not.toContain(UNION_WANTS_A.id);
    expect(ids).toContain(UNION_WANTS_B.id);
    // No wanted skills ⇒ every posting passes the union arm (wide-or-off), so EMPTY is not here.
    expect(ids).not.toContain(EMPTY.id);
  });

  it("V1 arm: a job_reach row is the eligibility, and only that worker is served", async () => {
    const page = await repo.page({ mode: "v1", includeTestAccounts: false, page: 1, pageSize: 100 });
    const ids = page.workers.map((w) => w.worker_id);
    expect(ids).not.toContain(V1_REACHED.id);
    expect(ids).toContain(EMPTY.id);
    expect(ids).toContain(UNION_WANTS_A.id);
  });
});
