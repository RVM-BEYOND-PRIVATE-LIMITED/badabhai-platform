import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { AdminAiTracesRepository } from "./admin-ai-traces.repository";

/**
 * REGRESSION GUARD — keyset cursors must bind DRIVER-ENCODABLE parameters.
 *
 * ── THE BUG THIS EXISTS FOR (found live, 2026-08-04) ────────────────────────────────────
 * Both admin keyset readers built their `<` term as an interpolated template:
 *
 *     sql`${events.occurredAt} < ${someDate}`      // ✗
 *     lt(events.occurredAt, someDate)              // ✓
 *
 * The two render IDENTICAL SQL (`"occurred_at" < $1`). The difference is invisible in the
 * statement and lives entirely in the bound parameter: the template hands the value to the
 * driver RAW, while `lt(column, value)` routes it through that column's `mapToDriverValue`,
 * which is what turns a `Date` into the ISO string postgres-js requires. The raw form made
 * postgres-js throw `The "string" argument must be of type string or an instance of Buffer or
 * ArrayBuffer. Received an instance of Date`, so EVERY request carrying a cursor returned 500.
 *
 * Page one has no cursor, so it worked — the events explorer looked healthy and only "Next"
 * was broken. It shipped that way in ADMIN-2 and survived a review, a full unit suite, and a
 * live Milestone-2 verification that never clicked past the first page.
 *
 * ── WHY THIS TEST IS SHAPED LIKE THIS ───────────────────────────────────────────────────
 * A SQL-shape test cannot catch it: `sqlToQuery().sql` is byte-identical either way. The only
 * observable difference short of a real database is in `sqlToQuery().params` — so that is what
 * is asserted. A raw `Date` (or any non-primitive) in the bound parameters means some value is
 * reaching the driver without its column's encoder.
 */

const dialect = new PgDialect();

/** Capture the rendered parameters — and the SQL TEXT — of every SELECT a call issues. */
function makeDb() {
  const params: unknown[] = [];
  const sqlText: string[] = [];
  const capture = (q: unknown) => {
    try {
      const rendered = dialect.sqlToQuery(q as SQL);
      params.push(...rendered.params);
      sqlText.push(rendered.sql);
    } catch {
      /* not a renderable fragment */
    }
  };

  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: unknown) => {
      if (w !== undefined) capture(w);
      return chain;
    },
    orderBy: () => chain,
    limit: async () => [],
    then: (resolve: (v: unknown[]) => unknown) => resolve([]),
  };

  const db = {
    select: (projection?: Record<string, unknown>) => {
      if (projection) Object.values(projection).forEach(capture);
      return chain;
    },
  } as unknown as Database;

  return { db, params, sqlText };
}

/**
 * Every bound parameter must be a primitive (or null). Anything else — a `Date`, a plain
 * object, an array — is a value that skipped its column's driver mapping.
 */
function expectAllEncodable(params: unknown[], where: string): void {
  const raw = params.filter(
    (p) => p !== null && (typeof p === "object" || typeof p === "function"),
  );
  expect(
    raw.map((p) => (p instanceof Date ? `Date(${p.toISOString()})` : String(p))),
    `${where}: these parameters reach the driver unmapped — use lt()/eq()/gte(), not an interpolated sql\`\` template`,
  ).toEqual([]);
}

const CURSOR_TS = "2026-08-04T12:00:00.000Z";
const CURSOR_ID = "80e2b2a0-3633-482b-8f5a-4f092c06e62e";

describe("BP-1 entity keysets bind encodable parameters", () => {
  const cursor = { createdAt: CURSOR_TS, id: CURSOR_ID };

  it("listWorkers with a cursor", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listWorkers({}, cursor, 10);
    expectAllEncodable(m.params, "listWorkers");
  });

  it("listPayers with a cursor", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listPayers({}, cursor, 10);
    expectAllEncodable(m.params, "listPayers");
  });

  it("listJobPostings with a cursor", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listJobPostings({}, cursor, 10);
    expectAllEncodable(m.params, "listJobPostings");
  });

  it("listApplications with a cursor", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listApplications({}, cursor, 10);
    expectAllEncodable(m.params, "listApplications");
  });

  it("listCreditLedger with a cursor", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listCreditLedger("p1", cursor, 10);
    expectAllEncodable(m.params, "listCreditLedger");
  });

  it("the timestamp is bound as an ISO string, not a Date object", async () => {
    const m = makeDb();
    await new AdminEntitiesRepository(m.db).listWorkers({}, cursor, 10);
    expect(m.params).toContain(CURSOR_TS);
  });
});

describe("#997 feedback keyset binds encodable parameters", () => {
  const cursor = { createdAt: CURSOR_TS, id: CURSOR_ID };

  it("list with a cursor", async () => {
    const m = makeDb();
    await new AdminFeedbackRepository(m.db).list({}, cursor, 10);
    expectAllEncodable(m.params, "AdminFeedbackRepository.list");
  });

  it("a FILTERED page is equally safe (the category clause joins the same WHERE)", async () => {
    const m = makeDb();
    await new AdminFeedbackRepository(m.db).list({ category: "problem" }, cursor, 10);
    expectAllEncodable(m.params, "AdminFeedbackRepository.list (filtered)");
  });

  it("the timestamp is bound as an ISO string, not a Date object", async () => {
    const m = makeDb();
    await new AdminFeedbackRepository(m.db).list({}, cursor, 10);
    expect(m.params).toContain(CURSOR_TS);
  });
});

describe("ADMIN-2 event-spine keyset binds encodable parameters (the shipped bug)", () => {
  it("listKeyset with a cursor", async () => {
    const m = makeDb();
    await new AdminEventsRepository(m.db).listKeyset({}, 10, {
      occurredAt: CURSOR_TS,
      id: CURSOR_ID,
    });
    expectAllEncodable(m.params, "AdminEventsRepository.listKeyset");
  });

  it("listKeyset binds the cursor timestamp as an ISO string", async () => {
    const m = makeDb();
    await new AdminEventsRepository(m.db).listKeyset({}, 10, {
      occurredAt: CURSOR_TS,
      id: CURSOR_ID,
    });
    expect(m.params).toContain(CURSOR_TS);
  });

  it("a filtered keyset page is equally safe (date-range filters use gte/lte already)", async () => {
    const m = makeDb();
    await new AdminEventsRepository(m.db).listKeyset(
      { occurredFrom: new Date("2026-01-01T00:00:00Z"), occurredTo: new Date("2026-12-31T00:00:00Z") },
      10,
      { occurredAt: CURSOR_TS, id: CURSOR_ID },
    );
    expectAllEncodable(m.params, "AdminEventsRepository.listKeyset (filtered)");
  });
});

/**
 * Phase 6 — the worker-journey session list is the FOURTH keyset on this surface, and the
 * first one keyed on `started_at`. It is registered here rather than trusted to look right,
 * because the failure mode this file documents is invisible to every other layer: identical
 * SQL, correct-looking code, and a 500 on page two only.
 */
describe("Phase 6 journey keyset binds encodable parameters", () => {
  const WORKER = "11111111-1111-4111-8111-111111111111";

  it("listSessions with a cursor", async () => {
    const m = makeDb();
    await new AdminWorkerJourneyRepository(m.db).listSessions(
      WORKER,
      {},
      { occurredAt: CURSOR_TS, id: CURSOR_ID },
      10,
    );
    expectAllEncodable(m.params, "AdminWorkerJourneyRepository.listSessions");
  });

  it("listSessions binds the cursor timestamp as an ISO string", async () => {
    const m = makeDb();
    await new AdminWorkerJourneyRepository(m.db).listSessions(
      WORKER,
      {},
      { occurredAt: CURSOR_TS, id: CURSOR_ID },
      10,
    );
    expect(m.params).toContain(CURSOR_TS);
  });

  it("a status-filtered page is equally safe", async () => {
    const m = makeDb();
    await new AdminWorkerJourneyRepository(m.db).listSessions(
      WORKER,
      { status: "abandoned" },
      { occurredAt: CURSOR_TS, id: CURSOR_ID },
      10,
    );
    expectAllEncodable(m.params, "AdminWorkerJourneyRepository.listSessions (filtered)");
  });
});

/**
 * 0083 — the same class of defect, one layer deeper, and it was LIVE on this branch.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────────────────
 * `ai_call_traces.created_at` is `timestamptz`, which Postgres keeps to MICROSECOND precision.
 * postgres-js returns it as a JS `Date`, which holds MILLISECONDS, and the cursor was minted
 * from `row.created_at.toISOString()`. So the bound was always ≤ the real value of the row it
 * described, and every remaining row inside that millisecond failed BOTH halves of the keyset
 * predicate — not `< at`, and not `= at` either, which is exactly what stops the `id`
 * tie-breaker from saving it. Those rows were dropped permanently, with a `nextCursor` that
 * looked healthy.
 *
 * Measured against a live Postgres: six rows seeded inside one millisecond, page size 2 →
 * 2 returned, 4 skipped, second page empty. And under 60 concurrent `AiTraceRecorder.capture()`
 * calls — one busy minute of interviews — 14 milliseconds held more than one trace. This is the
 * one table on the spine written concurrently by every request path AND every queue worker, so
 * sub-millisecond collisions are its normal case rather than its edge case.
 *
 * ── WHERE THE DIGITS ACTUALLY GO, measured rather than assumed ──────────────────────────
 * Not the wire. On a drizzle-wrapped client — which is every connection this app has, because
 * `createDbClient` calls `drizzle(sql)` immediately — postgres-js delivers a `timestamptz` as a
 * RAW STRING with all six digits. It is drizzle's own `timestamp(..., { mode: "date" })` mapper
 * that turns it into a `Date` and drops them. So the load-bearing half of the fix is the
 * PROJECTION: `to_char(... .US ...)`, rendered by Postgres, because by the time a row is in JS
 * the microseconds no longer exist to recover.
 *
 * `::text::timestamptz` on the bind side is belt to that brace. On a BARE postgres-js client
 * `$1::timestamptz` genuinely does truncate (Postgres resolves the parameter as oid 1184, and
 * postgres-js applies its own `date` serializer, round-tripping through `new Date`); on a
 * wrapped one both forms are correct. Measured both ways, and pinned here because a repository
 * should not silently depend on a mutation another library performs on a shared connection.
 */
describe("0083 ai-trace keyset survives the driver's timestamp serializer", () => {
  const cursor = { createdAt: "2026-08-04T12:00:00.000600Z", id: CURSOR_ID };

  it("binds encodable parameters (the original BP-1 property)", async () => {
    const m = makeDb();
    await new AdminAiTracesRepository(m.db).list({}, cursor, 10);
    expectAllEncodable(m.params, "AdminAiTracesRepository.list");
  });

  it("binds the cursor timestamp at FULL microsecond precision, not a truncated Date", async () => {
    const m = makeDb();
    await new AdminAiTracesRepository(m.db).list({}, cursor, 10);
    expect(m.params).toContain("2026-08-04T12:00:00.000600Z");
    // The old form, byte for byte, so a revert to `new Date(cursor.createdAt)` fails here.
    expect(m.params).not.toContain("2026-08-04T12:00:00.000Z");
    for (const p of m.params) expect(p, "no Date may reach the driver").not.toBeInstanceOf(Date);
  });

  it("casts the bound cursor through ::text FIRST — correct on a wrapped OR bare client", async () => {
    const m = makeDb();
    await new AdminAiTracesRepository(m.db).list({}, cursor, 10);
    const where = m.sqlText.join(" ");
    expect(where, "the cursor bound must be ::text::timestamptz").toContain("::text::timestamptz");
  });

  it("projects the sort key from POSTGRES at microsecond precision, not from the Date", async () => {
    // The other half. Even with a correct bound, a cursor minted from the returned JS `Date`
    // is already truncated — the microseconds do not survive the driver, so the only place the
    // full-precision string can be made is inside the query.
    const m = makeDb();
    await new AdminAiTracesRepository(m.db).list({}, cursor, 10);
    const projected = m.sqlText.join(" ");
    expect(projected).toContain("to_char");
    expect(projected, "US = microseconds; MS would truncate exactly as the Date did").toContain(
      ".US",
    );
  });

  it("an unfiltered first page (no cursor) binds nothing unencodable either", async () => {
    const m = makeDb();
    await new AdminAiTracesRepository(m.db).list({}, null, 10);
    expectAllEncodable(m.params, "AdminAiTracesRepository.list (first page)");
  });
});
