import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq, inArray, like, sql } from "drizzle-orm";
import {
  createDbClient,
  events,
  platformAiCostTotals,
  workerAiCostTotals,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";
import { AiSpendCapExceededPayload } from "@badabhai/event-schema";

import { AiCostTotalsRepository } from "../ai/ai-cost-totals.repository";
import { AdminDashboardRepository } from "./admin-dashboard.repository";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminEventsRepository } from "./admin-events.repository";
import {
  ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT,
  DASHBOARD_OTHER_BUCKET,
  DASHBOARD_WORKER_STATUSES,
  PROFILE_COMPLETED_STATUSES,
  PROFILING_TASK_TYPES,
} from "./admin-dashboard.dto";
import type { WorkerStatus } from "@badabhai/types";

/**
 * The dashboard reads, against a REAL Postgres — because two of their claims are properties of
 * the DATABASE, and a stubbed drizzle handle can only prove the right SQL was ASKED for.
 *
 * ── 1. THE PLATFORM TOTAL INCLUDES SPEND NO WORKER OWNS ─────────────────────────────────
 * This is THE defect the three-table split exists to prevent, and it is invisible to every
 * other kind of test. `worker_ai_cost_totals` and `platform_ai_cost_totals` carry identical
 * column names, so summing the wrong one compiles, typechecks, and returns a plausible ₹
 * figure. It is wrong because `skill_embedding` on a job-posting write and
 * `job_posting_chat_turn` are PAYER-side calls with no worker at all: they exist ONLY in the
 * platform table. A total summed from worker rows silently omits them and still renders as
 * "total AI spend".
 *
 * The test below accrues one worker-attributed call AND one payer-side call through the REAL
 * writer (`AiCostTotalsRepository`, the same class `AiCostRecorder` uses), then asserts the
 * dashboard's total moved by BOTH — and, explicitly, that it did not move by only the worker
 * one. Swap the repository's `FROM` to `worker_ai_cost_totals` and this fails; nothing else in
 * the suite would notice.
 *
 * ── 1b. THE CAP-BREACH SPLIT IS A QUERY POSTGRES WILL ACTUALLY ACCEPT ───────────────────
 * `countByPayloadField` groups by `coalesce(payload->>'reason', 'unknown')`. Its first version
 * passed the KEY as a bound parameter, and drizzle renders each `Param` occurrence as its own
 * placeholder — `$1` in the SELECT list, `$4` in GROUP BY, `$5` in ORDER BY. Postgres matches a
 * GROUP BY expression STRUCTURALLY, so the projected expression was never recognised as grouped
 * and every single request died with:
 *
 *     ERROR: column "events.payload" must appear in the GROUP BY clause or be used in an
 *     aggregate function
 *
 * The whole endpoint went with it, because the call sits inside `summary()`'s `Promise.all`. The
 * shape tests could not see it: `captureQueries` renders SQL and never executes it. THIS is the
 * gate that executes it — the split is asserted directly, and then again through the real
 * `summary()`, which is the composition that actually 500'd.
 *
 * ── 2. PROFILE PROGRESS IS ONE ROW PER WORKER ───────────────────────────────────────────
 * `worker_profiles` gets a row per extraction, so counting the table double-counts every
 * re-interviewed worker, and an EMPTY placeholder row written during an ai-service outage
 * would outrank the real profile beside it. `DISTINCT ON (worker_id)` +
 * `CURRENT_PROFILE_ORDER` is what prevents both, and whether that ORDER BY actually EVALUATES
 * as claimed is a property of Postgres.
 *
 * ── 3. COST PER PROFILE: TWO POPULATIONS, AND POSTGRES DECIDES BOTH ─────────────────────
 * The ratio's numerator is the PROFILING slice of spend and its denominator is the profiles
 * that COMPLETED SINCE the accrual bound. Three of its properties are the database's, not the
 * service's, and every one of them fails silently:
 *   - `resume_generation` must not be in the numerator. A résumé is rendered FROM a profile
 *     that already exists; in production it is ₹5.629 of a ₹77.4583 total, so including it
 *     inflates the cost of PRODUCING a profile by ~8% with work that produced none. The test
 *     accrues both through the REAL writer and asserts the two subtotals move differently.
 *   - A re-interviewed worker counts ONCE. `worker_profiles` holds a row per extraction, so
 *     whether `DISTINCT ON (worker_id)` actually collapses them is a property of Postgres.
 *   - The `created_at >= since` filter sits ABOVE the `DISTINCT ON`. That ordering is what
 *     stops an in-window outage placeholder from being promoted to a worker's "current"
 *     profile, and only an executed query can show which row survived.
 *
 * ── DELTAS, NOT ABSOLUTES ───────────────────────────────────────────────────────────────
 * Both reads are UNFILTERED aggregates over shared tables (that is what a platform figure is),
 * so a developer's real local rows — or a previous crashed run — make an absolute assertion
 * meaningless. Every claim here is measured as a BEFORE/AFTER difference, except the
 * per-provider buckets, whose labels are namespaced with this process's pid and are therefore
 * exact.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *   pnpm db:migrate                      # 0077 must be applied
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test admin-dashboard.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0xbb50);
/**
 * A worker whose `status` is NOT a `WORKER_STATUSES` member. Insertable because
 * `workers.status` is a plain `text` column with NO check constraint — only `job_postings`
 * has one (`job_postings_status_chk`) — which is precisely why the densifier needs an `other`
 * bucket, and why this test can exist at all.
 */
const WORKER_DRIFTED = uuid(0xbb52);
/** Three profile rows for ONE worker — a re-interview plus an outage placeholder. */
const PROFILE_CONFIRMED = uuid(0xbb60);
const PROFILE_EXTRACTED = uuid(0xbb61);
const PROFILE_DRAFT_PLACEHOLDER = uuid(0xbb62);

/**
 * The cost-per-profile denominator fixtures. Three workers, one for each way the count can be
 * wrong, all measured against ONE bound (`ACCRUAL_BOUND`) so the same query answers all three.
 */
const WORKER_REINTERVIEWED = uuid(0xbb54);
const WORKER_PREDATES = uuid(0xbb55);
const WORKER_OUTAGE = uuid(0xbb56);
const PROFILE_REINTERVIEW_FIRST = uuid(0xbb63);
const PROFILE_REINTERVIEW_SECOND = uuid(0xbb64);
const PROFILE_PREDATES = uuid(0xbb65);
const PROFILE_OUTAGE_REAL = uuid(0xbb66);
const PROFILE_OUTAGE_PLACEHOLDER = uuid(0xbb67);

/**
 * The accrual bound these tests measure against — a fixed instant, because the fixtures'
 * `created_at` values are fixed and the point is which side of it each one falls on. In
 * production this is `min(first_recorded_at)`, read from the same response that displays it.
 */
const ACCRUAL_BOUND = new Date("2026-08-10T00:00:00.000Z");
/** A bound before EVERY fixture — the guard that proves an exclusion is real, not vacuous. */
const BOUND_BEFORE_EVERYTHING = new Date("2020-01-01T00:00:00.000Z");

/** Run-namespaced providers for the numerator test, cleaned by the same `bp5-%` prefix. */
const PROVIDER_PROFILING = `bp5-profiling-${process.pid}`;
const PROVIDER_RESUME = `bp5-resume-${process.pid}`;
/** ₹ chosen so profiling-only (0.400000) and profiling+résumé (1.150000) cannot be confused. */
const PROFILING_COST = 0.4;
const RESUME_COST = 0.75;

/** Every `events` row this run writes carries this correlation id — the cleanup handle. */
const CORRELATION = uuid(0xbb70);
/**
 * A run-namespaced event NAME for the exact-bucket assertions. `events` is shared and the real
 * `ai.spend_cap_exceeded` rows on a developer's database would make an absolute count
 * meaningless; the summary test below uses the REAL name and measures deltas instead.
 */
const CAP_EVENT_ISOLATED = `bp5.cap_probe_${process.pid}`;

/**
 * Provider labels UNIQUE TO THIS RUN. `platform_ai_cost_totals` is keyed on
 * (provider, task_type) with no worker scope, so it is the one table another run could
 * pollute — namespacing makes the per-provider assertions exact rather than "greater than".
 */
const PROVIDER_WORKER_SIDE = `bp5-worker-${process.pid}`;
const PROVIDER_PAYER_SIDE = `bp5-payer-${process.pid}`;

/** ₹ chosen so worker-only (0.100000) and worker+payer (0.350000) cannot be confused. */
const WORKER_SIDE_COST = 0.1;
const PAYER_SIDE_COST = 0.25;

describe.skipIf(!RUN)("admin dashboard reads (BP-5) against a real database", () => {
  let client!: DbClient;
  let repo!: AdminDashboardRepository;
  let eventsRepo!: AdminEventsRepository;
  let service!: AdminDashboardService;
  let writer!: AiCostTotalsRepository;

  async function cleanup(): Promise<void> {
    // The worker cascade takes its profiles AND its `worker_ai_cost_totals` row with it — that
    // cascade is itself the DPDP story and is asserted by the ai/ suite.
    await client.db.delete(workers).where(eq(workers.id, WORKER));
    await client.db.delete(workers).where(eq(workers.id, WORKER_DRIFTED));
    for (const id of [WORKER_REINTERVIEWED, WORKER_PREDATES, WORKER_OUTAGE]) {
      await client.db.delete(workers).where(eq(workers.id, id));
    }
    // BY PREFIX, not by this run's exact labels: the platform table has no cascade and no
    // worker to erase, so a crashed run's rows would otherwise be permanent (the ai/ suite
    // learned this the hard way).
    await client.db
      .delete(platformAiCostTotals)
      .where(like(platformAiCostTotals.provider, "bp5-%"));
    // The spine rows this suite writes. `events` is append-only in PRODUCTION code (the static
    // guard scans non-test files under admin/**); a test that leaves probe rows behind poisons
    // every later delta on the same database.
    await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new AdminDashboardRepository(client.db);
    eventsRepo = new AdminEventsRepository(client.db);
    service = new AdminDashboardService(repo, eventsRepo);
    writer = new AiCostTotalsRepository(client.db);
    await cleanup();
    await client.db
      .insert(workers)
      .values({ id: WORKER, phoneE164: "v1.bp5", phoneHash: uuid(0xbb51), status: "active" });
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  /** `sum(total_cost_inr)` over the WORKER table — the incomplete figure, for contrast. */
  async function workerTableTotal(): Promise<number> {
    const rows = await client.db
      .select({ total: sql<string>`coalesce(sum(${workerAiCostTotals.totalCostInr}), 0)::text` })
      .from(workerAiCostTotals);
    return Number(rows[0]?.total ?? 0);
  }

  it("the platform total counts PAYER-SIDE spend that no worker owns", async () => {
    const beforePlatform = await repo.platformCostTotals();
    const beforeWorkerTable = await workerTableTotal();

    await writer.withTransaction(async (tx) => {
      // (a) a worker-attributed call — lands in BOTH tables.
      await writer.accrue(
        {
          workerId: WORKER,
          sessionId: null,
          provider: PROVIDER_WORKER_SIDE,
          taskType: "profiling_chat_turn",
          costInr: WORKER_SIDE_COST,
          realCall: true,
        },
        tx,
      );
      // (b) a PAYER-SIDE call — no worker, no session. `skill_embedding` on a posting write is
      // exactly this shape. It lands in the platform table ONLY.
      await writer.accrue(
        {
          workerId: null,
          sessionId: null,
          provider: PROVIDER_PAYER_SIDE,
          taskType: "skill_embedding",
          costInr: PAYER_SIDE_COST,
          realCall: true,
        },
        tx,
      );
    });

    const afterPlatform = await repo.platformCostTotals();
    const afterWorkerTable = await workerTableTotal();

    const platformDelta = Number(afterPlatform.totalCostInr) - Number(beforePlatform.totalCostInr);
    const workerDelta = afterWorkerTable - beforeWorkerTable;

    // BOTH calls are in the platform figure.
    expect(platformDelta).toBeCloseTo(WORKER_SIDE_COST + PAYER_SIDE_COST, 10);
    expect(afterPlatform.totalCalls - beforePlatform.totalCalls).toBe(2);
    expect(afterPlatform.realCalls - beforePlatform.realCalls).toBe(2);

    // …and ONLY ONE of them is in the worker table. This pair is the assertion: a dashboard
    // that read `worker_ai_cost_totals` would report `workerDelta` and look perfectly healthy.
    expect(workerDelta).toBeCloseTo(WORKER_SIDE_COST, 10);
    expect(
      platformDelta,
      "the platform total must NOT equal the worker-derived total — that is the undercount",
    ).not.toBeCloseTo(workerDelta, 10);
  });

  it("groups by the raw provider label, and the payer-side provider is one of them", async () => {
    const buckets = await repo.costByProvider();
    const byName = new Map(buckets.map((b) => [b.provider, b]));

    // Exact, because these labels are namespaced to this run.
    expect(byName.get(PROVIDER_PAYER_SIDE)?.total_cost_inr).toBe("0.250000");
    expect(byName.get(PROVIDER_PAYER_SIDE)?.call_count).toBe(1);
    expect(byName.get(PROVIDER_WORKER_SIDE)?.total_cost_inr).toBe("0.100000");

    // `numeric`, not a float: the string is what the column holds, to six places.
    expect(typeof byName.get(PROVIDER_PAYER_SIDE)?.total_cost_inr).toBe("string");
  });

  it("splits by task type — payer-side `skill_embedding` is visible on its own", async () => {
    const buckets = await repo.costByTaskType();
    const embedding = buckets.find((b) => b.task_type === "skill_embedding");
    expect(embedding).toBeDefined();
    // Not exact (task_type is not namespaced), but this run's ₹0.25 must be in there.
    expect(Number(embedding!.total_cost_inr)).toBeGreaterThanOrEqual(PAYER_SIDE_COST);
  });

  it("accruing_since is at or before the accrual this run just made", async () => {
    const totals = await repo.platformCostTotals();
    const buckets = await repo.costByProvider();
    const ours = buckets.find((b) => b.provider === PROVIDER_PAYER_SIDE);
    expect(totals.since).not.toBeNull();
    // `min()` over the whole table, so it is at or before OUR row's own first_recorded_at.
    expect(totals.since!.getTime()).toBeLessThanOrEqual(ours!.first_recorded_at.getTime());
  });

  it("profile progress counts a re-interviewed worker ONCE, under the CURRENT profile", async () => {
    const before = new Map(
      (await repo.countCurrentProfilesByStatus()).map((b) => [b.key, b.count]),
    );
    const at = (iso: string) => new Date(iso);

    await client.db.insert(workerProfiles).values([
      // Oldest: a real, confirmed profile.
      {
        id: PROFILE_CONFIRMED,
        workerId: WORKER,
        profileStatus: "confirmed",
        createdAt: at("2026-08-01T00:00:00.000Z"),
      },
      // A later re-interview that extracted something — the CURRENT profile.
      {
        id: PROFILE_EXTRACTED,
        workerId: WORKER,
        profileStatus: "extracted",
        createdAt: at("2026-08-10T00:00:00.000Z"),
      },
      // NEWEST, and EMPTY: what an ai-service outage writes. Recency alone would make this the
      // worker's profile and report a fully-profiled worker as a draft.
      {
        id: PROFILE_DRAFT_PLACEHOLDER,
        workerId: WORKER,
        profileStatus: "draft",
        createdAt: at("2026-08-15T00:00:00.000Z"),
      },
    ]);

    const after = new Map((await repo.countCurrentProfilesByStatus()).map((b) => [b.key, b.count]));
    const delta = (key: string) => (after.get(key) ?? 0) - (before.get(key) ?? 0);

    // ONE worker, counted ONCE — not three times, once per row.
    expect(delta("extracted")).toBe(1);
    // The newest row is the placeholder, and it must NOT be the one that counts.
    expect(delta("draft")).toBe(0);
    expect(delta("confirmed")).toBe(0);
    expect(delta("extracted") + delta("draft") + delta("confirmed") + delta("extracting")).toBe(1);
  });

  // ── cost per profile: the numerator ──────────────────────────────────────────────────────

  it("the profiling subtotal EXCLUDES resume_generation, which the platform total includes", async () => {
    const beforeSubtotal = await repo.profilingCostSubtotal(PROFILING_TASK_TYPES);
    const beforeTotal = await repo.platformCostTotals();

    await writer.withTransaction(async (tx) => {
      // (a) profiling spend — an interview turn. IN the numerator.
      await writer.accrue(
        {
          workerId: WORKER,
          sessionId: null,
          provider: PROVIDER_PROFILING,
          taskType: "profiling_chat_turn",
          costInr: PROFILING_COST,
          realCall: true,
        },
        tx,
      );
      // (b) a résumé rendered FROM a profile that already exists. In the platform total, and
      // NOT in the numerator — this is the ₹5.629-of-₹77.4583 case, at test scale.
      await writer.accrue(
        {
          workerId: WORKER,
          sessionId: null,
          provider: PROVIDER_RESUME,
          taskType: "resume_generation",
          costInr: RESUME_COST,
          realCall: true,
        },
        tx,
      );
    });

    const afterSubtotal = await repo.profilingCostSubtotal(PROFILING_TASK_TYPES);
    const afterTotal = await repo.platformCostTotals();

    const subtotalDelta = Number(afterSubtotal.totalCostInr) - Number(beforeSubtotal.totalCostInr);
    const totalDelta = Number(afterTotal.totalCostInr) - Number(beforeTotal.totalCostInr);

    // THE ASSERTION. The numerator moved by the interview alone; the platform total moved by
    // both. A dashboard dividing the total would charge résumé rendering to the cost of
    // producing a profile, and every number on the page would still look reasonable.
    expect(subtotalDelta).toBeCloseTo(PROFILING_COST, 10);
    expect(totalDelta).toBeCloseTo(PROFILING_COST + RESUME_COST, 10);
    expect(
      subtotalDelta,
      "the profiling numerator must NOT equal the platform total — that is the trap",
    ).not.toBeCloseTo(totalDelta, 10);

    // One call in the numerator, two in the total — the counts must split the same way.
    expect(afterSubtotal.callCount - beforeSubtotal.callCount).toBe(1);
    expect(afterSubtotal.realCallCount - beforeSubtotal.realCallCount).toBe(1);
    expect(afterTotal.totalCalls - beforeTotal.totalCalls).toBe(2);

    // THE BOUND COMES BACK WITH THE MONEY, from the SAME filtered aggregate — which is what
    // makes it structurally impossible for the numerator and its denominator to cover
    // different periods. It is a real instant, and never later than the table-wide minimum.
    expect(afterSubtotal.since).not.toBeNull();
    expect(afterSubtotal.since!.getTime()).toBeGreaterThanOrEqual(afterTotal.since!.getTime());

    // `numeric`, not a float: exactly what the column holds, to six places.
    expect(typeof afterSubtotal.totalCostInr).toBe("string");
  });

  // ── cost per profile: the denominator ────────────────────────────────────────────────────

  /** The count under test, at the shared bound. */
  const completedSince = (since: Date) =>
    repo.countCurrentProfilesCompletedSince(since, PROFILE_COMPLETED_STATUSES);

  async function insertWorker(id: string, suffix: string, hash: number): Promise<void> {
    await client.db
      .insert(workers)
      .values({ id, phoneE164: `v1.bp5-${suffix}`, phoneHash: uuid(hash), status: "active" });
  }

  it("a RE-INTERVIEWED worker counts ONCE, not once per worker_profiles row", async () => {
    const before = await completedSince(ACCRUAL_BOUND);
    await insertWorker(WORKER_REINTERVIEWED, "reint", 0xbb57);
    await client.db.insert(workerProfiles).values([
      {
        id: PROFILE_REINTERVIEW_FIRST,
        workerId: WORKER_REINTERVIEWED,
        profileStatus: "extracted",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      // A second interview, a second row — both inside the window, both `extracted`.
      {
        id: PROFILE_REINTERVIEW_SECOND,
        workerId: WORKER_REINTERVIEWED,
        profileStatus: "extracted",
        createdAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ]);
    const after = await completedSince(ACCRUAL_BOUND);

    // TWO ROWS, ONE WORKER, ONE PROFILE. Counting rows instead would put 2 in the denominator
    // and HALVE the reported cost per profile for every worker who was interviewed twice.
    expect(after - before).toBe(1);
  });

  it("a profile created BEFORE the accrual bound is EXCLUDED from the denominator", async () => {
    const before = await completedSince(ACCRUAL_BOUND);
    const beforeAllTime = await completedSince(BOUND_BEFORE_EVERYTHING);

    await insertWorker(WORKER_PREDATES, "predates", 0xbb58);
    await client.db.insert(workerProfiles).values({
      id: PROFILE_PREDATES,
      workerId: WORKER_PREDATES,
      profileStatus: "extracted",
      // Nine days before the bound: a real, completed profile the spend never paid for,
      // because `platform_ai_cost_totals` had not started accruing yet.
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const after = await completedSince(ACCRUAL_BOUND);
    const afterAllTime = await completedSince(BOUND_BEFORE_EVERYTHING);

    // Excluded at the accrual bound — a profile that predates the spend must not be divided
    // into it, or the average reads LOWER than it is by exactly these workers.
    expect(after - before).toBe(0);
    // …AND THE GUARD THAT STOPS THAT BEING VACUOUS. The row is real and this query does see it;
    // a method that always returned 0, or a filter that dropped every row, would pass the line
    // above and fail this one.
    expect(afterAllTime - beforeAllTime).toBe(1);
  });

  it("an in-window OUTAGE PLACEHOLDER does not promote itself to the worker's profile", async () => {
    const before = await completedSince(ACCRUAL_BOUND);
    const beforeAllTime = await completedSince(BOUND_BEFORE_EVERYTHING);

    await insertWorker(WORKER_OUTAGE, "outage", 0xbb59);
    await client.db.insert(workerProfiles).values([
      // The worker's real profile — produced BEFORE the accrual bound.
      {
        id: PROFILE_OUTAGE_REAL,
        workerId: WORKER_OUTAGE,
        profileStatus: "extracted",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      // What an ai-service outage writes: newer, empty, inside the window.
      {
        id: PROFILE_OUTAGE_PLACEHOLDER,
        workerId: WORKER_OUTAGE,
        profileStatus: "draft",
        createdAt: new Date("2026-08-22T00:00:00.000Z"),
      },
    ]);

    const after = await completedSince(ACCRUAL_BOUND);
    const afterAllTime = await completedSince(BOUND_BEFORE_EVERYTHING);

    // THE OUTCOME IS THE ASSERTION, and only the outcome. `CURRENT_PROFILE_ORDER` resolves this
    // worker to the older EXTRACTED row (content beats recency) and the date filter then puts
    // them outside the window, so the placeholder adds nothing to the denominator.
    //
    // WHAT THIS TEST CANNOT SEE, stated so nobody reads more into it than it proves: moving the
    // date filter INSIDE the `DISTINCT ON` was measured against this whole file and changed
    // nothing. It cannot, while `PROFILE_COMPLETED_STATUSES` stays a subset of the non-draft
    // statuses — an in-window non-draft row can never be outranked by an out-of-window one. The
    // placement is pinned by the SQL-shape test instead; see the repository header.
    expect(after - before).toBe(0);
    // Not vacuous: at an all-time bound the worker DOES count, once, under the real profile.
    expect(afterAllTime - beforeAllTime).toBe(1);
  });

  it("the ratio reaches the response, scoped to the bound its own NUMERATOR begins at", async () => {
    const summary = await service.summary({ windowDays: ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT });
    const perProfile = summary.ai_cost.per_profile;

    // This run has accrued profiling spend, so there IS a window and the block is present.
    expect(summary.ai_cost.accruing_since).not.toBeNull();
    expect(perProfile).not.toBeNull();

    /*
     * BOTH HALVES, ONE BOUND — AND IT IS THE PROFILING ONE, NOT `accruing_since`.
     *
     * The earlier version of this test asserted `perProfile.since === accruing_since`, which
     * was the defect written down as a contract. `accruing_since` is `min(first_recorded_at)`
     * over EVERY task type; the numerator is filtered, so the window it covers starts at the
     * first PROFILING accrual. Those differ whenever a résumé or a payer-side embedding was paid
     * for first — which is the state this very database is in, its oldest row being a
     * `resume_generation` one. Read from Postgres here rather than trusted from the response.
     */
    const profilingMin = await client.db
      .select({ m: sql<Date | null>`min(${platformAiCostTotals.firstRecordedAt})` })
      .from(platformAiCostTotals)
      .where(inArray(platformAiCostTotals.taskType, [...PROFILING_TASK_TYPES]));
    expect(profilingMin[0]!.m).not.toBeNull();
    expect(perProfile!.since).toEqual(new Date(profilingMin[0]!.m!));

    // The invariant that must hold in every state: a minimum over a SUBSET of the rows is never
    // earlier than the minimum over all of them.
    expect(perProfile!.since.getTime()).toBeGreaterThanOrEqual(
      summary.ai_cost.accruing_since!.getTime(),
    );

    // AND THE DENOMINATOR WAS FILTERED BY THAT SAME INSTANT — recomputed independently, so a
    // response that reported one bound while counting from another would fail here.
    const countAtReportedBound = await repo.countCurrentProfilesCompletedSince(
      perProfile!.since,
      PROFILE_COMPLETED_STATUSES,
    );
    expect(perProfile!.profiles_extracted_or_confirmed).toBe(countAtReportedBound);

    // The numerator is the profiling slice, never the headline.
    expect(Number(perProfile!.profiling_cost_inr)).toBeLessThanOrEqual(
      Number(summary.ai_cost.total_cost_inr),
    );
    expect(perProfile!.profiling_task_types).toEqual(PROFILING_TASK_TYPES);
    // The average is either absent or an exact six-place decimal — never a bare float.
    if (perProfile!.cost_per_profile_inr !== null) {
      expect(perProfile!.cost_per_profile_inr).toMatch(/^\d+\.\d{6}$/);
    }
  });

  it("a task-type set that matches NO row yields a NULL bound, not a fabricated one", async () => {
    /*
     * THE STATE THAT USED TO RENDER A CONFIDENT ₹0.00. When no profiling task type has ever
     * accrued, the subtotal is a real ₹0 — but there is no window, and dividing that ₹0 by a
     * genuine profile count shipped `"0.000000"` as a measurement. `since` being NULL is what
     * makes the service drop the whole block instead. Asserted against a synthetic task type so
     * it holds no matter what this shared database already contains.
     */
    const empty = await repo.profilingCostSubtotal([`bp5-no-such-task-${process.pid}`]);
    expect(empty.since).toBeNull();
    expect(empty.totalCostInr).toBe("0");
    expect(empty.callCount).toBe(0);
  });

  // ── the cap-breach split — the query that 500'd ──────────────────────────────────────────

  /**
   * A `ai.spend_cap_exceeded` payload, PARSED THROUGH THE REGISTRY SCHEMA. That parse is the
   * point: it pins `reason` to the field name the emitter actually writes, so a payload rename
   * fails this file instead of silently emptying the dashboard's only non-`unknown` bucket.
   */
  function capPayload(reason: string): Record<string, unknown> {
    return AiSpendCapExceededPayload.parse({
      ai_call_id: uuid(0xbb81),
      ai_job_id: uuid(0xbb82),
      task_type: "profile_extraction",
      model: "gemini-2.0-flash",
      provider: "google",
      reason,
      real_call: true,
    }) as unknown as Record<string, unknown>;
  }

  /** One spine row for this run. PII-free (ids/enums only), exactly like a real event. */
  async function insertEvent(
    eventName: string,
    payload: Record<string, unknown>,
    occurredAt: Date = new Date(),
  ): Promise<void> {
    await client.db.insert(events).values({
      eventName,
      eventVersion: 1,
      occurredAt,
      actorType: "ai_service",
      subjectType: "ai_job",
      subjectId: uuid(0xbb82),
      correlationId: CORRELATION,
      payload,
    });
  }

  it("groups ONE event name by a payload field — the query Postgres actually accepts", async () => {
    // MEASURED, NOT REASONED. The parameterised form of this key produced `$1`/`$4`/`$5` for the
    // same expression, and Postgres rejected it outright:
    //   column "events.payload" must appear in the GROUP BY clause or be used in an aggregate
    // Nothing that renders SQL without running it can see that. This line can.
    await insertEvent(CAP_EVENT_ISOLATED, capPayload("user_daily_cap_exceeded"));
    await insertEvent(CAP_EVENT_ISOLATED, capPayload("user_daily_cap_exceeded"));
    await insertEvent(CAP_EVENT_ISOLATED, capPayload("cumulative_cap_exceeded"));
    // A breach whose reason did not serialize is still a breach — it groups under the literal
    // 'unknown' rather than vanishing. `->>` yields SQL NULL for a missing key.
    await insertEvent(CAP_EVENT_ISOLATED, { ai_job_id: uuid(0xbb82) });

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const buckets = await eventsRepo.countByPayloadField(CAP_EVENT_ISOLATED, "reason", since);

    // EXACT, because the event name is namespaced to this process. Ordered by count desc, then
    // key asc — the tie between the two 1s is broken deterministically, so two identical
    // requests cannot swap rows.
    expect(buckets).toEqual([
      { key: "user_daily_cap_exceeded", count: 2 },
      { key: "cumulative_cap_exceeded", count: 1 },
      { key: "unknown", count: 1 },
    ]);
  });

  it("honours the `since` bound — an older breach is outside the window, not counted twice", async () => {
    await insertEvent(
      CAP_EVENT_ISOLATED,
      capPayload("kill_switch_engaged"),
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const recent = await eventsRepo.countByPayloadField(
      CAP_EVENT_ISOLATED,
      "reason",
      new Date(Date.now() - 60 * 60 * 1000),
    );
    expect(recent.map((b) => b.key)).not.toContain("kill_switch_engaged");

    const allTime = await eventsRepo.countByPayloadField(
      CAP_EVENT_ISOLATED,
      "reason",
      new Date("2000-01-01T00:00:00.000Z"),
    );
    expect(allTime.find((b) => b.key === "kill_switch_engaged")?.count).toBe(1);
  });

  // ── the whole endpoint, composed ─────────────────────────────────────────────────────────

  const DTO = { windowDays: ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT };

  it("summary() RESOLVES — the breach read is inside its Promise.all, so it took the page down", async () => {
    const before = await service.summary(DTO);
    await insertEvent(AdminDashboardService.CAP_BREACH_EVENT, capPayload("cost_ceiling_exceeded"));
    const after = await service.summary(DTO);

    const reasonCount = (s: typeof after, reason: string) =>
      s.ai_cost.cap_breaches.by_reason.find((b) => b.reason === reason)?.count ?? 0;

    // DELTAS: this uses the REAL event name, and a developer's database may already hold rows.
    expect(after.ai_cost.cap_breaches.total - before.ai_cost.cap_breaches.total).toBe(1);
    expect(
      reasonCount(after, "cost_ceiling_exceeded") - reasonCount(before, "cost_ceiling_exceeded"),
    ).toBe(1);
    // The in-band scope marker travels with the number (one emitter today).
    expect(after.ai_cost.cap_breaches.scope).toBe("cap_breaches_cover_profile_extraction_only");
    // …and the rest of the page came back too, which is what the 500 was hiding.
    expect(after.volume.workers.by_status.length).toBeGreaterThan(0);
    expect(typeof after.ai_cost.total_cost_inr).toBe("string");
  });

  /** `count(*)` over `workers` — the number the headline must equal, unconditionally. */
  async function workerRowCount(): Promise<number> {
    const rows = await client.db.select({ n: count() }).from(workers);
    return rows[0]?.n ?? 0;
  }

  it("a DRIFTED worker status lands in `other`, and workers.total still equals count(*)", async () => {
    // Insertable only because `workers.status` has NO check constraint — plain `text`, typed in
    // TypeScript alone. `job_postings_status_chk` is the only status CHECK in the schema, so
    // this is a state the production database can actually be in.
    const before = await service.summary(DTO);
    await client.db.insert(workers).values({
      id: WORKER_DRIFTED,
      phoneE164: "v1.bp5-drift",
      phoneHash: uuid(0xbb53),
      status: "zombie" as WorkerStatus,
    });
    const after = await service.summary(DTO);
    const rowCount = await workerRowCount();

    const other = (s: typeof after) =>
      s.volume.workers.by_status.find((b) => b.key === DASHBOARD_OTHER_BUCKET)?.count ?? 0;

    // THE ASSERTION. Before the `other` bucket, the drifted row was dropped from the breakdown
    // AND from the total, so the headline silently stopped being `count(*)`.
    expect(after.volume.workers.total).toBe(rowCount);
    expect(after.volume.workers.total - before.volume.workers.total).toBe(1);
    expect(other(after) - other(before)).toBe(1);
    // …and no declared status absorbed it.
    for (const status of DASHBOARD_WORKER_STATUSES) {
      const at = (s: typeof after) =>
        s.volume.workers.by_status.find((b) => b.key === status)?.count ?? 0;
      expect(at(after) - at(before), `${status} must not have absorbed the drifted row`).toBe(0);
    }
    // The total is still summed from the buckets the response carries — it cannot disagree
    // with its own breakdown.
    expect(after.volume.workers.by_status.reduce((n, b) => n + b.count, 0)).toBe(rowCount);
  });
});
