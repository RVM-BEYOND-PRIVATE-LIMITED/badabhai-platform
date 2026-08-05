import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { ChatRepository } from "./chat.repository";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";

/**
 * DB-free unit of the transaction spine that flush-at-end made load-bearing.
 *
 * WHY THIS FILE EXISTS. `endSession`'s conditional UPDATE is the ONLY thing standing
 * between a retried or concurrent finalization and a DOUBLED transcript. `chat_messages`
 * has no unique key, and the per-message event idempotency keys are built from freshly
 * generated row ids, so they cannot dedupe a second insert either — a duplicate flush
 * would insert every message twice, emit every event twice, and hand extraction a
 * conversation the worker never had.
 *
 * That guarantee was previously asserted only by a `vi.fn()` in chat.service.test.ts
 * that resolved a boolean, i.e. the mock restated the doc-comment rather than testing
 * it. Dropping `eq(status, 'active')` from the WHERE would leave every api test green.
 *
 * Same PgDialect capture-and-compile pattern as pin.repository.test.ts and
 * worker-skills.repository.test.ts — the SQL is rendered and inspected, no Postgres.
 */
function makeCapturingDb() {
  const captured: {
    where?: unknown;
    set?: Record<string, unknown>;
    values?: unknown[];
    returned: boolean;
  } = { returned: false };

  const updateChain = {
    set(payload: Record<string, unknown>) {
      captured.set = payload;
      return {
        where(predicate: unknown) {
          captured.where = predicate;
          return {
            returning() {
              captured.returned = true;
              return Promise.resolve(rowsToReturn);
            },
          };
        },
      };
    },
  };

  const insertChain = {
    values(rows: unknown[]) {
      captured.values = rows;
      return { returning: () => Promise.resolve(rows) };
    },
  };

  let rowsToReturn: unknown[] = [{ id: SESSION }];
  const db = {
    update: vi.fn(() => updateChain),
    insert: vi.fn(() => insertChain),
    transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };
  return {
    db,
    captured,
    /** Simulate the CONDITIONAL update matching no row — i.e. losing the race. */
    setUpdateMatchesNothing() {
      rowsToReturn = [];
    },
  };
}

const renderWhere = (predicate: unknown): string =>
  new PgDialect().sqlToQuery(predicate as never).sql;

describe("ChatRepository.endSession — the duplicate-transcript guard", () => {
  it("scopes the UPDATE to the session AND to status='active'", async () => {
    const { db, captured } = makeCapturingDb();
    const repo = new ChatRepository(db as never);

    await repo.endSession(db as never, SESSION, { turn_count: 4 }, new Date());

    const sql = renderWhere(captured.where);
    // Both terms, ANDed. The id alone is NOT enough: two concurrent finalizations both
    // read 'active' before either writes, so only a conditional write can pick a winner.
    expect(sql).toContain('"id"');
    expect(sql).toContain('"status"');
    expect(sql.toLowerCase()).toContain(" and ");
  });

  it("reports TRUE only when a row was actually updated", async () => {
    const { db } = makeCapturingDb();
    const repo = new ChatRepository(db as never);
    expect(await repo.endSession(db as never, SESSION, {}, new Date())).toBe(true);
  });

  it("reports FALSE when the conditional update matched nothing (the race loser)", async () => {
    // The whole point of `.returning()`: without it there is no way to tell a win from a
    // no-op, and both racers would go on to insert the transcript.
    const h = makeCapturingDb();
    h.setUpdateMatchesNothing();
    const repo = new ChatRepository(h.db as never);
    expect(await repo.endSession(h.db as never, SESSION, {}, new Date())).toBe(false);
  });

  it("marks the session ended and stamps endedAt in the same write", async () => {
    const { db, captured } = makeCapturingDb();
    const repo = new ChatRepository(db as never);
    const at = new Date("2026-07-22T00:00:00.000Z");

    await repo.endSession(db as never, SESSION, { turn_count: 4 }, at);

    // "ended" is the EXISTING CHAT_SESSION_STATUSES value — no new status, so no
    // migration and no client change.
    expect(captured.set).toMatchObject({
      status: "ended",
      endedAt: at,
      lastMessageAt: at,
      conversationState: { turn_count: 4 },
    });
  });
});

describe("ChatRepository.insertMessages", () => {
  it("preserves the order it was given — the transcript IS its order", async () => {
    const { db, captured } = makeCapturingDb();
    const repo = new ChatRepository(db as never);
    const rows = [
      { sessionId: SESSION, workerId: WORKER, direction: "inbound" as const, bodyText: "one" },
      { sessionId: SESSION, workerId: WORKER, direction: "outbound" as const, bodyText: "two" },
      { sessionId: SESSION, workerId: WORKER, direction: "inbound" as const, bodyText: "three" },
    ];

    const out = await repo.insertMessages(db as never, rows as never);

    expect((captured.values as { bodyText: string }[]).map((r) => r.bodyText)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(out).toHaveLength(3);
  });

  it("short-circuits on an empty list instead of issuing an empty INSERT", async () => {
    // Drizzle throws on `.values([])`, so this is a real guard, not a micro-optimization:
    // a blocked-then-abandoned interview flushes zero rows.
    const { db } = makeCapturingDb();
    const repo = new ChatRepository(db as never);
    expect(await repo.insertMessages(db as never, [])).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
