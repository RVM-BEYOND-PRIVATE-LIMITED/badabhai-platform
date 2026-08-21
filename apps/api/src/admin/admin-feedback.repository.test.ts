import { describe, it, expect } from "vitest";
import { WORKER_FEEDBACK_CATEGORIES } from "@badabhai/types";
import { workerFeedback } from "@badabhai/db";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";
import { encodeEntityCursor } from "./admin-entities.cursor";
import {
  ADMIN_FEEDBACK_PAGE_DEFAULT,
  ADMIN_FEEDBACK_PAGE_MAX,
  AdminFeedbackQuerySchema,
} from "./admin-feedback.dto";

/**
 * SQL-SHAPE tests for the worker-feedback read (#997).
 *
 * These assert on the statement that actually reaches Postgres rather than on rows from a
 * fixture, for the reason the sibling entity suite gives: the properties here are about the
 * QUERY — "this read cannot resolve a worker's identity, for any data" — and a fixture only
 * ever proves it for the rows someone thought to insert. The DB-backed suites are
 * `RUN_DB_TESTS`-gated and do not run in CI, so a fixture here would be a test that never
 * executes.
 *
 * The capture helper is the shared one in `testing/query-capture.ts`; see its header for why
 * the per-file copies it replaced were vacuous.
 */

const CURSOR_TS = "2026-08-19T12:00:00.000Z";
const CURSOR_ID = "80e2b2a0-3633-482b-8f5a-4f092c06e62e";

/**
 * Every column on `workers` that a join would drag in. None may appear in this query — not
 * because they are unlikely to, but because `worker_id` sitting next to free text is exactly
 * the shape that invites someone to "just add the name to the table".
 */
const WORKER_IDENTITY_COLUMNS = ["phone_e164", "phone_hash", "full_name", "photo_storage_key"];

describe("the capture helper is CAPABLE of failing (guards every assertion below)", () => {
  it("records a projected column, so an absence assertion is not vacuous", () => {
    const c = captureQueries();
    c.db.select({ leak: workerFeedback.message } as never);
    expect(c.sql()).toContain("message");
    expect(() => expectColumnsAbsent(c, ["message"])).toThrow(/must never be selected/);
  });
});

describe("the projection — worker-authored text, and an OPAQUE worker", () => {
  it("selects EXACTLY the seven contracted columns — no more, no fewer", async () => {
    // Asserted as an equality, not as seven `toContain` checks: the interface in the dto is the
    // entire contract, so "an eighth column appeared" has to fail here, and a containment
    // assertion cannot see one.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, null, 10);
    // The projection is captured first, one statement per column, before WHERE and ORDER BY.
    expect(c.statements.slice(0, 7)).toEqual([
      '"worker_feedback"."id"',
      '"worker_feedback"."worker_id"',
      '"worker_feedback"."category"',
      '"worker_feedback"."message"',
      '"worker_feedback"."app_build"',
      '"worker_feedback"."screen_context"',
      '"worker_feedback"."created_at"',
    ]);
    // The FROM source is captured too — BP-5 (#1005) taught the harness to record it. Asserting
    // it HERE is what makes "this read has a single source" a property of the projection test
    // rather than an inference from the absence test below: one table, named, with nothing else
    // in scope to project from.
    expect(c.statements[7]).toBe('"worker_feedback"');
    // ...and the only remaining statements on an unfiltered first page are the ORDER BY pair.
    expect(c.statements).toHaveLength(10);
  });

  it("never touches a `workers` identity column, for any filter or cursor combination", async () => {
    // The single sanctioned identity egress is `POST /admin/workers/:id/reveal-contact`. This
    // read is not a second one, and the way to keep that true is for the query to have no
    // route to those columns at all — no join, so nothing to accidentally project.
    for (const filter of [{}, { category: "problem" as const }, { category: "other" as const }]) {
      for (const cursor of [null, { createdAt: CURSOR_TS, id: CURSOR_ID }]) {
        const c = captureQueries();
        await new AdminFeedbackRepository(c.db).list(filter, cursor, 10);
        expectColumnsAbsent(c, WORKER_IDENTITY_COLUMNS);
        expect(c.sql().toLowerCase()).not.toContain("join");
      }
    }
  });

  it("never filters ON the message body — no substring, no full-text search", async () => {
    // The absent feature this pins. `message` may be SELECTED (that is the screen) and must
    // never be SEARCHED: a substring predicate over free text is a PII discovery tool.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({ category: "suggestion" }, null, 10);
    const sql = c.sql().toLowerCase();
    expect(sql).not.toContain("ilike");
    expect(sql).not.toContain("like");
    expect(sql).not.toContain("tsquery");
    expect(sql).not.toContain("similar to");
  });

  it("maps the row to the snake_case wire contract", async () => {
    const created = new Date(CURSOR_TS);
    const c = captureQueries([
      {
        id: "f-1",
        workerId: "w-1",
        category: "problem",
        message: "the supervisor keeps my wages",
        appBuild: "abc1234",
        screenContext: "/jobs/:id/apply",
        createdAt: created,
      },
    ]);
    const [row] = await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(row).toEqual({
      id: "f-1",
      worker_id: "w-1",
      category: "problem",
      message: "the supervisor keeps my wages",
      app_build: "abc1234",
      screen_context: "/jobs/:id/apply",
      created_at: created,
    });
  });

  it("a null category, app_build and screen_context survive the mapping as null", async () => {
    // "Untagged", "build unknown" and "screen unknown" are all real answers — and the last one
    // is what every row written before migration 0081 has. Coercing any of them to a string
    // here would put a value into the ops histogram that no worker ever produced.
    const c = captureQueries([
      {
        id: "f-2",
        workerId: "w-2",
        category: null,
        message: "m",
        appBuild: null,
        screenContext: null,
        createdAt: new Date(CURSOR_TS),
      },
    ]);
    const [row] = await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(row?.category).toBeNull();
    expect(row?.app_build).toBeNull();
    expect(row?.screen_context).toBeNull();
  });
});

describe("ordering and the keyset predicate", () => {
  it("orders NEWEST FIRST on (created_at, id) DESC — the total order the index serves", async () => {
    // Asserted on the ORDER BY terms themselves, in order. A `toContain` over the whole
    // statement would pass on `ORDER BY id DESC, created_at DESC` too — which still looks
    // sorted, pages in insertion-id order, and is "newest first" for nobody. It would also
    // stop matching `worker_feedback_admin_keyset_idx`, turning every page into a sort.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(c.statements.slice(-2)).toEqual([
      '"worker_feedback"."created_at" desc',
      '"worker_feedback"."id" desc',
    ]);
  });

  it("a cursor binds BOTH the timestamp and the id tie-breaker", async () => {
    // Without the id term the predicate is `created_at < t`, which drops every row sharing the
    // boundary timestamp — invisible until a release-day burst puts many rows on one tick.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, { createdAt: CURSOR_TS, id: CURSOR_ID }, 10);
    const sql = c.sql();
    expect(sql).toMatch(/created_at["\s]*<\s*\$/);
    expect(sql).toMatch(/"id"\s*<\s*\$/);
    expect(sql).toMatch(/created_at["\s]*=\s*\$/);
  });

  it("the cursor timestamp reaches the driver ENCODED, never as a raw Date", async () => {
    // The BP-1 post-mortem in `admin-keyset-params.test.ts`: an interpolated sql`` template
    // renders identical SQL and hands postgres-js a `Date`, so every page after the first
    // 500s while page one looks healthy. `lt`/`eq` on the column route it through the
    // column's `mapToDriverValue`, which is what produces the ISO string below.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, { createdAt: CURSOR_TS, id: CURSOR_ID }, 10);
    expect(c.params).toContain(CURSOR_TS);
    expect(c.params.filter((p) => p instanceof Date)).toEqual([]);
  });

  it("no cursor means no WHERE at all — the first page is unpredicated", async () => {
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(c.sql()).not.toMatch(/created_at["\s]*<\s*\$/);
  });
});

describe("the category filter", () => {
  it("binds an equality on `category` when one is requested", async () => {
    for (const category of WORKER_FEEDBACK_CATEGORIES) {
      const c = captureQueries();
      await new AdminFeedbackRepository(c.db).list({ category }, null, 10);
      expect(c.sql()).toMatch(/"category"\s*=\s*\$/);
      expect(c.params).toContain(category);
    }
  });

  it("binds NO category predicate when none is requested", async () => {
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(c.sql()).not.toMatch(/"category"\s*=\s*\$/);
  });

  it("combines the filter AND the cursor — a filtered page two stays filtered", async () => {
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list(
      { category: "problem" },
      { createdAt: CURSOR_TS, id: CURSOR_ID },
      10,
    );
    expect(c.sql()).toMatch(/"category"\s*=\s*\$/);
    expect(c.sql()).toMatch(/created_at["\s]*<\s*\$/);
    expect(c.params).toContain("problem");
  });
});

describe("query contract — bounded and closed", () => {
  it("the page size is hard-capped at 100 and defaults to 50", () => {
    expect(AdminFeedbackQuerySchema.safeParse({ limit: ADMIN_FEEDBACK_PAGE_MAX + 1 }).success).toBe(
      false,
    );
    expect(AdminFeedbackQuerySchema.safeParse({ limit: ADMIN_FEEDBACK_PAGE_MAX }).success).toBe(
      true,
    );
    expect(AdminFeedbackQuerySchema.parse({}).limit).toBe(ADMIN_FEEDBACK_PAGE_DEFAULT);
  });

  it("limit arrives as a query STRING and is coerced, not rejected", () => {
    // Everything on a query string is a string. Without `z.coerce` the cap would be unreachable
    // and every request would 400 — the sort of bug a DTO-only test catches and nothing else.
    expect(AdminFeedbackQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(AdminFeedbackQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("a zero, negative or fractional limit is rejected, never silently clamped", () => {
    for (const limit of ["0", "-1", "2.5", "abc"]) {
      expect(AdminFeedbackQuerySchema.safeParse({ limit }).success, `limit=${limit}`).toBe(false);
    }
  });

  it("an UNKNOWN category is rejected — the request 400s rather than returning everything", () => {
    // The failure mode being refused: an ignored filter shows an operator the unfiltered list
    // while the URL claims otherwise — a wrong answer that looks like a right one. The
    // vocabulary is the shared `WORKER_FEEDBACK_CATEGORIES`, so the reader can never accept a
    // value the writer is unable to produce.
    for (const category of ["spam", "Suggestion", "", "problem "]) {
      expect(AdminFeedbackQuerySchema.safeParse({ category }).success, category).toBe(false);
    }
    for (const category of WORKER_FEEDBACK_CATEGORIES) {
      expect(AdminFeedbackQuerySchema.safeParse({ category }).success).toBe(true);
    }
  });

  it("an unknown query parameter is REJECTED, not ignored (.strict)", () => {
    expect(AdminFeedbackQuerySchema.safeParse({ categoy: "problem" }).success).toBe(false);
    // `q` in particular: the free-text search that must not exist must also not be silently
    // accepted-and-dropped, which is how a client ships a search box that never worked.
    expect(AdminFeedbackQuerySchema.safeParse({ q: "phone" }).success).toBe(false);
    expect(AdminFeedbackQuerySchema.safeParse({ search: "phone" }).success).toBe(false);
    expect(AdminFeedbackQuerySchema.safeParse({ message: "phone" }).success).toBe(false);
  });

  it("ACCEPTS a uuid workerId, and rejects anything that is not one", () => {
    // `workerId` was refused here until the LOOKUP filter shipped, and what changed is not that
    // the rule was relaxed: a substring search takes CONTENT and returns a set of people, while
    // an id filter takes an id the admin already holds and returns a subset of a page they
    // could already read. `q`/`search`/`message` above stay refused — that is the line that
    // must not move, and it is asserted in the same test as the one that did.
    expect(AdminFeedbackQuerySchema.safeParse({ workerId: CURSOR_ID }).success).toBe(true);
    // A non-uuid can only ever fail at BIND against a `uuid` column (22P02) — a 500 for a
    // caller whose address bar is wrong. `.uuid()` turns that into a 400 that says so.
    for (const bad of ["", "not-a-uuid", `${CURSOR_ID}' or '1'='1`, CURSOR_ID.slice(0, 20)]) {
      expect(AdminFeedbackQuerySchema.safeParse({ workerId: bad }).success, bad).toBe(false);
    }
  });

  it("a real cursor round-trips through the schema; an over-long one does not", () => {
    const cursor = encodeEntityCursor({ createdAt: CURSOR_TS, id: CURSOR_ID });
    expect(AdminFeedbackQuerySchema.parse({ cursor }).cursor).toBe(cursor);
    expect(AdminFeedbackQuerySchema.safeParse({ cursor: "x".repeat(257) }).success).toBe(false);
    expect(AdminFeedbackQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });
});

describe("the worker filter — a LOOKUP, and it must not become a search", () => {
  it("binds an equality on `worker_id` when one is requested", async () => {
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({ workerId: CURSOR_ID }, null, 10);
    expect(c.sql()).toMatch(/"worker_id"\s*=\s*\$/);
    expect(c.params).toContain(CURSOR_ID);
  });

  it("binds NO worker predicate when none is requested", async () => {
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({}, null, 10);
    expect(c.sql()).not.toMatch(/"worker_id"\s*=\s*\$/);
  });

  it("combines with the category filter AND the cursor rather than replacing either", async () => {
    // Three independent narrowings on one statement. A builder that overwrote instead of
    // appending would return a page the URL does not describe — and on THIS screen that means
    // showing an operator other workers' free text while the filter claims one worker.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list(
      { category: "problem", workerId: CURSOR_ID },
      { createdAt: CURSOR_TS, id: CURSOR_ID },
      10,
    );
    const sql = c.sql();
    expect(sql).toMatch(/"category"\s*=\s*\$/);
    expect(sql).toMatch(/"worker_id"\s*=\s*\$/);
    expect(sql).toMatch(/created_at["\s]*<\s*\$/);
  });

  it("stays a filter, never a join — the worker is still an opaque id", async () => {
    // The whole reason an id filter is acceptable is that it resolves nothing. If narrowing by
    // worker ever grew a join to `workers` "so the screen can show who it was", this read would
    // become a second identity egress. The query has no route to those columns; this pins it.
    const c = captureQueries();
    await new AdminFeedbackRepository(c.db).list({ workerId: CURSOR_ID }, null, 10);
    expectColumnsAbsent(c, WORKER_IDENTITY_COLUMNS);
    expect(c.sql().toLowerCase()).not.toContain("join");
  });
});
