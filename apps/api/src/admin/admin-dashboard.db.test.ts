import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq, like, sql } from "drizzle-orm";
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
