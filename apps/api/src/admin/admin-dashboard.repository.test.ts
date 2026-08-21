import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platformAiCostTotals, workerAiCostTotals } from "@badabhai/db";
import { AdminDashboardRepository } from "./admin-dashboard.repository";
import { PROFILE_COMPLETED_STATUSES, PROFILING_TASK_TYPES } from "./admin-dashboard.dto";
import { captureQueries } from "./testing/query-capture";

/**
 * SQL-SHAPE tests for the dashboard reads.
 *
 * Same technique and the same reason as `admin-entities.repository.test.ts`: these assert on
 * the statement that reaches Postgres, not on rows from a fixture. The claims here are about
 * the QUERY — "the platform total is summed from the PLATFORM table", "profile progress is
 * deduped per worker" — and a fixture only ever proves them for the rows someone remembered to
 * insert.
 *
 * ── THE ONE THAT MATTERS: WHICH TABLE THE PLATFORM TOTAL COMES FROM ─────────────────────
 * `worker_ai_cost_totals` and `platform_ai_cost_totals` have the same column names and the same
 * shape, so summing the wrong one compiles, typechecks, returns a plausible ₹ figure, and is
 * WRONG BY CONSTRUCTION: `skill_embedding` on a job-posting write and `job_posting_chat_turn`
 * are payer-side calls with no worker, so they exist ONLY in the platform table. A total summed
 * from worker rows silently omits them and still renders as "total AI spend". That is the exact
 * failure the three-table split was built to prevent, and nothing else in the suite would catch
 * it — which is why it is pinned twice below: on the FROM clause and on the source text.
 */

const REPO_SOURCE = readFileSync(join(__dirname, "admin-dashboard.repository.ts"), "utf8");
/** Source with comment lines stripped — this file's prose NAMES the forbidden table. */
const REPO_CODE = REPO_SOURCE.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

describe("the capture helper records the FROM clause (guards every assertion below)", () => {
  it("renders the source table, so a wrong-table assertion is not vacuous", () => {
    const right = captureQueries();
    void right.db.select({ n: platformAiCostTotals.callCount }).from(platformAiCostTotals);
    expect(right.sql()).toContain("platform_ai_cost_totals");

    // The mutation this suite exists to catch, performed by hand: same columns, wrong table.
    const wrong = captureQueries();
    void wrong.db.select({ n: workerAiCostTotals.callCount }).from(workerAiCostTotals);
    expect(wrong.sql()).toContain("worker_ai_cost_totals");
    expect(wrong.sql()).not.toContain("platform_ai_cost_totals");
  });
});

describe("platform AI cost — read from platform_ai_cost_totals, and ONLY from it", () => {
  const readsOfTheCostTable = [
    ["platformCostTotals", (r: AdminDashboardRepository) => r.platformCostTotals()],
    ["costByProvider", (r: AdminDashboardRepository) => r.costByProvider()],
    ["costByTaskType", (r: AdminDashboardRepository) => r.costByTaskType()],
  ] as const;

  for (const [name, call] of readsOfTheCostTable) {
    it(`${name} reads platform_ai_cost_totals and NEVER the worker/session tables`, async () => {
      const c = captureQueries();
      await call(new AdminDashboardRepository(c.db));
      expect(c.sql()).toContain("platform_ai_cost_totals");
      // The two tables a worker-derived (and therefore incomplete) total would come from.
      expect(
        c.sql(),
        "a platform figure summed from worker rows omits every payer-side call",
      ).not.toContain("worker_ai_cost_totals");
      expect(c.sql()).not.toContain("session_ai_cost_totals");
    });
  }

  it("the repository FILE never references the worker/session totals tables at all", () => {
    // Belt to the FROM-clause braces: a future read added here would have to name the table,
    // and this catches it even if nobody adds a shape test for the new method.
    expect(REPO_CODE).toContain("platformAiCostTotals");
    expect(REPO_CODE).not.toContain("workerAiCostTotals");
    expect(REPO_CODE).not.toContain("sessionAiCostTotals");
  });

  it("sums ₹ IN POSTGRES as text — never a float, never summed in JS", () => {
    const c = captureQueries();
    void new AdminDashboardRepository(c.db).platformCostTotals();
    // `numeric` is exact and `sum()` over it is exact; `::text` stops the driver handing back
    // a JS number, which is where the precision would be lost.
    expect(c.sql()).toMatch(/sum\("platform_ai_cost_totals"\."total_cost_inr"\)/);
    expect(c.sql()).toContain("::text");
  });

  it("min(first_recorded_at) is NOT coalesced — NULL means 'nothing has ever accrued'", () => {
    const c = captureQueries();
    void new AdminDashboardRepository(c.db).platformCostTotals();
    expect(c.sql()).toMatch(/min\("platform_ai_cost_totals"\."first_recorded_at"\)/);
    // Substituting a date for NULL would invent an accrual start that never happened.
    expect(c.sql()).not.toMatch(/coalesce\(min\(/);
  });

  it("groups by the RAW provider column — no read-time model→provider mapping", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).costByProvider();
    expect(c.sql()).toContain('"platform_ai_cost_totals"."provider"');
    // A CASE/mapping here is the failure the schema header calls out: it would silently
    // misclassify every model added after it was written.
    expect(c.sql().toLowerCase()).not.toContain("case when");
  });

  it("groups by task_type (the PK's other half) for the per-task split", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).costByTaskType();
    expect(c.sql()).toContain('"platform_ai_cost_totals"."task_type"');
  });
});

describe("the profiling subtotal — the numerator, and it is NOT the platform total", () => {
  it("filters task_type to the passed allowlist, in SQL", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).profilingCostSubtotal(PROFILING_TASK_TYPES);
    expect(c.sql()).toContain('"platform_ai_cost_totals"."task_type"');
    // The bound values ARE the allowlist — an unfiltered sum would bind none of them.
    for (const taskType of PROFILING_TASK_TYPES) {
      expect(c.params, `${taskType} must be bound into the subtotal's IN list`).toContain(taskType);
    }
  });

  it("EXCLUDES resume_generation — the trap this figure exists to avoid", () => {
    // ₹5.629 of production's ₹77.4583 is `resume_generation`, rendered FROM a profile that
    // already exists. In the numerator it inflates the cost of PRODUCING one by ~8% with work
    // that produced none. Nothing else in the suite would notice: the query still compiles,
    // still typechecks and still returns a plausible ₹ figure.
    expect(PROFILING_TASK_TYPES).not.toContain("resume_generation");
    const c = captureQueries();
    void new AdminDashboardRepository(c.db).profilingCostSubtotal(PROFILING_TASK_TYPES);
    expect(c.params).not.toContain("resume_generation");
  });

  it("is an ALLOWLIST, so an unclassified stored task_type is excluded, never swept in", async () => {
    // `task_type` is plain `text` and `AiCostRecorder` writes the literal 'unknown' for an
    // unlabelled call, so a value outside the enum really can be in the table. A `NOT IN (...)`
    // denylist would pull every one of them into the profiling numerator.
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).profilingCostSubtotal(PROFILING_TASK_TYPES);
    expect(c.sql().toLowerCase()).toContain(" in (");
    expect(c.sql().toLowerCase()).not.toContain("not in (");
    expect(c.params).not.toContain("unknown");
  });

  it("sums ₹ IN POSTGRES as text — never the JS sum of costByTaskType()'s buckets", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).profilingCostSubtotal(PROFILING_TASK_TYPES);
    expect(c.sql()).toMatch(/sum\("platform_ai_cost_totals"\."total_cost_inr"\)/);
    expect(c.sql()).toContain("::text");
  });

  it("returns the call counts beside the ₹, so the card can say what the average is over", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).profilingCostSubtotal(PROFILING_TASK_TYPES);
    expect(c.sql()).toMatch(/sum\("platform_ai_cost_totals"\."call_count"\)/);
    expect(c.sql()).toMatch(/sum\("platform_ai_cost_totals"\."real_call_count"\)/);
  });
});

describe("the profile count — the denominator, scoped to the SAME bound", () => {
  const SINCE = new Date("2026-08-19T07:38:05.000Z");

  const run = async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).countCurrentProfilesCompletedSince(
      SINCE,
      PROFILE_COMPLETED_STATUSES,
    );
    return c;
  };

  it("dedupes PER WORKER through the same CURRENT_PROFILE_ORDER as the status breakdown", async () => {
    const c = await run();
    // `worker_profiles` holds a row per extraction, so without this a re-interviewed worker is
    // counted once per interview and the average cost per profile falls by exactly that much.
    expect(c.sql()).toContain('"worker_profiles"."worker_id"');
    expect(c.sql()).toContain("<> 'draft'");
    expect(c.sql()).toContain('"worker_profiles"."created_at" desc');
    expect(c.sql()).toContain('"worker_profiles"."id" desc');
  });

  it("takes `since` as a BOUND PARAMETER — it never derives its own", async () => {
    const c = await run();
    // Compared as an INSTANT, not by identity: drizzle binds a real `timestamp` column's value
    // through the driver's mapper (an ISO string), and only the stub's raw fragment leaves the
    // `Date` intact. Asserting `toContainEqual(SINCE)` would pass here for a stub-shaped reason
    // and say nothing about the statement Postgres receives.
    const boundInstants = c.params
      .filter((p): p is Date | string => p instanceof Date || typeof p === "string")
      .map((p) => new Date(p).getTime());
    expect(boundInstants).toContain(SINCE.getTime());
    // A bound computed in SQL would drift from the one the response displays, which is the
    // whole defect. `min(first_recorded_at)` must not appear anywhere in this statement, and
    // neither may the cost table it would have to come from.
    expect(c.sql()).not.toContain("first_recorded_at");
    expect(c.sql()).not.toContain("platform_ai_cost_totals");
  });

  it("filters the RESOLVED row, above the DISTINCT ON — not the rows being resolved", async () => {
    const c = await run();
    // The subquery alias on both predicates is the assertion: filtering inside would let an
    // in-window outage placeholder outrank a worker's real, older profile.
    expect(c.sql()).toContain('"current_profile"."created_at"');
    expect(c.sql()).toContain('"current_profile"."profile_status"');
  });

  it("counts `extracted`/`confirmed` only — the positive set, not `<> draft`", async () => {
    const c = await run();
    expect(c.params).toContain("extracted");
    expect(c.params).toContain("confirmed");
    // `extracting` is a declared status meaning an extraction IN FLIGHT. A `<> 'draft'`
    // predicate would count it as a produced profile the day anything starts writing it.
    expect(c.params).not.toContain("extracting");
    expect(c.params).not.toContain("draft");
  });
});

describe("volume reads", () => {
  it("worker profile progress is deduped PER WORKER via CURRENT_PROFILE_ORDER", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).countCurrentProfilesByStatus();
    const sql = c.sql();
    // The DISTINCT ON key…
    expect(sql).toContain('"worker_profiles"."worker_id"');
    // …and the shared ordering that decides WHICH of a worker's rows survives. The
    // content-before-recency term is the load-bearing one: without it, an empty placeholder
    // row written during an ai-service outage outranks the real profile beside it.
    expect(sql).toContain("<> 'draft'");
    expect(sql).toContain('"worker_profiles"."created_at" desc');
    expect(sql).toContain('"worker_profiles"."id" desc');
  });

  it("applications separate APPLIED from skipped, in one pass", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).applicationCounts();
    // A skip is not an application; reporting the row count would inflate the headline metric.
    expect(c.sql()).toMatch(/filter \(where "applications"\."action" = 'applied'\)/);
  });

  it("unlocks count the ISSUED states, not every row and not 'granted' alone", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).countUnlocksIssued();
    // `granted` alone would go DOWN as payers reveal what they bought.
    expect(c.params).toContain("granted");
    expect(c.params).toContain("revealed");
  });

  it("workers pending deletion filter on deletion_scheduled_at IS NOT NULL", async () => {
    const c = captureQueries();
    await new AdminDashboardRepository(c.db).countWorkersPendingDeletion();
    expect(c.sql()).toMatch(/"workers"\."deletion_scheduled_at" is not null/i);
  });
});

describe("the dashboard repository is SELECT-ONLY and id-free", () => {
  it("issues no insert/update/delete against any table", () => {
    expect(REPO_CODE).not.toMatch(/\.(insert|update|delete)\s*\(/);
  });

  it("never issues an unprojected select() (which would return every column)", () => {
    expect(REPO_CODE).not.toMatch(/\.select\(\s*\)/);
  });

  it("projects no PII column and no per-subject id — every read is an aggregate", () => {
    for (const forbidden of [
      "phoneE164",
      "phoneHash",
      "fullName",
      "emailEnc",
      "emailHash",
      "phoneEnc",
      "orgNameEnc",
      "photoStorageKey",
      // No per-row identity leaves this surface at all: the response is counts and ₹ only, so
      // it cannot single anybody out and needs no k-anon floor.
      "workers.id",
      "payers.id",
    ]) {
      expect(REPO_CODE, `admin-dashboard.repository must not project ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });
});
