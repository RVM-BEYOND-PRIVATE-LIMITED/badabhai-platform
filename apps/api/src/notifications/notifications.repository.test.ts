import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { events, type Database } from "@badabhai/db";
import { NotificationsRepository } from "./notifications.repository";
import { NOTIFICATION_EVENT_NAMES } from "./notifications.dto";

/**
 * STRUCTURAL tests for the Alerts feed read (the worker-scoping predicate + the
 * no-payload projection). The service tests mock this repository, so BOTH guarantees
 * live in the QUERY itself and are untestable from there:
 *
 *   1. WORKER SCOPING — the OR over (subject | actor | payload->>'worker_id').
 *   2. PROJECTION DISCIPLINE — the event `payload` is never SELECTed.
 *
 * We capture the Drizzle fluent chain and compile the captured condition with
 * PgDialect (the reach/pin.repository.test.ts pattern) — no Postgres required.
 *
 * SCOPE NOTE: this proves the predicate's SHAPE and its BOUND PARAMS, not executed
 * Postgres semantics. That is the strongest offline proof available here, and it is
 * the one that catches the real regression: a dropped/loosened leg.
 */

const dialect = new PgDialect();
const compile = (cond: unknown): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
};

type Captured = {
  selection?: Record<string, unknown>;
  from?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
};

/** Capturing mock of the findForWorker chain: select().from().where().orderBy().limit(). */
function makeDb(rows: unknown[] = []) {
  const captured: Captured = {};
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: (table: unknown) => {
          captured.from = table;
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              return {
                orderBy: (...order: unknown[]) => {
                  captured.orderBy = order;
                  return {
                    // The awaited terminal link.
                    limit: (n: number) => {
                      captured.limit = n;
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function runFor(workerId: string, limit = 50) {
  const { db, captured } = makeDb([]);
  await new NotificationsRepository(db).findForWorker(workerId, limit);
  return captured;
}

describe("NotificationsRepository.findForWorker — PROJECTION never selects the payload", () => {
  it("reads the events table", async () => {
    const captured = await runFor(WORKER_A);
    expect(captured.from).toBe(events);
  });

  it("SELECTs EXACTLY id/eventName/occurredAt — adding `payload` to the projection fails this", async () => {
    const captured = await runFor(WORKER_A);
    expect(Object.keys(captured.selection!).sort()).toEqual(["eventName", "id", "occurredAt"]);
  });

  it("never selects payload or any identifier column (defense in depth — PII cannot enter API memory)", async () => {
    const captured = await runFor(WORKER_A);
    for (const banned of [
      "payload",
      "actorId",
      "actorType",
      "subjectId",
      "subjectType",
      "metadata",
      "correlationId",
      "causationId",
      "idempotencyKey",
    ]) {
      expect(captured.selection, `projection must not select ${banned}`).not.toHaveProperty(banned);
    }
  });
});

describe("NotificationsRepository.findForWorker — the allowlist IS the query filter", () => {
  it("filters event_name IN the DERIVED allowlist (application.submitted included)", async () => {
    const { sql, params } = compile((await runFor(WORKER_A)).where);
    expect(sql).toContain('"events"."event_name" in');
    expect(params).toContain("application.submitted");
    // Every allowlisted name is bound — the filter cannot drift from the templates.
    for (const name of NOTIFICATION_EVENT_NAMES) {
      expect(params, `${name} must be a bound filter param`).toContain(name);
    }
  });

  it("binds NO event name outside the allowlist", async () => {
    const { params } = compile((await runFor(WORKER_A)).where);
    const boundNames = params.filter(
      (p): p is string => typeof p === "string" && p.includes("."),
    );
    expect(boundNames.sort()).toEqual([...NOTIFICATION_EVENT_NAMES].sort());
  });
});

describe("NotificationsRepository.findForWorker — WORKER SCOPING (cross-worker isolation)", () => {
  it("scopes with the three-leg OR: subject(worker) | actor(worker) | payload->>'worker_id'", async () => {
    const { sql } = compile((await runFor(WORKER_A)).where);
    // Subject leg — gated on subject_type = 'worker'.
    expect(sql).toContain('"events"."subject_type" = ');
    expect(sql).toContain('"events"."subject_id" = ');
    // Actor leg — gated on actor_type = 'worker'.
    expect(sql).toContain('"events"."actor_type" = ');
    expect(sql).toContain('"events"."actor_id" = ');
    // Payload leg — the JSON text extraction.
    expect(sql).toContain(`"events"."payload"->>'worker_id' = `);
    expect(sql.toLowerCase()).toContain(" or ");
  });

  it("EVERY worker leg binds the CALLER's id — no leg is unscoped", async () => {
    const { params } = compile((await runFor(WORKER_A)).where);
    const occurrences = params.filter((p) => p === WORKER_A).length;
    // subject_id + actor_id + payload->>'worker_id' == 3 bindings of the caller.
    expect(occurrences).toBe(3);
  });

  it("binds ONLY the caller's id — worker B's rows can never satisfy worker A's predicate", async () => {
    const a = compile((await runFor(WORKER_A)).where);
    const b = compile((await runFor(WORKER_B)).where);

    // Same SQL text, different bound identity — the query is parameterized by caller.
    expect(a.sql).toBe(b.sql);
    expect(a.params).not.toContain(WORKER_B);
    expect(b.params).not.toContain(WORKER_A);
  });

  it("application.submitted SHAPE (subject_type='job'): only the ACTOR + PAYLOAD legs can match — the subject leg is gated on 'worker'", async () => {
    const { params } = compile((await runFor(WORKER_A)).where);
    // Both type-gates bind the literal 'worker'. An application.submitted row has
    // subject_type='job', so it can NEVER match via the subject leg — it surfaces
    // only through actor_id (=worker) or payload->>'worker_id'. Both are the
    // caller's id, so another worker's apply is unreachable.
    expect(params.filter((p) => p === "worker")).toHaveLength(2);
    expect(params).not.toContain("job");
  });
});

describe("NotificationsRepository.findForWorker — bounded, newest first", () => {
  it("orders by occurred_at DESC then id DESC and applies the caller's limit", async () => {
    const captured = await runFor(WORKER_A, 50);
    expect(captured.limit).toBe(50);
    expect(captured.orderBy).toHaveLength(2);
    const [first, second] = captured.orderBy!.map((o) => compile(o).sql);
    expect(first).toContain('"events"."occurred_at" desc');
    expect(second).toContain('"events"."id" desc');
  });

  it("returns the DB rows verbatim — no client-side re-filtering", async () => {
    const rows = [{ id: "e1", eventName: "application.submitted", occurredAt: new Date() }];
    const { db } = makeDb(rows);
    const out = await new NotificationsRepository(db).findForWorker(WORKER_A, 50);
    expect(out).toBe(rows);
  });
});
