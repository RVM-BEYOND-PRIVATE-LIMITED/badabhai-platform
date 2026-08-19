import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import {
  createDbClient,
  platformAiCostTotals,
  workerAiCostTotals,
  workerProfiles,
  workers,
  type DbClient,
} from "@badabhai/db";

import { AiCostTotalsRepository } from "../ai/ai-cost-totals.repository";
import { AdminDashboardRepository } from "./admin-dashboard.repository";

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
/** Three profile rows for ONE worker — a re-interview plus an outage placeholder. */
const PROFILE_CONFIRMED = uuid(0xbb60);
const PROFILE_EXTRACTED = uuid(0xbb61);
const PROFILE_DRAFT_PLACEHOLDER = uuid(0xbb62);

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
  let writer!: AiCostTotalsRepository;

  async function cleanup(): Promise<void> {
    // The worker cascade takes its profiles AND its `worker_ai_cost_totals` row with it — that
    // cascade is itself the DPDP story and is asserted by the ai/ suite.
    await client.db.delete(workers).where(eq(workers.id, WORKER));
    // BY PREFIX, not by this run's exact labels: the platform table has no cascade and no
    // worker to erase, so a crashed run's rows would otherwise be permanent (the ai/ suite
    // learned this the hard way).
    await client.db
      .delete(platformAiCostTotals)
      .where(like(platformAiCostTotals.provider, "bp5-%"));
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new AdminDashboardRepository(client.db);
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
});
