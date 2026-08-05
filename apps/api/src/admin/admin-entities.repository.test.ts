import { describe, it, expect } from "vitest";
import { workers } from "@badabhai/db";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";
import { encodeEntityCursor } from "./admin-entities.cursor";
import { AdminWorkersQuerySchema, AdminPayersQuerySchema } from "./admin-entities.dto";

/**
 * SQL-SHAPE tests for the faceless entity reads.
 *
 * These assert on the statement that actually reaches Postgres, not on rows from a fixture.
 * The properties here are about the QUERY — "this read cannot return a PII column, for any
 * data" — and a fixture only ever proves it for the rows someone thought to insert. The
 * DB-backed suites are also `RUN_DB_TESTS`-gated and do not run in CI, so a fixture here
 * would be a test that never executes.
 *
 * Same technique as `payer-suspension-discovery.test.ts`, which pins the worker-feed status
 * filter the same way.
 */

/**
 * The capture helper lives in `testing/query-capture.ts` — see its header. The version that
 * originally lived HERE was wrong in a way that mattered: it passed each projected value
 * straight to `sqlToQuery`, a bare Drizzle column THROWS when rendered that way, and the
 * throw was swallowed. Projections were therefore never captured, so every assertion below
 * was vacuously true. Measured: adding `fullName: workers.fullName` to the faceless worker
 * projection SURVIVED this entire file. (The source-scanning build-blocker still caught it,
 * so the boundary held — but this layer was doing nothing.)
 */

/** Every column on `workers` / `payers` that must never be PROJECTED. */
const PII_COLUMNS = [
  "phone_e164",
  "phone_hash",
  "full_name",
  "email_enc",
  "email_hash",
  "phone_enc",
  "org_name_enc",
];

/**
 * `photo_storage_key` is the interesting one: it IS referenced, inside an `IS NOT NULL`
 * predicate that reduces it to a boolean in Postgres. Referencing it in a predicate is fine;
 * PROJECTING it (returning its value) is not.
 */
function expectNoProjectedPii(captured: ReturnType<typeof captureQueries>): void {
  expectColumnsAbsent(captured, PII_COLUMNS);
  const bare = /"photo_storage_key"(?!\s+IS\s+NOT\s+NULL)/i;
  expect(
    bare.test(captured.sql()),
    "photo_storage_key may only appear inside an IS NOT NULL test",
  ).toBe(false);
}

describe("the capture helper is CAPABLE of failing (guards every assertion below)", () => {
  it("records a projected column, so an absence assertion is not vacuous", () => {
    const c = captureQueries();
    c.db.select({ leak: workers.fullName } as never);
    expect(c.sql()).toContain("full_name");
    expect(() => expectColumnsAbsent(c, ["full_name"])).toThrow(/must never be selected/);
  });
});

describe("workers read — the faceless projection", () => {
  it("selects no PII column, for any filter combination", async () => {
    for (const filter of [
      {},
      { status: "active" },
      { pendingDeletion: true },
      { status: "suspended", pendingDeletion: true },
    ]) {
      const c = captureQueries();
      await new AdminEntitiesRepository(c.db).listWorkers(filter, null, 10);
      expectNoProjectedPii(c);
    }
  });

  it("the detail read selects no PII column either", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).findWorker("11111111-1111-4111-8111-111111111111");
    expectNoProjectedPii(c);
  });

  it("has_photo is derived by an IS NOT NULL test — the key value is never fetched", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).listWorkers({}, null, 10);
    expect(c.sql()).toMatch(/"photo_storage_key"\s+IS\s+NOT\s+NULL/i);
  });

  it("orders by (created_at, id) DESC — the total order the keyset index serves", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).listWorkers({}, null, 10);
    const s = c.sql();
    expect(s).toContain("created_at");
    expect(s).toContain('"id"');
  });

  it("a cursor binds BOTH the timestamp and the id tie-breaker", async () => {
    // Without the id term the predicate is `created_at < t`, which drops every row sharing the
    // boundary timestamp — invisible until a bulk insert puts thousands on one tick.
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).listWorkers(
      {},
      { createdAt: "2026-08-04T12:00:00.000Z", id: "abc" },
      10,
    );
    const s = c.sql();
    expect(s).toMatch(/created_at["\s]*<\s*\$/);
    expect(s).toMatch(/"id"\s*<\s*\$/);
  });
});

describe("payers read — the faceless projection", () => {
  it("selects no ciphertext or hash column, for any filter combination", async () => {
    for (const filter of [{}, { role: "employer" }, { role: "agent" }, { status: "suspended" }]) {
      const c = captureQueries();
      await new AdminEntitiesRepository(c.db).listPayers(filter, null, 10);
      expectNoProjectedPii(c);
    }
  });

  it("the detail read selects no ciphertext or hash column", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).findPayer("22222222-2222-4222-8222-222222222222");
    expectNoProjectedPii(c);
  });
});

describe("credit ledger — payment_ref is not projected", () => {
  it("the ledger read never selects payment_ref (the one externally-sourced column)", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).listCreditLedger("p1", null, 10);
    expect(c.sql()).not.toContain("payment_ref");
  });

  it("the ledger is scoped by payer_id — never an all-payer money read", async () => {
    const c = captureQueries();
    await new AdminEntitiesRepository(c.db).listCreditLedger("p1", null, 10);
    expect(c.sql()).toContain("payer_id");
  });
});

describe("query contracts — bounded and closed", () => {
  it("the page size is hard-capped at 100", () => {
    expect(AdminWorkersQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(AdminWorkersQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(AdminWorkersQuerySchema.parse({}).limit).toBe(50);
  });

  it("an unknown query parameter is REJECTED, not ignored (.strict)", () => {
    // Silently dropping an unknown filter is how a UI ends up showing an unfiltered list while
    // its URL claims otherwise — a wrong answer that looks like a right one.
    expect(AdminWorkersQuerySchema.safeParse({ statuss: "active" }).success).toBe(false);
    expect(AdminPayersQuerySchema.safeParse({ role: "employer", extra: 1 }).success).toBe(false);
  });

  it("status/role filters accept only known enum values", () => {
    expect(AdminWorkersQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(AdminPayersQuerySchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(AdminPayersQuerySchema.safeParse({ role: "agent" }).success).toBe(true);
  });

  it("a non-uuid id filter is rejected before it reaches the query", () => {
    expect(AdminPayersQuerySchema.safeParse({ role: "agent" }).success).toBe(true);
    const cursorOk = encodeEntityCursor({ createdAt: new Date().toISOString(), id: "x" });
    expect(AdminWorkersQuerySchema.safeParse({ cursor: cursorOk }).success).toBe(true);
  });
});
