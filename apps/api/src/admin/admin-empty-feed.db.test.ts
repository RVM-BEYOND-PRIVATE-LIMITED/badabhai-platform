import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { AGENCY_TWIN_SYSTEM_ACTOR_ID, type ServerConfig } from "@badabhai/config";
import { FeedQuerySchema } from "../applications/applications.dto";
import { ApplicationsRepository } from "../applications/applications.repository";
import { ApplicationsService } from "../applications/applications.service";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { MatchApplyService } from "../match/match-apply.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { MatchFeedService } from "../match/match-feed.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import {
  ADMIN_EMPTY_FEED_PAGE_MAX,
  AdminEmptyFeedQuerySchema,
  type AdminEmptyFeedMode,
} from "./admin-empty-feed.dto";
import { AdminEmptyFeedRepository } from "./admin-empty-feed.repository";
import { AdminEmptyFeedService } from "./admin-empty-feed.service";

/**
 * #2569 against Postgres. Two suites:
 *
 * 1. THE ACCEPTANCE CRITERION, executed:
 *   - a seeded worker with NO job in the active feed appears; adding an open job removes them;
 *   - a worker who applied to only SOME open jobs is NOT empty (the applied exclusion is real);
 *   - test accounts are excluded by default and included on request;
 *   - suspended workers are not counted;
 *   - trade/city buckets and offset paging are exact.
 *
 * 2. PARITY WITH THE REAL FEED ("no second implementation"): for each mode, every seeded
 *    worker is on the list ⇔ `ApplicationsService.getFeed` — the method `GET /feed` calls —
 *    serves him zero cards. See that suite's header.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test --no-file-parallelism admin-empty-feed.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
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

/**
 * ISOLATION FROM WHATEVER THE DATABASE ALREADY HOLDS. The feed is global: ONE open job anywhere
 * gives every worker who has not applied to it a non-empty legacy feed. CI runs `db:seed:jobs`
 * before the DB-backed gates, so the alpha jobs are open in that database, and without this every
 * "empty" fixture silently has a feed (measured: 5 of the 6 acceptance cases red with a single
 * foreign open job). So each seeded worker APPLIES to every open job and every open posting that
 * exists BEFORE this file's fixtures are inserted. An applied row removes an item in every mode
 * (legacy and union exclude applied rows; V1 excludes any decision), so afterwards only the
 * fixtures below decide a seeded worker's feed. Deleted with the worker (FK cascade).
 */
async function decideForeignInventory(client: DbClient, workerIds: string[]): Promise<void> {
  await client.sql`
    INSERT INTO applications (worker_id, job_id, action)
    SELECT w.id, jobs.id, 'applied'
    FROM unnest(${workerIds}::uuid[]) AS w(id) CROSS JOIN jobs
    WHERE jobs.status = 'open'
  `;
  await client.sql`
    INSERT INTO applications (worker_id, job_posting_id, action)
    SELECT w.id, job_postings.id, 'applied'
    FROM unnest(${workerIds}::uuid[]) AS w(id) CROSS JOIN job_postings
    WHERE job_postings.status = 'open'
  `;
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
  const NO_PROFILE = worker({
    city: null,
    tradeId: null,
    profileStatus: null,
    createdAt: new Date(),
  });
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
    await decideForeignInventory(
      client,
      all.map((w) => w.id),
    );

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
    expect(page.workers.map((w) => w.worker_id).sort()).toEqual([EMPTY.id, NO_PROFILE.id].sort());

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
    expect(
      (await service.list({ page: 1, page_size: 50, include_test_accounts: false })).total,
    ).toBe(0);

    await client.sql`UPDATE jobs SET status = 'closed' WHERE id = ${JOB3}::uuid`;
    expect(
      (await service.list({ page: 1, page_size: 50, include_test_accounts: false })).total,
    ).toBe(2);
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
    const page = await repo.page({
      mode: "v1",
      includeTestAccounts: false,
      page: 1,
      pageSize: 100,
    });
    const ids = page.workers.map((w) => w.worker_id);
    expect(ids).not.toContain(V1_REACHED.id);
    expect(ids).toContain(EMPTY.id);
    expect(ids).toContain(UNION_WANTS_A.id);
  });
});

// ── 2. PARITY WITH THE REAL FEED ───────────────────────────────────────────────────────────
//
// `AdminEmptyFeedRepository` keeps its own set-based SQL: one correlated EXISTS per worker over
// every worker, because computing the real feed per worker for ~30K workers is not an option on
// an admin read. That SQL is a SECOND COPY of the feed's eligibility rule, so it can drift. The
// source-text pins in `admin-empty-feed.contract.test.ts` cannot see drift on the FEED side at
// all, nor a semantic edit that keeps the pinned substrings. This suite can:
//
//   for each mode, for every seeded worker:
//     listed by AdminEmptyFeedService  ⇔  ApplicationsService.getFeed serves him zero cards
//
// THE FEED SIDE IS THE REAL CODE PATH, NOT A MODEL OF IT. `ApplicationsService.getFeed` is the
// method `GET /feed` calls, built exactly as `feed-cursor.db.test.ts` builds it, over real
// repositories on this database, with the app's default page size (`FeedQuerySchema`):
//   - jobs  (both flags off)               → ApplicationsRepository.findOpenJobs
//   - union (FEED_POSTINGS_UNION_ENABLED)  → findOpenJobs + WorkerSkillsRepository
//                                            .listWantedSkillIds → findOpenPostingsForFeed,
//                                            merged by mergeNewestFirst
//   - v1    (MATCH_V1_ENABLED)             → MatchFeedService.getFeed → MatchFeedRepository
//                                            .listFeed + the E14 interleave
// with a real EventsService (its feed.shown / feed.shown_v2 writes are validated, and deleted
// afterwards by correlation id). BOTH services read the SAME config object per mode, so the admin
// side's mode choice is under test too.
//
// EVERY CASE ALSO STATES ITS DESIGNED VERDICT per mode, and the real feed must produce it. That
// is the fixture check: without it a world in which every worker had a feed (or none did) would
// pass parity while exercising no branch at all.
//
// ONE BRANCH CANNOT BE ISOLATED, BY CONSTRUCTION: the union's twin guard (4) ("hide a posting
// while its source job is open"). An empty union feed needs an empty jobs arm, i.e. every open
// job applied, and then (3b) ("no applied row on the source job") already hides that posting.
// So (4) never decides emptiness, and dropping it from the admin SQL is an equivalent mutant
// for this list. It is still mirrored there because it decides the feed's CONTENTS.

const P_TAG = randomUUID().slice(0, 8);
const pskill = (name: string) => `mskill_ef_parity_${name}_${P_TAG}`;
const PS = {
  open: pskill("open"),
  closed: pskill("closed"),
  unpub: pskill("unpub"),
  twinOpen: pskill("twin_open"),
  twinClosed: pskill("twin_closed"),
  d4: pskill("d4"),
  /** Reached by no posting. */
  none: pskill("none"),
} as const;

const PJ = {
  open: randomUUID(),
  closed: randomUUID(),
  /** An agency job with an OPEN twin source. */
  srcOpen: randomUUID(),
  /** An agency job, CLOSED, whose twin is still open. */
  srcClosed: randomUUID(),
  /** The open source job of a D4 conversion (a native posting, `sync_source` NULL). */
  d4Src: randomUUID(),
} as const;
const PJ_STATUS: Record<keyof typeof PJ, "open" | "closed"> = {
  open: "open",
  closed: "closed",
  srcOpen: "open",
  srcClosed: "closed",
  d4Src: "open",
};
const P_OPEN_JOBS = (Object.keys(PJ) as Array<keyof typeof PJ>)
  .filter((k) => PJ_STATUS[k] === "open")
  .map((k) => PJ[k]);

interface ParityPosting {
  id: string;
  /** Its ONE reach skill, so a union worker's wanted skill picks exactly this posting. */
  skill: string;
  status: "open" | "closed";
  published: boolean;
  sourceJobId: string | null;
  /** An ADR-0050 agency twin (`sync_source = 'agency_job'`, no payer). */
  twin: boolean;
}
function posting(skill: string, overrides: Partial<ParityPosting> = {}): ParityPosting {
  return {
    id: randomUUID(),
    skill,
    status: "open",
    published: true,
    sourceJobId: null,
    twin: false,
    ...overrides,
  };
}
const PP = {
  open: posting(PS.open),
  closed: posting(PS.closed, { status: "closed" }),
  unpub: posting(PS.unpub, { published: false }),
  twinOpen: posting(PS.twinOpen, { sourceJobId: PJ.srcOpen, twin: true }),
  twinClosed: posting(PS.twinClosed, { sourceJobId: PJ.srcClosed, twin: true }),
  d4: posting(PS.d4, { sourceJobId: PJ.d4Src }),
} as const;

interface Decision {
  on: "job" | "posting";
  id: string;
  action: "applied" | "skipped";
}
const appliedJob = (id: string): Decision => ({ on: "job", id, action: "applied" });
const skippedJob = (id: string): Decision => ({ on: "job", id, action: "skipped" });
const appliedPosting = (p: ParityPosting): Decision => ({
  on: "posting",
  id: p.id,
  action: "applied",
});
const skippedPosting = (p: ParityPosting): Decision => ({
  on: "posting",
  id: p.id,
  action: "skipped",
});
/** The jobs arm emptied: applied to every OPEN job of this world (foreign ones are pre-decided). */
const ALL_OPEN_JOBS_APPLIED = P_OPEN_JOBS.map(appliedJob);

interface ParityCase {
  name: string;
  id: string;
  test?: boolean;
  /** Default true; false = no `worker_profiles` row at all. */
  profile?: boolean;
  /** `worker_skill` rows with `wants = true`. */
  wants?: string[];
  /** `worker_skill` rows with `wants = false` (held, not wanted). */
  holds?: string[];
  /** Postings he has a `job_reach` row for. */
  reach?: ParityPosting[];
  decisions?: Decision[];
  /** The DESIGNED verdict per mode: true = the real feed serves him nothing. */
  empty: Record<AdminEmptyFeedMode, boolean>;
}

function parityCase(c: Omit<ParityCase, "id">): ParityCase {
  return { id: randomUUID(), ...c };
}

const PARITY_CASES: ParityCase[] = [
  // ── jobs arm ──
  parityCase({
    name: "jobs: an open job left undecided",
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "jobs: every open job applied; the closed jobs left undecided do not count",
    decisions: ALL_OPEN_JOBS_APPLIED,
    empty: { jobs: true, union: false, v1: true },
  }),
  parityCase({
    name: "jobs: a SKIPPED open job is re-served (applied-only exclusion)",
    decisions: [skippedJob(PJ.open), appliedJob(PJ.srcOpen), appliedJob(PJ.d4Src)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "jobs: postings never count (wanted, reached posting; every open job applied)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.open],
    reach: [PP.open],
    empty: { jobs: true, union: false, v1: false },
  }),
  parityCase({
    name: "test account whose feed is empty in every mode",
    test: true,
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.none],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "no profile row, feed empty in every mode",
    profile: false,
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.none],
    empty: { jobs: true, union: true, v1: true },
  }),
  // ── union posting arm (jobs arm emptied, no reach) ──
  parityCase({
    name: "union: wanted skill on an open published posting",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.open],
    empty: { jobs: true, union: false, v1: true },
  }),
  parityCase({
    name: "union: that posting APPLIED on its posting id (3a)",
    decisions: [...ALL_OPEN_JOBS_APPLIED, appliedPosting(PP.open)],
    wants: [PS.open],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: that posting SKIPPED on its posting id is re-served",
    decisions: [...ALL_OPEN_JOBS_APPLIED, skippedPosting(PP.open)],
    wants: [PS.open],
    empty: { jobs: true, union: false, v1: true },
  }),
  parityCase({
    name: "union: wanted skill only on a CLOSED posting (1)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.closed],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: wanted skill only on an UNPUBLISHED posting (2)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.unpub],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: agency twin whose source job is OPEN (3b + 4)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.twinOpen],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: agency twin whose source job is CLOSED",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.twinClosed],
    empty: { jobs: true, union: false, v1: true },
  }),
  parityCase({
    name: "union: that twin's source APPLIED on the job id (3b)",
    decisions: [...ALL_OPEN_JOBS_APPLIED, appliedJob(PJ.srcClosed)],
    wants: [PS.twinClosed],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: that twin's source SKIPPED on the job id is re-served",
    decisions: [...ALL_OPEN_JOBS_APPLIED, skippedJob(PJ.srcClosed)],
    wants: [PS.twinClosed],
    empty: { jobs: true, union: false, v1: true },
  }),
  parityCase({
    name: "union: that twin APPLIED on its own posting id (3a)",
    decisions: [...ALL_OPEN_JOBS_APPLIED, appliedPosting(PP.twinClosed)],
    wants: [PS.twinClosed],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: D4 conversion whose source job is OPEN (3b + 4)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.d4],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: wanted skill that no posting reaches (5)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    wants: [PS.none],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: no wanted skills and every servable posting applied",
    decisions: [...ALL_OPEN_JOBS_APPLIED, appliedPosting(PP.open), appliedPosting(PP.twinClosed)],
    empty: { jobs: true, union: true, v1: true },
  }),
  parityCase({
    name: "union: a HELD but not wanted skill is no wanted skill (every posting passes)",
    decisions: ALL_OPEN_JOBS_APPLIED,
    holds: [PS.none],
    empty: { jobs: true, union: false, v1: true },
  }),
  // ── V1 (open jobs left undecided, so jobs/union are never empty) ──
  parityCase({
    name: "v1: reached on an open posting",
    reach: [PP.open],
    empty: { jobs: false, union: false, v1: false },
  }),
  parityCase({
    name: "v1: reached only on a CLOSED posting",
    reach: [PP.closed],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: reached on an open UNPUBLISHED posting (V1 serves it)",
    reach: [PP.unpub],
    empty: { jobs: false, union: false, v1: false },
  }),
  parityCase({
    name: "v1: reached posting APPLIED on its posting id",
    reach: [PP.open],
    decisions: [appliedPosting(PP.open)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: reached posting SKIPPED on its posting id (any decision excludes)",
    reach: [PP.open],
    decisions: [skippedPosting(PP.open)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: twin whose source job is OPEN",
    reach: [PP.twinOpen],
    empty: { jobs: false, union: false, v1: false },
  }),
  parityCase({
    name: "v1: twin whose source job is CLOSED",
    reach: [PP.twinClosed],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: twin's source APPLIED on the job id",
    reach: [PP.twinOpen],
    decisions: [appliedJob(PJ.srcOpen)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: twin's source SKIPPED on the job id",
    reach: [PP.twinOpen],
    decisions: [skippedJob(PJ.srcOpen)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: twin APPLIED on its own posting id",
    reach: [PP.twinOpen],
    decisions: [appliedPosting(PP.twinOpen)],
    empty: { jobs: false, union: false, v1: true },
  }),
  parityCase({
    name: "v1: a D4 conversion's applied SOURCE does not hide it (only a twin's does)",
    reach: [PP.d4],
    decisions: [appliedJob(PJ.d4Src)],
    empty: { jobs: false, union: false, v1: false },
  }),
];

type FeedFlags = Pick<ServerConfig, "MATCH_V1_ENABLED" | "FEED_POSTINGS_UNION_ENABLED">;
const PARITY_MODES: ReadonlyArray<{ mode: AdminEmptyFeedMode; flags: FeedFlags }> = [
  { mode: "jobs", flags: { MATCH_V1_ENABLED: false, FEED_POSTINGS_UNION_ENABLED: false } },
  { mode: "union", flags: { MATCH_V1_ENABLED: false, FEED_POSTINGS_UNION_ENABLED: true } },
  { mode: "v1", flags: { MATCH_V1_ENABLED: true, FEED_POSTINGS_UNION_ENABLED: false } },
];

const PARITY_CORRELATION = randomUUID();
const PARITY_CTX: RequestContext = {
  correlationId: PARITY_CORRELATION,
  requestId: "admin-empty-feed-parity-db",
};

interface ParityRow {
  case: string;
  test: boolean;
  designed: boolean;
  realEmpty: boolean;
  listed: boolean;
  listedWithTests: boolean;
}

describe.skipIf(!RUN)(
  "#2569 empty-feed list ⇔ the real GET /feed, per mode — against Postgres",
  () => {
    let client!: DbClient;
    let events!: EventsService;

    /** The real `GET /feed` service, built as `feed-cursor.db.test.ts` builds it. */
    function realFeed(config: ServerConfig): ApplicationsService {
      const workerSkills = new WorkerSkillsRepository(client.db);
      const matchConfig = new MatchConfigService(new MatchConfigRepository(client.db));
      return new ApplicationsService(
        new ApplicationsRepository(client.db),
        events,
        new MatchFeedService(new MatchFeedRepository(client.db), matchConfig, events),
        new MatchApplyService(client.db, workerSkills, matchConfig),
        config,
        workerSkills,
      );
    }

    /** Every worker id on the admin list, paged through the DTO exactly as the controller would. */
    async function listedIds(
      admin: AdminEmptyFeedService,
      mode: AdminEmptyFeedMode,
      includeTestAccounts: boolean,
    ): Promise<Set<string>> {
      const ids = new Set<string>();
      for (let page = 1; page <= 10_000; page += 1) {
        const out = await admin.list(
          AdminEmptyFeedQuerySchema.parse({
            page: String(page),
            page_size: String(ADMIN_EMPTY_FEED_PAGE_MAX),
            include_test_accounts: String(includeTestAccounts),
          }),
        );
        expect(out.feed_mode).toBe(mode);
        for (const w of out.workers) ids.add(w.worker_id);
        if (page >= out.total_pages) return ids;
      }
      throw new Error("admin empty-feed paging did not terminate");
    }

    beforeAll(async () => {
      assertLocalDatabase(DATABASE_URL);
      client = createDbClient(DATABASE_URL, { max: 4 });
      events = new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never);

      for (const c of PARITY_CASES) {
        await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, is_test_account, current_city)
        VALUES (${c.id}::uuid, ${`enc:${c.id}`}, ${`hmac:${c.id}`}, 'active', ${c.test ?? false},
                'Pune')
      `;
        if (c.profile ?? true) {
          await client.sql`
          INSERT INTO worker_profiles (worker_id, profile_status, canonical_trade_id)
          VALUES (${c.id}::uuid, 'confirmed', ${TRADE})
        `;
        }
      }
      // BEFORE this world's inventory exists, so only foreign items are pre-decided.
      await decideForeignInventory(
        client,
        PARITY_CASES.map((c) => c.id),
      );

      for (const skillId of Object.values(PS)) {
        await client.sql`
        INSERT INTO skill (skill_id, label_en, source, kind, status)
        VALUES (${skillId}, ${`Empty-feed parity ${skillId}`}, 'rvm', 'match_skill', 'active')
      `;
      }
      for (const key of Object.keys(PJ) as Array<keyof typeof PJ>) {
        await client.sql`
        INSERT INTO jobs (id, trade_key, title, city, status)
        VALUES (${PJ[key]}::uuid, 'cnc_operator', 'CNC Operator', 'Pune', ${PJ_STATUS[key]})
      `;
      }
      for (const p of Object.values(PP)) {
        await client.sql`
        INSERT INTO job_postings
          (id, created_by, org_label, role_title, vacancy_band, status, published_at,
           reach_skill_ids, source_job_id, sync_source)
        VALUES
          (${p.id}::uuid,
           ${p.twin ? AGENCY_TWIN_SYSTEM_ACTOR_ID : randomUUID()}::uuid,
           'Empty Feed Parity Co', 'CNC Operator', '1', ${p.status},
           ${p.published ? new Date().toISOString() : null}::timestamptz,
           ${JSON.stringify([p.skill])}::jsonb,
           ${p.sourceJobId}::uuid,
           ${p.twin ? "agency_job" : null})
      `;
      }

      for (const c of PARITY_CASES) {
        const skills: Array<readonly [string, boolean]> = [
          ...(c.wants ?? []).map((s) => [s, true] as const),
          ...(c.holds ?? []).map((s) => [s, false] as const),
        ];
        for (const [skillId, wants] of skills) {
          await client.sql`
          INSERT INTO worker_skill (worker_id, skill_id, industry_id, source, wants)
          VALUES (${c.id}::uuid, ${skillId}, 'ind_industrial_manufacturing', 'interview', ${wants})
        `;
        }
        for (const p of c.reach ?? []) {
          await client.sql`
          INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
          VALUES (${p.id}::uuid, ${c.id}::uuid, 1, ${p.skill})
        `;
        }
        for (const d of c.decisions ?? []) {
          await client.sql`
          INSERT INTO applications (worker_id, job_id, job_posting_id, action)
          VALUES (${c.id}::uuid,
                  ${d.on === "job" ? d.id : null}::uuid,
                  ${d.on === "posting" ? d.id : null}::uuid,
                  ${d.action})
        `;
        }
      }
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      try {
        // Workers first: the cascade clears worker_skill, job_reach and applications.
        await client.sql`
        DELETE FROM workers WHERE id = ANY(${PARITY_CASES.map((c) => c.id)}::uuid[])
      `;
        await client.sql`DELETE FROM events WHERE correlation_id = ${PARITY_CORRELATION}::uuid`;
        await client.sql`
        DELETE FROM job_postings WHERE id = ANY(${Object.values(PP).map((p) => p.id)}::uuid[])
      `;
        await client.sql`DELETE FROM jobs WHERE id = ANY(${Object.values(PJ)}::uuid[])`;
        await client.sql`DELETE FROM skill WHERE skill_id = ANY(${Object.values(PS)}::text[])`;
      } finally {
        await client.sql.end({ timeout: 5 });
      }
    });

    it.each(PARITY_MODES)(
      "$mode mode: listed ⇔ the real feed serves zero cards, for every seeded worker",
      async ({ mode, flags }) => {
        // ONE config object for both sides: the admin mode choice and the feed's are the same read.
        const config = flags as ServerConfig;
        const admin = new AdminEmptyFeedService(new AdminEmptyFeedRepository(client.db), config);
        const feed = realFeed(config);
        const limit = FeedQuerySchema.parse({}).limit;

        const listed = await listedIds(admin, mode, false);
        const listedWithTests = await listedIds(admin, mode, true);

        const rows: ParityRow[] = [];
        for (const c of PARITY_CASES) {
          const page = await feed.getFeed(c.id, limit, {}, PARITY_CTX);
          rows.push({
            case: c.name,
            test: c.test ?? false,
            designed: c.empty[mode],
            realEmpty: page.jobs.length === 0,
            listed: listed.has(c.id),
            listedWithTests: listedWithTests.has(c.id),
          });
        }

        // (1) PARITY, test accounts included: listed ⇔ the real feed is empty. FIRST, so drift on
        //     EITHER side (the admin SQL or the feed) is reported as drift.
        expect(
          rows.filter((r) => r.listedWithTests !== r.realEmpty),
          "admin empty-feed list (include_test_accounts=true) disagrees with GET /feed",
        ).toEqual([]);
        // (2) The default list: the same, minus every test account.
        expect(
          rows.filter((r) => r.listed !== (r.realEmpty && !r.test)),
          "admin empty-feed list (default) disagrees with GET /feed minus test accounts",
        ).toEqual([]);
        // (3) Not vacuous: this mode's cohort holds BOTH verdicts.
        expect(new Set(rows.map((r) => r.realEmpty))).toEqual(new Set([true, false]));
        // (4) The fixture check: the real feed produced every DESIGNED verdict. Red here with
        //     (1)-(2) green means both sides moved together: re-derive the case, do not delete it.
        expect(
          rows.filter((r) => r.realEmpty !== r.designed),
          "the real feed no longer produces a case's DESIGNED verdict",
        ).toEqual([]);
      },
      60_000,
    );
  },
);
