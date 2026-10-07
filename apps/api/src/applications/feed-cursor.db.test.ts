import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, events, type DbClient } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { MatchApplyService } from "../match/match-apply.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { MatchFeedService } from "../match/match-feed.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { FeedQuerySchema } from "./applications.dto";
import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService, type FeedPage } from "./applications.service";

/**
 * #1961 / ADR-0052 — `GET /feed` CURSOR PAGINATION, AGAINST A REAL POSTGRES.
 *
 * The unit suites page in-memory models of the SQL. Only a database proves the SQL itself:
 *
 *   - the `to_char(... AT TIME ZONE 'UTC', '...US"Z"')` key round-trips through `::timestamptz`
 *     with no precision lost, so rows inside ONE millisecond are neither skipped nor repeated;
 *   - the legacy keyset `posted_at <= t AND (posted_at < t OR id > :id)` resumes exactly, on
 *     exact ties (id order only) and on microsecond neighbours;
 *   - the union's per-arm cursor pages the merged deck with no duplicate and no gap, including a
 *     cross-arm pair inside one millisecond that a single merged key would lose;
 *   - the V1 keyset clause matches its ORDER BY (boost, tier, published_at NULLS LAST, id), so
 *     paging the V1 deck through the interleave serves every reached posting exactly once;
 *   - `feed.shown` / `feed.shown_v2` are VALIDATED and persisted per page with deck ranks.
 *
 * Every paged run goes through the DTO (`FeedQuerySchema`) with the wire cursor, so the
 * encode → query string → decode path is exercised end to end.
 *
 * FIXTURE DATES ARE IN 2099 (March) so these cards head the deck above any seeded data.
 * Comparisons are against a single unpaginated read of the same service, so other rows in the
 * database cannot make them flaky.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test feed-cursor.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CORR_FULL = uuid(0x19610001);
const CORR_PAGED = uuid(0x19610002);
const CTX_FULL: RequestContext = { correlationId: CORR_FULL, requestId: "feed-cursor-db-full" };
const CTX_PAGED: RequestContext = { correlationId: CORR_PAGED, requestId: "feed-cursor-db-paged" };

/** No `worker_skill` rows: the union's #1240 rule serves him every open posting. */
const FRESH = uuid(0x19611001);
/** The V1 worker: reached on the V1 fixtures only. */
const V1W = uuid(0x19611002);

const PAYER_A = uuid(0x19612001);
const PAYER_B = uuid(0x19612002);
const PAYER_C = uuid(0x19612003);
const SKILL = "mskill_vmc_operator";

/** `2099-03-01 00:00:SS.mmmuuu+00` — microsecond fixtures, written as Postgres text. */
const ts = (seconds: number, micros: number) =>
  `2099-03-01 00:00:${String(seconds).padStart(2, "0")}.${String(micros).padStart(6, "0")}+00`;

// ── Legacy `jobs` ── ids ascending in the order they are listed.
const JOBS: Array<[id: string, created: string]> = [
  [uuid(0x19613001), ts(50, 0)],
  // Three at ONE instant: only `id ASC` orders them.
  [uuid(0x19613002), ts(40, 100)],
  [uuid(0x19613003), ts(40, 100)],
  [uuid(0x19613004), ts(40, 100)],
  // Microsecond neighbours inside one millisecond, inserted newest-id-last.
  [uuid(0x19613005), ts(30, 200)],
  [uuid(0x19613006), ts(30, 700)],
  [uuid(0x19613007), ts(20, 0)],
  // The cross-arm pair: this job and P_PAIR share a millisecond; the posting is newer by
  // microseconds but its id sorts after the job's.
  [uuid(0x19613008), ts(10, 100)],
  [uuid(0x19613009), ts(5, 0)],
];

// ── Company `job_postings` ── [id, published, payer, tier (for V1W) | null = not reached, boosted]
type PostingFixture = [string, string | null, string, 1 | 2 | null, boolean];
const POSTINGS: PostingFixture[] = [
  [uuid(0x19614001), ts(55, 0), PAYER_A, 1, false],
  [uuid(0x19614002), ts(45, 0), PAYER_A, 1, false],
  [uuid(0x19614003), ts(40, 100), PAYER_A, 1, false], // ties three jobs to the microsecond
  [uuid(0x19614004), ts(35, 0), PAYER_A, 1, false],
  [uuid(0x19614005), ts(30, 450), PAYER_B, 1, false], // between the two job neighbours
  [uuid(0x19614006), ts(25, 0), PAYER_A, 2, false],
  [uuid(0x19614007), ts(15, 0), PAYER_C, 2, false],
  [uuid(0x19614008), ts(10, 900), PAYER_B, null, false], // P_PAIR
  [uuid(0x19614009), ts(12, 0), PAYER_C, 1, true], // boosted: heads the V1 deck
  [uuid(0x1961400a), ts(3, 0), PAYER_A, 1, false],
  [uuid(0x1961400b), ts(3, 0), PAYER_A, 1, false], // exact tie with the previous one
];
// V1-only: reached, open, never published (sorts NULLS LAST in its tier; never in the union).
const P_UNPUBLISHED: PostingFixture = [uuid(0x1961400c), null, PAYER_B, 1, false];
const ALL_POSTINGS = [...POSTINGS, P_UNPUBLISHED];

describe.skipIf(!RUN)("#1961 GET /feed cursor pagination — against Postgres", () => {
  let client!: DbClient;
  let eventsSvc!: EventsService;

  const service = (flags: { union?: boolean; v1?: boolean }) => {
    const workerSkills = new WorkerSkillsRepository(client.db);
    const config = new MatchConfigService(new MatchConfigRepository(client.db));
    return new ApplicationsService(
      new ApplicationsRepository(client.db),
      eventsSvc,
      new MatchFeedService(new MatchFeedRepository(client.db), config, eventsSvc),
      new MatchApplyService(client.db, workerSkills, config),
      {
        MATCH_V1_ENABLED: flags.v1 ?? false,
        FEED_POSTINGS_UNION_ENABLED: flags.union ?? false,
      } as never,
      workerSkills,
    );
  };

  /** Page to the end through the DTO, exactly as the controller would. */
  async function pageAll(svc: ApplicationsService, workerId: string, limit: number) {
    const pages: FeedPage[] = [];
    let wire: string | null = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const query = FeedQuerySchema.parse(wire === null ? { limit } : { limit, cursor: wire });
      const page = await svc.getFeed(workerId, query.limit, {}, CTX_PAGED, query.cursor);
      pages.push(page);
      if (page.next_cursor === null) return pages;
      wire = page.next_cursor;
    }
    throw new Error("paging did not terminate");
  }

  const idsOf = (pages: FeedPage[]) => pages.flatMap((p) => p.jobs.map((j) => j.job_id));

  async function shownRanks(eventName: "feed.shown" | "feed.shown_v2"): Promise<number[]> {
    const rows = await client.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.correlationId, CORR_PAGED), eq(events.eventName, eventName)));
    return rows.map((r) => (r.payload as { rank: number }).rank).sort((a, b) => a - b);
  }

  async function clearEvents() {
    for (const c of [CORR_FULL, CORR_PAGED]) {
      await client.db.delete(events).where(eq(events.correlationId, c));
    }
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    eventsSvc = new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
    await cleanup(client);
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  });

  it("the keyset text keeps every microsecond and round-trips through ::timestamptz", async () => {
    const rows = await new ApplicationsRepository(client.db).findOpenJobs(FRESH, 1000, {});
    const neighbour = rows.find((r) => r.id === JOBS[5]![0])!;
    expect(neighbour.postedKey).toBe("2099-03-01T00:00:30.000700Z");
    const back = await client.sql<{ same: boolean }[]>`
      SELECT (${neighbour.postedKey}::timestamptz = created_at) AS same FROM jobs
       WHERE id = ${neighbour.id}::uuid`;
    expect(back[0]!.same).toBe(true);
  });

  it.each([1, 2, 3, 7])(
    "jobs-only feed, limit %i: pages concatenate to the single full read; feed.shown ranks 1..N",
    async (limit) => {
      await clearEvents();
      const svc = service({});
      const full = await svc.getFeed(FRESH, 1000, {}, CTX_FULL);
      const pages = await pageAll(svc, FRESH, limit);
      expect(idsOf(pages)).toEqual(full.jobs.map((j) => j.job_id));
      expect(pages.flatMap((p) => p.jobs.map((j) => j.rank))).toEqual(
        full.jobs.map((_, i) => i + 1),
      );
      // The first page is the pre-cursor first page.
      expect(pages[0]!.jobs).toEqual(full.jobs.slice(0, limit));
      expect(pages.at(-1)!.next_cursor).toBeNull();
      // One VALIDATED feed.shown per card served, on whichever page served it.
      expect(await shownRanks("feed.shown")).toEqual(full.jobs.map((_, i) => i + 1));
    },
  );

  it.each([1, 2, 3, 5])(
    "union feed, limit %i: pages concatenate to the single merged read — no duplicate, no gap",
    async (limit) => {
      await clearEvents();
      const svc = service({ union: true });
      const full = await svc.getFeed(FRESH, 1000, {}, CTX_FULL);
      const fullIds = full.jobs.map((j) => j.job_id);
      // Vacuity: both arms and the unpublished exclusion are in play.
      expect(fullIds).toContain(JOBS[0]![0]);
      expect(fullIds).toContain(POSTINGS[0]![0]);
      expect(fullIds).not.toContain(P_UNPUBLISHED[0]);

      const pages = await pageAll(svc, FRESH, limit);
      const paged = idsOf(pages);
      expect(new Set(paged).size).toBe(paged.length);
      expect(paged).toEqual(fullIds);
      expect(pages[0]!.jobs).toEqual(full.jobs.slice(0, limit));
      expect(await shownRanks("feed.shown")).toEqual(fullIds.map((_, i) => i + 1));
    },
  );

  it.each([1, 2, 4])(
    "V1 deck, limit %i: every reached posting exactly once, through the interleave",
    async (limit) => {
      await clearEvents();
      const svc = service({ v1: true });
      const reached = ALL_POSTINGS.filter((p) => p[3] !== null).map((p) => p[0]);
      const full = await new MatchFeedRepository(client.db).listFeed(V1W, 1000, {});
      expect(new Set(full.map((r) => r.jobPostingId))).toEqual(new Set(reached));
      // Vacuity: the boost, the NULL published_at and both tiers are all in the deck.
      expect(full[0]!.jobPostingId).toBe(uuid(0x19614009));
      expect(full.some((r) => r.publishedKey === null)).toBe(true);
      expect(new Set(full.map((r) => r.matchTier))).toEqual(new Set([1, 2]));

      const pages = await pageAll(svc, V1W, limit);
      const paged = idsOf(pages);
      expect(new Set(paged).size).toBe(paged.length);
      expect(new Set(paged)).toEqual(new Set(reached));

      const firstPage = await service({ v1: true }).getFeed(V1W, limit, {}, CTX_FULL);
      expect(pages[0]!.jobs).toEqual(firstPage.jobs);
      expect(await shownRanks("feed.shown_v2")).toEqual(paged.map((_, i) => i + 1));
    },
  );
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'cnc-machining', 'rvm', 'active', 'match_skill',
            'ind_industrial_manufacturing')
    ON CONFLICT (skill_id) DO NOTHING
  `;
  // Synthetic markers only — no real phone number exists in this fixture.
  for (const [id, tag] of [
    [FRESH, "f"],
    [V1W, "v"],
  ] as const) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:feed-cursor-${tag}`}, ${`hash:feed-cursor-${tag}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const [id, created] of JOBS) {
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, created_at)
      VALUES (${id}::uuid, 'fitter', 'Fitter — Feed Cursor Fixture', 'Pune', 'open',
              ${created}::timestamptz)
    `;
  }
  for (const [id, published, payer, tier, boosted] of ALL_POSTINGS) {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at,
                                boosted_until)
      VALUES (${id}::uuid, ${payer}::uuid, ${payer}::uuid, 'Feed Cursor Fixture', 'VMC Operator',
              '1', 'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb,
              ${published}::timestamptz,
              ${boosted ? "2999-01-01 00:00:00+00" : null}::timestamptz)
    `;
    if (tier !== null) {
      await sql`
        INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
        VALUES (${id}::uuid, ${V1W}::uuid, ${tier}, ${SKILL})
      `;
    }
  }
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const w of [FRESH, V1W]) {
    await sql`DELETE FROM applications WHERE worker_id = ${w}::uuid`;
    await sql`DELETE FROM job_reach WHERE worker_id = ${w}::uuid`;
  }
  for (const [id] of ALL_POSTINGS) await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  for (const [id] of JOBS) await sql`DELETE FROM jobs WHERE id = ${id}::uuid`;
  for (const w of [FRESH, V1W]) await sql`DELETE FROM workers WHERE id = ${w}::uuid`;
  for (const c of [CORR_FULL, CORR_PAGED]) {
    await client.db.delete(events).where(eq(events.correlationId, c));
  }
}
