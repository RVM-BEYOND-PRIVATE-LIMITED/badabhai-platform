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
    expect(captured.set).toMatchObject({ status: "ended", endedAt: at, lastMessageAt: at });
    // The flush's state is the statement's one bound JSON value (the rest is the TD145 carry).
    expect(renderQuery(captured.set!.conversationState).params).toEqual([
      JSON.stringify({ turn_count: 4 }),
    ]);
  });

  it("TD145: carries an existing general_form_completed_at over the state it replaces, in the same UPDATE", async () => {
    const { db, captured } = makeCapturingDb();
    const state = { turn_count: 4, general_road: { handed_over: true } };
    await new ChatRepository(db as never).endSession(db as never, SESSION, state, new Date());

    // A failed general-handover flush leaves the session `active`; the worker can finish the form
    // (the mark lands) before the re-drive closes it here. A plain replace erased the mark and the
    // companion's rule 4 then held the worker in the interview. The merge is in SQL, not a
    // read-then-write, so a mark committed while this UPDATE waited on the row lock is kept too.
    // The existing key goes on the RIGHT of `||`, so the durable mark wins; `jsonb_strip_nulls`
    // keeps the key ABSENT (never JSON null) when there is no mark, or the mark's write-once
    // `IS NULL` guard would refuse every later write.
    const q = renderQuery(captured.set!.conversationState);
    expect(q.sql).toMatch(
      /^\$1::jsonb \|\| jsonb_strip_nulls\(jsonb_build_object\('general_form_completed_at', (?:"chat_sessions"\.)?"conversation_state" -> 'general_form_completed_at'\)\)$/,
    );
    expect(q.params).toEqual([JSON.stringify(state)]);
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

/* ════════════════════════════════════════════════════════════════════════════
 * findLatestSessionByWorker — the "resume my chat" read.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Capture a `select().from().where().orderBy().limit()` chain. */
function makeSelectingDb(rows: unknown[] = [{ id: SESSION }]) {
  const captured: { from?: unknown; where?: unknown; orderBy?: unknown[]; limit?: number } = {};
  const node: Record<string, unknown> = {
    from: (t: unknown) => ((captured.from = t), node),
    where: (c: unknown) => ((captured.where = c), node),
    orderBy: (...o: unknown[]) => ((captured.orderBy = o), node),
    limit: (n: number) => ((captured.limit = n), Promise.resolve(rows)),
  };
  return { db: { select: vi.fn(() => node) }, captured };
}

const renderOrderBy = (h: { captured: { orderBy?: unknown[] } }): string =>
  (h.captured.orderBy ?? []).map((o) => renderWhere(o)).join(", ");

describe("ChatRepository.findLatestSessionByWorker — WHICH session 'latest' means", () => {
  it("orders by last_message_at DESC NULLS LAST *before* started_at", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findLatestSessionByWorker(WORKER);

    // THIS ASSERTION IS THE BUG FIX. Every pre-fix app open called `startSession`, which
    // unconditionally INSERTs, so a worker accrues empty sessions whose `started_at` is
    // the NEWEST and whose `last_message_at` is NULL. Ordering by `started_at` alone
    // therefore resumes an EMPTY session and the Bada Bhai tab redraws a blank thread
    // while the real Q&A sits one session back. Postgres defaults DESC to NULLS FIRST,
    // so dropping `NULLS LAST` reinstates exactly that bug — and every service- and
    // controller-level test in this repo would stay green, because they mock this method.
    const order = renderOrderBy(h);
    expect(order).toMatch(/last_message_at"?\s+DESC\s+NULLS\s+LAST/i);
    expect(order).toContain("started_at");
    expect(order.indexOf("last_message_at")).toBeLessThan(order.indexOf("started_at"));
  });

  it("scopes to the worker and takes exactly one row", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findLatestSessionByWorker(WORKER);

    // The worker id arrives from the bearer token (the controller passes @CurrentWorker,
    // never a param), so this predicate is the only thing standing between one worker
    // and another's transcript id.
    const where = renderWhere(h.captured.where);
    expect(where).toContain('"worker_id"');
    expect(h.captured.limit).toBe(1);
  });

  it("returns undefined for a worker who has never started a session", async () => {
    const h = makeSelectingDb([]);
    const out = await new ChatRepository(h.db as never).findLatestSessionByWorker(WORKER);
    // The service maps this to `{ session_id: null }` — a brand-new worker is not a 404.
    expect(out).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * findActiveSessionByWorker — the #1197 reattach read.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("ChatRepository.findActiveSessionByWorker — WHICH session 'live' means", () => {
  it("filters status='active' IN the WHERE clause, not after ranking", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findActiveSessionByWorker(WORKER);

    // THE ASSERTION THAT JUSTIFIES THE SEPARATE QUERY. Reusing findLatestSessionByWorker
    // with a post-hoc status check would rank an old ENDED session (it has messages, so
    // last_message_at) above a newer empty active one — the check fails and the
    // duplicate-minting the reattach guard exists to stop continues on every later open.
    const where = renderWhere(h.captured.where);
    expect(where).toContain('"worker_id"');
    expect(where).toContain('"status"');
    expect(where.toLowerCase()).toContain(" and ");
  });

  it("orders by coalesce(last_message_at, started_at) DESC — most recently TOUCHED active wins", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findActiveSessionByWorker(WORKER);

    // The pre-guard backlog left workers holding several ACTIVE rows; among them the one
    // the worker actually conversed in must win, exactly the activity-first principle
    // findLatestSessionByWorker documents. An all-empty field falls back to newest
    // started_at via the same coalesce.
    const order = renderOrderBy(h);
    expect(order).toMatch(/coalesce\(.*last_message_at.*started_at.*\)\s+DESC/i);
    expect(h.captured.limit).toBe(1);
  });

  it("scopes to the worker — the id arrives from the bearer token, never a param", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findActiveSessionByWorker(WORKER);
    expect(renderWhere(h.captured.where)).toContain('"worker_id"');
  });

  it("returns undefined when every session is closed", async () => {
    const h = makeSelectingDb([]);
    const out = await new ChatRepository(h.db as never).findActiveSessionByWorker(WORKER);
    expect(out).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * sessionProducedConfirmedProfile — #1744: is this live session a confirmed leftover?
 * ══════════════════════════════════════════════════════════════════════════ */

function makeJoiningDb(rows: unknown[]) {
  const captured: { from?: unknown; join?: unknown; where?: unknown; limit?: number } = {};
  const node: Record<string, unknown> = {
    from: (t: unknown) => ((captured.from = t), node),
    innerJoin: (_t: unknown, on: unknown) => ((captured.join = on), node),
    where: (c: unknown) => ((captured.where = c), node),
    limit: (n: number) => ((captured.limit = n), Promise.resolve(rows)),
  };
  return { db: { select: vi.fn(() => node) }, captured };
}

/**
 * Each `<column> = $n` in a rendered predicate, mapped to the value bound at `$n`. The SQL text
 * alone cannot tell `'confirmed'` from `'draft'`, or the session id from the worker id: drizzle
 * binds all of them as parameters.
 */
function bindings(predicate: unknown): Record<string, unknown> {
  const { sql, params } = new PgDialect().sqlToQuery(predicate as never);
  const out: Record<string, unknown> = {};
  for (const m of sql.matchAll(/("[^"]+"\."[^"]+"(?:->>'[a-z_]+')?)\s*=\s*\$(\d+)/g)) {
    out[m[1]!] = params[Number(m[2]) - 1];
  }
  return out;
}

describe("ChatRepository.sessionProducedConfirmedProfile — the leftover test (#1744)", () => {
  it("binds each value to its own column: this session's job, this worker, confirmed only", async () => {
    const h = makeJoiningDb([]);
    await new ChatRepository(h.db as never).sessionProducedConfirmedProfile(SESSION, WORKER);
    expect(bindings(h.captured.where)).toEqual({
      '"ai_jobs"."job_type"': "profile_extraction",
      '"ai_jobs"."input_ref"->>\'session_id\'': SESSION,
      '"ai_jobs"."input_ref"->>\'worker_id\'': WORKER,
      '"worker_profiles"."worker_id"': WORKER,
      '"worker_profiles"."profile_status"': "confirmed",
    });
  });

  it("walks profile → extraction job → session, confirmed only, one row", async () => {
    const h = makeJoiningDb([{ id: "p" }]);
    expect(
      await new ChatRepository(h.db as never).sessionProducedConfirmedProfile(SESSION, WORKER),
    ).toBe(true);
    expect(renderWhere(h.captured.join)).toMatch(/"ai_job_id"\s*=\s*"ai_jobs"\."id"/);
    const where = renderWhere(h.captured.where);
    expect(where).toContain('"job_type"');
    expect(where).toContain("->>'session_id'");
    expect(where).toContain('"profile_status"');
    expect(h.captured.limit).toBe(1);
  });

  it("scopes BOTH sides to the worker: the job's input_ref and the profile row", async () => {
    const h = makeJoiningDb([]);
    await new ChatRepository(h.db as never).sessionProducedConfirmedProfile(SESSION, WORKER);
    const where = renderWhere(h.captured.where);
    expect(where).toContain("->>'worker_id'");
    expect(where).toContain('"worker_profiles"."worker_id"');
  });

  it("false when no confirmed profile came from it", async () => {
    const h = makeJoiningDb([]);
    expect(
      await new ChatRepository(h.db as never).sessionProducedConfirmedProfile(SESSION, WORKER),
    ).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * ADR-0045 — the general form's two reads/writes on chat_sessions.
 * ══════════════════════════════════════════════════════════════════════════ */

const renderQuery = (fragment: unknown) => new PgDialect().sqlToQuery(fragment as never);

describe("ChatRepository.findLatestGeneralHandoverSession — the form's context", () => {
  it("filters on the worker AND the stamp's handed_over key IN the WHERE clause", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findLatestGeneralHandoverSession(WORKER);

    // THE REASON THIS IS NOT findLatestSessionByWorker. A worker handed the form can chat again
    // before filling it in; "latest session" is then one with no stamp and the form 404s. The
    // predicate must be in the WHERE, not a post-hoc check on the latest row.
    const where = renderWhere(h.captured.where);
    expect(where).toContain('"worker_id"');
    expect(where).toMatch(
      /"conversation_state"\s*->\s*'general_road'\s*->>\s*'handed_over'\s*=\s*'true'/,
    );
    expect(where.toLowerCase()).toContain(" and ");
    expect(h.captured.limit).toBe(1);
  });

  it("orders by started_at DESC alone — the newest handover wins, ended or not", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findLatestGeneralHandoverSession(WORKER);
    const order = renderOrderBy(h);
    expect(order).toMatch(/started_at"?\s+desc/i);
    // NOT ended_at: a newer handover whose flush failed (still active, ended_at NULL) must not
    // lose to an older, ended one.
    expect(order).not.toContain("ended_at");
    // NOT the activity clock: a later chat must not move which handover the form belongs to.
    expect(order).not.toContain("last_message_at");
  });

  it("returns undefined for a worker never handed the form", async () => {
    const h = makeSelectingDb([]);
    expect(
      await new ChatRepository(h.db as never).findLatestGeneralHandoverSession(WORKER),
    ).toBeUndefined();
  });
});

describe("ChatRepository.markGeneralFormCompleted — the chat's 'form done' signal", () => {
  const AT = new Date("2026-09-26T10:00:00.000Z");

  it("MERGES one sibling key into conversation_state — never a replace, never inside the stamp", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).markGeneralFormCompleted(SESSION, WORKER, AT);

    const q = renderQuery(captured.set!.conversationState);
    expect(q.sql).toMatch(
      /^coalesce\((?:"chat_sessions"\.)?"conversation_state", '\{\}'::jsonb\) \|\| jsonb_build_object\('general_form_completed_at', \$1::text\)$/,
    );
    // The timestamp is a bound PARAMETER, not spliced into the statement.
    expect(q.params).toEqual([AT.toISOString()]);
    expect(q.sql).not.toContain("general_road");
  });

  it("does NOT touch last_message_at (session ordering) or status/ended_at", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).markGeneralFormCompleted(SESSION, WORKER, AT);
    // findLatestSessionByWorker ranks by last_message_at; the worker did not speak here.
    expect(Object.keys(captured.set!)).toEqual(["conversationState"]);
  });

  it("is scoped to the session, its owner, a handed-over stamp, and an ABSENT mark (write-once)", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).markGeneralFormCompleted(SESSION, WORKER, AT);
    const where = renderWhere(captured.where);
    expect(where).toContain('"id"');
    expect(where).toContain('"worker_id"');
    expect(where).toMatch(/'general_road'\s*->>\s*'handed_over'\s*=\s*'true'/);
    expect(where).toMatch(/'general_form_completed_at'\s+IS NULL/);
  });

  it("reports whether it wrote — false once the mark exists or the stamp is not a handover", async () => {
    const won = makeCapturingDb();
    expect(
      await new ChatRepository(won.db as never).markGeneralFormCompleted(SESSION, WORKER, AT),
    ).toBe(true);
    const lost = makeCapturingDb();
    lost.setUpdateMatchesNothing();
    expect(
      await new ChatRepository(lost.db as never).markGeneralFormCompleted(SESSION, WORKER, AT),
    ).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * ADR-0051 — the free chat's durable résumé lock
 * ══════════════════════════════════════════════════════════════════════════ */

describe("ChatRepository.listActiveSessionsByWorker — the voice form's reattach candidates", () => {
  it("filters on the worker AND status='active', most recently touched first, capped", async () => {
    const h = makeSelectingDb([{ id: SESSION }]);
    const out = await new ChatRepository(h.db as never).listActiveSessionsByWorker(WORKER, 5);
    expect(out).toEqual([{ id: SESSION }]);
    const { sql, params } = new PgDialect().sqlToQuery(h.captured.where as never);
    expect(sql).toContain('"worker_id" = $1');
    expect(sql).toContain('"status" = $2');
    expect(params).toEqual([WORKER, "active"]);
    expect(renderOrderBy(h)).toMatch(/coalesce\(.*"last_message_at".*"started_at"\) desc/i);
    expect(h.captured.limit).toBe(5);
  });
});

describe("ChatRepository.findFreeChatLockDecider — the session that decides the lock", () => {
  it("filters on the worker AND (ended OR carries the lock key) IN the WHERE clause", async () => {
    const h = makeSelectingDb([{ id: SESSION, status: "abandoned" }]);
    const out = await new ChatRepository(h.db as never).findFreeChatLockDecider(WORKER);
    expect(out).toEqual({ id: SESSION, status: "abandoned" });

    const { sql, params } = new PgDialect().sqlToQuery(h.captured.where as never);
    expect(sql).toContain('"worker_id" = $1');
    // Presence, not parse: a lock a later build shaped differently still counts.
    expect(sql).toMatch(
      /\("chat_sessions"\."status" = \$2 or "chat_sessions"\."conversation_state" -> 'free_chat_lock' IS NOT NULL\)/,
    );
    expect(params).toEqual([WORKER, "ended"]);
    expect(h.captured.limit).toBe(1);
  });

  it("orders by started_at DESC — the newest deciding session wins", async () => {
    const h = makeSelectingDb();
    await new ChatRepository(h.db as never).findFreeChatLockDecider(WORKER);
    const order = renderOrderBy(h);
    expect(order).toMatch(/started_at"?\s+desc/i);
    expect(order).not.toContain("last_message_at");
  });

  it("returns undefined for a worker with no deciding session", async () => {
    const h = makeSelectingDb([]);
    expect(await new ChatRepository(h.db as never).findFreeChatLockDecider(WORKER)).toBeUndefined();
  });
});

describe("ChatRepository.mergeFreeChatLock — the lock, merged beside the state", () => {
  const AT = "2026-10-06T10:00:00.000Z";

  it("MERGES one sibling key — never a replace — and binds the time as a parameter", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).mergeFreeChatLock(SESSION, WORKER, AT);
    const q = renderQuery(captured.set!.conversationState);
    expect(q.sql).toMatch(
      /^coalesce\((?:"chat_sessions"\.)?"conversation_state", '\{\}'::jsonb\) \|\| jsonb_build_object\('free_chat_lock', jsonb_build_object\('v', 1, 'locked_at', \$1::text\)\)$/,
    );
    expect(q.params).toEqual([AT]);
  });

  it("does NOT touch last_message_at, status or ended_at", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).mergeFreeChatLock(SESSION, WORKER, AT);
    expect(Object.keys(captured.set!)).toEqual(["conversationState"]);
  });

  it("is scoped to the session, its owner, an ACTIVE row, and an ABSENT key (write-once)", async () => {
    const { db, captured } = makeCapturingDb();
    await new ChatRepository(db as never).mergeFreeChatLock(SESSION, WORKER, AT);
    const where = renderWhere(captured.where);
    expect(where).toContain('"id"');
    expect(where).toContain('"worker_id"');
    expect(where).toContain('"status"');
    expect(where).toMatch(/'free_chat_lock'\s+IS NULL/);
  });

  it("reports whether it wrote", async () => {
    const lost = makeCapturingDb();
    lost.setUpdateMatchesNothing();
    expect(await new ChatRepository(lost.db as never).mergeFreeChatLock(SESSION, WORKER, AT)).toBe(
      false,
    );
    const won = makeCapturingDb();
    expect(await new ChatRepository(won.db as never).mergeFreeChatLock(SESSION, WORKER, AT)).toBe(
      true,
    );
  });
});
