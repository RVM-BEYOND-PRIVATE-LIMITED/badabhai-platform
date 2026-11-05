import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminFunnelRepository } from "./admin-funnel.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";

const SRC = readFileSync(join(__dirname, "admin-funnel.repository.ts"), "utf8");
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const FILTER = { testAccounts: "exclude" as const };

/**
 * The funnel repository's contract — SELECT-ONLY, spine-free, and index-backed.
 *
 * ── WHY SOURCE SCANS BESIDE SHAPE ASSERTIONS ───────────────────────────────────────
 * `events` has exactly ONE admin reader (`AdminEventsRepository`, build-blocked in
 * `admin-static-guards.test.ts`). This file reads every other funnel table; a
 * `.from(events)` here would make two readers and silently break the invariant the
 * blocker exists to hold. The scan below fails the day that happens. Likewise the
 * write-verb scan: an aggregate that writes is a corruption path, not an optimization.
 */
describe("AdminFunnelRepository is SELECT-ONLY and spine-free", () => {
  it("issues no write against any table", () => {
    expect(SRC).not.toMatch(/\.(insert|update|delete)\s*\(/);
  });

  it("never reads the event spine (the single-reader invariant holds)", () => {
    const code = SRC.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code).not.toMatch(/\.from\s*\(\s*events\s*\)/);
    // …and never through a raw `from "events"` either.
    expect(code).not.toMatch(/from\s+"events"/);
  });

  it("projects no PII column — ids, labels, counts and booleans only", async () => {
    const c = captureQueries();
    const repo = new AdminFunnelRepository(c.db);
    await repo.listCohort(FILTER);
    await repo.primaryTradeByWorker([W1]);
    await repo.appVersionByWorker([W1]);
    await repo.stampedPairsByWorker([W1]);
    await repo.itemKeysByPair([{ packId: "qp_welding", packVersion: 1 }]);
    await repo.settledKeysByWorker([W1]);
    await repo.prefilledCityWorkers([W1]);
    await repo.resumeFlags([W1]);
    await repo.profileStatuses([W1]);
    await repo.applicationFlags([W1]);
    expectColumnsAbsent(c, [
      "phone_e164",
      "phone_hash",
      "full_name",
      "email_enc",
      "email_hash",
      "phone_enc",
      "answer_text",
      "answer_number",
      "answer_bool",
      "answer_option_keys",
      // `conversation_state` is asserted separately below: it may appear inside a
      // jsonb predicate (the prefilled-seed check), never as a fetched value.
      "body_text",
      "transcript_text",
      "device_hash",
      "push_token",
    ]);
  });

  it("conversation_state is reduced inside jsonb predicates — never fetched", async () => {
    // The city-seed check reads `conversation_state -> 'prefilled_keys'` in SQL and
    // projects only the worker id. The blob holds verbatim answers, so the column name
    // may appear ONLY inside a `->` projection, never as a bare selected value.
    const c = captureQueries();
    const repo = new AdminFunnelRepository(c.db);
    await repo.prefilledCityWorkers([W1]);
    expect(c.sql()).toContain("conversation_state");
    const bare = c
      .sql()
      .split("conversation_state")
      .slice(1)
      .filter((tail) => !tail.startsWith('" ->'));
    expect(bare, "conversation_state outside a -> projection").toEqual([]);
  });

  it("the photo key is reduced to a boolean IN POSTGRES — never fetched", async () => {
    // The per-worker journey's `findWorkerCore` rule: `photo_storage_key IS NOT NULL`
    // in SQL is a boolean about a face photo; selecting the column would put the
    // pointer in this process one spread away from a response. So the column name may
    // appear ONLY inside that reduction.
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).listCohort(FILTER);
    expect(c.sql()).toContain("photo_storage_key");
    const bare = c
      .sql()
      .split("photo_storage_key")
      .slice(1)
      .filter((tail) => !tail.startsWith('" IS NOT NULL'));
    expect(bare, "photo_storage_key outside an IS NOT NULL reduction").toEqual([]);
  });
});

describe("listCohort — the single source of who is in the base", () => {
  it("bounds sign-up with the admin keyset's range shape and excludes test traffic by default", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).listCohort({
      signupFrom: new Date("2026-09-01T00:00:00.000Z"),
      signupTo: new Date("2026-10-01T00:00:00.000Z"),
      testAccounts: "exclude",
    });
    expect(c.sql()).toContain('"workers"."created_at" >= ');
    expect(c.sql()).toContain('"workers"."created_at" < ');
    expect(c.sql()).toContain('"workers"."is_test_account"');
    expect(c.params).toContain(false);
  });

  it("testAccounts=only flips the predicate (an include is never the default)", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).listCohort({ testAccounts: "only" });
    expect(c.params).toContain(true);
    expect(c.sql()).not.toContain("created_at");
  });

  it("testAccounts=include names no test predicate at all", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).listCohort({ testAccounts: "include" });
    expect(c.sql()).not.toMatch(/is_test_account/);
  });
});

describe("per-worker grouped reads — one bounded statement each, cohort by id", () => {
  it("match workers with an indexed IN list, never an unbounded scan", async () => {
    const c = captureQueries();
    const repo = new AdminFunnelRepository(c.db);
    await repo.primaryTradeByWorker([W1, W2]);
    await repo.appVersionByWorker([W1, W2]);
    await repo.stampedPairsByWorker([W1, W2]);
    await repo.settledKeysByWorker([W1, W2]);
    await repo.prefilledCityWorkers([W1, W2]);
    await repo.resumeFlags([W1, W2]);
    await repo.profileStatuses([W1, W2]);
    await repo.applicationFlags([W1, W2]);
    // One `in ($1, $2)`-shaped predicate per read — the worker side is always the
    // indexed column, never a sequential scan.
    expect(c.sql().match(/ in \(\$\d+(, \$\d+)*\)/g)?.length).toBeGreaterThanOrEqual(8);
    // …and the ids travel as bound parameters, never interpolated.
    expect(c.params).toContain(W1);
    expect(c.params).toContain(W2);
  });

  it("the current profile resolves per worker with CURRENT_PROFILE_ORDER (never recency alone)", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).profileStatuses([W1]);
    // DISTINCT ON (worker_id) + the shared order: non-draft first, newest wins.
    // (`captureQueries` records the ON columns and the ORDER BY, not the DISTINCT ON
    // keyword itself — the tail below is the load-bearing half.)
    const tail = c.statements.slice(-4);
    expect(tail).toEqual([
      '"worker_profiles"."worker_id"',
      `("worker_profiles"."profile_status" <> 'draft') desc`,
      '"worker_profiles"."created_at" desc',
      '"worker_profiles"."id" desc',
    ]);
  });

  it("item counts read the exact stamped versions (a retired pack contributes no items)", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).itemKeysByPair([
      { packId: "qp_welding", packVersion: 1 },
      { packId: "qp_universal", packVersion: 3 },
    ]);
    expect(c.sql()).toContain('"question_pack_item"."pack_id"');
    expect(c.sql()).toContain('"question_pack_item"."pack_version"');
    expect(c.params).toContain("qp_welding");
    expect(c.params).toContain("qp_universal");
  });

  it("settled keys count DISTINCT settled statuses only (rows are not progress)", async () => {
    const c = captureQueries();
    await new AdminFunnelRepository(c.db).settledKeysByWorker([W1]);
    expect(c.sql()).toMatch(/distinct/i);
    expect(c.sql()).toContain("'answered'");
    expect(c.sql()).toContain("'declined'");
  });
});
