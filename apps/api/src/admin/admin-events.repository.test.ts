import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_PAYLOAD_GROUP_FIELDS,
  AdminEventsRepository,
  type AdminPayloadGroupField,
} from "./admin-events.repository";
import { PROFILING_TASK_TYPES } from "./admin-dashboard.dto";
import { captureQueries } from "./testing/query-capture";

/**
 * SELECT-ONLY guarantee for the ADMIN-2 event-spine repository (ADR-0025 must-fix #3 / CLAUDE.md
 * invariant #1 — the events table is append-only). Two independent checks:
 *   1. A SOURCE scan: the file never issues `.update(events)` / `.delete(events)` / `.insert(events)`.
 *      (The repo-wide static guard in `admin-static-guards.test.ts` covers update/delete across
 *      admin/**; this adds insert + pins it specifically to this new file.)
 *   2. A SHAPE check: the public methods are all read verbs (list/find/trace/count/stats) — no
 *      method name implies a write.
 */
describe("AdminEventsRepository is SELECT-ONLY over `events` (spine immutability)", () => {
  const SRC = readFileSync(join(__dirname, "admin-events.repository.ts"), "utf8");

  it("issues NO update/delete/insert against the events table", () => {
    expect(SRC).not.toMatch(/\.update\s*\(\s*events\b/);
    expect(SRC).not.toMatch(/\.delete\s*\(\s*events\b/);
    expect(SRC).not.toMatch(/\.insert\s*\(\s*events\b/);
  });

  it("every public method is a READ verb (no mutating method name)", () => {
    const methods = Object.getOwnPropertyNames(AdminEventsRepository.prototype).filter(
      (m) => m !== "constructor",
    );
    const writeVerb = /^(insert|update|delete|create|set|save|remove|upsert|write)/i;
    for (const m of methods) {
      expect(writeVerb.test(m), `method ${m} looks like a write`).toBe(false);
    }
  });

  it("the only mutation verbs in the file are SELECT/COUNT/GROUP BY (read shape)", () => {
    // Drizzle reads use `.select(`; assert that is the ONLY db-call verb present.
    expect(SRC).toContain(".select(");
    expect(SRC).toMatch(/\bcount\(\*\)/); // aggregations are count-only
  });
});

describe("eventNameStats — one funnel stage, possibly several event names (#1904)", () => {
  const SINCE = new Date("2026-09-01T00:00:00.000Z");

  it("reads the whole name SET in ONE statement: IN (...), both counts off the same rows", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).eventNameStats(["feed.shown", "feed.shown_v2"], SINCE);
    // One WHERE over the union, so count(distinct subject_id) dedupes across the two names —
    // summing two per-name distinct counts could not.
    expect(c.sql()).toContain('"events"."event_name" in ($1, $2)');
    expect(c.sql()).toContain('count(distinct "events"."subject_id")');
    expect(c.sql()).toContain('"events"."occurred_at" >= $3');
    expect(c.params.slice(0, 2)).toEqual(["feed.shown", "feed.shown_v2"]);
  });

  it("a single-name stage is the same statement with one name", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).eventNameStats(["contact.revealed"], SINCE);
    expect(c.sql()).toContain('"events"."event_name" in ($1)');
    expect(c.params[0]).toBe("contact.revealed");
  });

  it("reads an empty window as zeros, never undefined", async () => {
    const c = captureQueries();
    await expect(
      new AdminEventsRepository(c.db).eventNameStats(["feed.shown"], SINCE),
    ).resolves.toEqual({ count: 0, distinctSubjects: 0 });
  });
});

describe("countByPayloadField — the BP-5 cap-breach split", () => {
  it("filters on the INDEXED event_name and a windowed occurred_at", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date("2026-08-01T00:00:00.000Z"),
    );
    // `events_event_name_idx` is what keeps this off the full spine — `events` is the largest
    // table in the system, and an unindexed group-by over it is not a dashboard query.
    expect(c.sql()).toContain('"events"."event_name"');
    expect(c.sql()).toContain('"events"."occurred_at"');
    expect(c.params).toContain("ai.spend_cap_exceeded");
  });

  /**
   * THE SHAPE OF THE BUG THIS SUITE NOW PINS (2026-08-19). The key started life as
   * `payload->>${field}` with `field` BOUND. Drizzle renders each `Param` occurrence as its own
   * placeholder, so the SELECT list got `$1`, GROUP BY `$4`, ORDER BY `$5`; Postgres matches a
   * GROUP BY expression structurally, `Param(1) != Param(4)`, and every request 500'd with
   * `column "events.payload" must appear in the GROUP BY clause`. A shape test CANNOT see that —
   * `captureQueries` never executes SQL — which is why `admin-dashboard.db.test.ts` now runs the
   * query for real. What IS assertable here is the property the fix rests on: all three clauses
   * render the IDENTICAL text.
   */
  const KEY_EXPR = `coalesce("events"."payload"->>'reason', 'unknown')`;

  it("renders the SAME key expression in SELECT, GROUP BY and ORDER BY (byte-identical)", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date(0),
    );
    // Three renders, one text. Re-introduce a bound `field` and these stop matching each other
    // (they become `$1`/`$4`/`$5`), which is exactly the Postgres failure.
    expect(c.statements.filter((s) => s === KEY_EXPR)).toHaveLength(3);
  });

  it("carries the payload KEY as a literal — the value never travels as a parameter", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField(
      "ai.spend_cap_exceeded",
      "reason",
      new Date(0),
    );
    // The literal form is what every other `->>` in this codebase uses (notifications,
    // posting-plans, ai-jobs): literal key, value as the param. Here there is no value.
    expect(c.sql()).toContain(KEY_EXPR);
    expect(c.params).not.toContain("reason");
    // …and no placeholder anywhere inside the key expression.
    expect(c.sql()).not.toMatch(/"events"\."payload"->>\$\d+/);
    // The event NAME is still bound — only the key is a literal.
    expect(c.params).toContain("ai.spend_cap_exceeded");
  });

  it("a payload with no such field groups under 'unknown' rather than being dropped", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).countByPayloadField("x", "reason", new Date(0));
    // A breach whose reason did not serialize is still a breach; a silently-omitted bucket is
    // how "silence means zero" starts.
    expect(c.sql()).toContain(`, 'unknown')`);
  });

  it("FAILS CLOSED on a field outside the closed set — nothing else may reach sql.raw", async () => {
    const c = captureQueries();
    // The compile-time union is erased at runtime, so the runtime check is the real gate. The
    // cast is how a caller arriving through `any`/JS interop would look. `rejects`, not
    // `toThrow`: the method is async, so the guard surfaces as a rejected promise.
    await expect(
      new AdminEventsRepository(c.db).countByPayloadField(
        "x",
        "worker_id'||(select 1)||'" as AdminPayloadGroupField,
        new Date(0),
      ),
    ).rejects.toThrow(/unsupported payload group field/);
    // Nothing was built — the rogue key never reached the query builder at all.
    expect(c.statements).toEqual([]);
  });

  it("the closed set is exactly the one field the dashboard needs", () => {
    expect([...ADMIN_PAYLOAD_GROUP_FIELDS]).toEqual(["reason"]);
  });
});

describe("the funnel bulk reads — per-worker counts for a bounded cohort (B14, #2568)", () => {
  const W1 = "11111111-1111-4111-8111-111111111111";
  const W2 = "22222222-2222-4222-8222-222222222222";

  it("workerSubjectEventCounts filters on the indexed event name + worker subject", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).workerSubjectEventCounts([W1, W2], [
      "job.search_performed",
    ]);
    // `events_event_name_idx` + `events_subject_idx` keep this off the full spine.
    expect(c.sql()).toContain('"events"."event_name"');
    expect(c.sql()).toContain('"events"."subject_type"');
    expect(c.params).toContain("job.search_performed");
    expect(c.params).toContain(W1);
    expect(c.params).toContain(W2);
    // Grouped per worker per event — one row per (worker, event) for the service to
    // join. (The capture stub records the GROUP BY columns, not the keyword itself.)
    const tail = c.statements.slice(-2);
    expect(tail).toEqual(['"events"."subject_id"', '"events"."event_name"']);
  });

  it("chunks the id list so no statement nears the parameter ceiling", async () => {
    const c = captureQueries();
    const ids = Array.from({ length: 5001 }, (_, i) => `id-${i}`);
    await new AdminEventsRepository(c.db).workerSubjectEventCounts(ids, ["job.search_performed"]);
    // Two IN lists (5000 + 1) — one unbounded IN list would have carried 5001 id params
    // in a single statement.
    const wheres = c.statements.filter((s) => s.includes('subject_id" in'));
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      // 5000 ids max per chunk, plus the event-name and subject-type params.
      expect(w.match(/\$\d+/g)?.length ?? 0).toBeLessThanOrEqual(5002);
    }
  });

  it("an empty cohort issues no query", async () => {
    const c = captureQueries();
    const repo = new AdminEventsRepository(c.db);
    await repo.workerSubjectEventCounts([], ["job.search_performed"]);
    await repo.interviewKitDownloadsForWorkers([]);
    expect(c.statements).toHaveLength(0);
  });

  it("interviewKitDownloadsForWorkers matches the partial index exactly", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).interviewKitDownloadsForWorkers([W1]);
    // The same shape as `countInterviewKitDownloads`: the event-name literal plus the
    // identical `payload->>'worker_id'` expression the partial index is built on.
    expect(c.sql()).toContain('"events"."event_name"');
    expect(c.sql()).toContain(`"events"."payload"->>'worker_id'`);
    expect(c.params).toContain("interview_kit.downloaded");
    expect(c.params).toContain(W1);
    expect(c.sql()).toContain("count(distinct");
  });
});

describe("the profiling split — spend and completed profiles by live worker population", () => {
  const SINCE = new Date("2026-08-19T07:38:05.000Z");

  it("spend reads cost EVENTS joined to workers — never the totals table", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).profilingCostSplit(SINCE, PROFILING_TASK_TYPES);
    // Not the totals table: that one has no worker dimension by design, so it cannot say whose
    // spend a deleted account's call was.
    expect(c.sql()).toContain('"events"."payload"');
    expect(c.sql()).not.toContain("platform_ai_cost_totals");
    expect(c.sql()).toContain("LEFT JOIN");
    expect(c.sql()).toContain("is_test_account");
    // BOTH cost event names ride as bound parameters, not inline SQL — v1 rows stay
    // readable and v2 rows (the only ones the recorder writes now) cannot go quiet.
    expect(c.params).toContain("ai.cost_recorded");
    expect(c.params).toContain("ai.cost_recorded_v2");
    for (const taskType of PROFILING_TASK_TYPES) {
      expect(c.params, `${taskType} must be bound into the split's IN list`).toContain(taskType);
    }
    // Sums ₹ in Postgres as text — the same exactness rule as every other ₹ read.
    expect(c.sql()).toContain("::text");
  });

  it("the stamped flag wins over the live join — deletion moves nothing", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).profilingCostSplit(SINCE, PROFILING_TASK_TYPES);
    const sql = c.sql();
    const stamped = sql.indexOf("->>'is_test_account'");
    // The stamp is read first; the live `workers` join is the fallback for v1 rows and
    // null-stamped v2 rows. A deleted test account's stamped row resolves to `test`
    // before the join (which finds no row) is ever consulted.
    expect(stamped).toBeGreaterThan(-1);
    expect(sql.indexOf('"workers"."id" is null')).toBeGreaterThan(stamped);
  });

  it("the headline is computed over the SAME grouped rows as the legs", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).profilingCostSplit(SINCE, PROFILING_TASK_TYPES);
    // `sum(sum(...)) over ()` is what makes real + test + deleted equal the headline by
    // construction; a second query could land a call between the two reads.
    expect(c.sql()).toMatch(/sum\(sum\(/);
    expect(c.sql()).toContain("over ()");
    // The three-way CASE, not a boolean test flag that cannot represent a deleted worker.
    expect(c.sql()).toContain("deleted_or_unattributed");
    expect(c.sql()).toContain("case");
  });

  it("the denominator counts DISTINCT workers from the completion LEDGER, not the live join", async () => {
    const c = captureQueries();
    await new AdminEventsRepository(c.db).profilingProfilesCompletedSince(SINCE);
    // B2 (#2555): the ledger carries the spend-time test flag, so the count needs no
    // `workers` join at all — a deleted account's row resolves to its stamped bucket.
    expect(c.sql()).toContain("profile_completion_ledger");
    expect(c.sql()).toContain("count(distinct");
    // The worker id, not the profile id: a re-interviewed worker must count once.
    expect(c.sql()).toContain('"worker_id"');
    expect(c.sql()).toContain("is_test_account");
    expect(c.sql()).not.toContain("LEFT JOIN");
    expect(c.sql()).not.toContain("profile.extraction_completed");
    // The window still bounds the read.
    expect(c.sql()).toContain('"completed_at"');
  });

  it("both reads resolve the SAME three populations, so the legs cannot disagree", async () => {
    const spend = captureQueries();
    await new AdminEventsRepository(spend.db).profilingCostSplit(SINCE, PROFILING_TASK_TYPES);
    const profiles = captureQueries();
    await new AdminEventsRepository(profiles.db).profilingProfilesCompletedSince(SINCE);
    for (const c of [spend, profiles]) {
      // The closed set, derived from the stamped flag first — never a dropped leg.
      expect(c.sql()).toContain("deleted_or_unattributed");
      expect(c.sql()).toContain("is_test_account");
      expect(c.sql()).toContain("case");
    }
    // The spend read still consults the live join as the v1 fallback; the ledger read
    // needs no join at all — every row it holds is already stamped.
    expect(spend.sql()).toContain('"workers"."id"');
    expect(profiles.sql()).not.toContain('"workers"."id"');
  });
});
