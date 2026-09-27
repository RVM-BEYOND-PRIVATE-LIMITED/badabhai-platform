import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { ChatCompanionRepository } from "./chat-companion.repository";

/**
 * Statement facts for the companion's two reads — what the repository BUILDS, not what Postgres
 * does with it (the jobs.repository.test.ts pattern).
 */
const dialect = new PgDialect();
const compile = (node: unknown) => {
  const c = dialect.sqlToQuery(sql`${node}` as SQL);
  return { sql: c.sql.replace(/\s+/g, " "), params: c.params };
};
const WORKER = "11111111-1111-4111-8111-111111111111";

interface Captured {
  selection?: Record<string, unknown>;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

function makeDb(rows: unknown[]) {
  const q: Captured = {};
  const node: Record<string, unknown> = {
    from: () => node,
    where: (c: unknown) => {
      q.where = c;
      return node;
    },
    orderBy: (...o: unknown[]) => {
      q.orderBy = o;
      return node;
    },
    limit: (n: number) => {
      q.limit = n;
      return Promise.resolve(rows);
    },
    then: (resolve: (v: unknown) => unknown) => resolve(rows),
  };
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      q.selection = selection;
      return node;
    }),
  };
  return { repo: new ChatCompanionRepository(db as never), q };
}

describe("latestActiveSession", () => {
  it("reads only the worker's LIVE sessions, in the order POST /chat/session reattaches, one row", async () => {
    const row = {
      startedAt: new Date("2026-09-20T10:00:00.000Z"),
      lastMessageAt: new Date("2026-09-20T10:20:00.000Z"),
    };
    const { repo, q } = makeDb([row]);
    expect(await repo.latestActiveSession(WORKER)).toBe(row);
    expect(Object.keys(q.selection ?? {}).sort()).toEqual(["lastMessageAt", "startedAt"]);
    const { sql: text, params } = compile(q.where);
    // A CONJUNCTION — `or` would read another worker's live session into the mode decision.
    expect(text).toMatch(/"worker_id" = \$\d+ and "chat_sessions"\."status" = \$\d+/);
    expect(params).toEqual([WORKER, "active"]);
    // The same row ChatRepository.findActiveSessionByWorker hands a redo.
    expect(compile(q.orderBy![0]).sql).toMatch(
      /coalesce\("chat_sessions"\."last_message_at", "chat_sessions"\."started_at"\) DESC/,
    );
    expect(q.limit).toBe(1);
  });

  it("no live session → null", async () => {
    expect(await makeDb([]).repo.latestActiveSession(WORKER)).toBeNull();
  });
});

describe("latestFormHandoverClosedAfter (#1775)", () => {
  const AFTER = new Date("2026-09-20T10:00:00.000Z");

  it("this worker's CLOSED sessions that ended after the confirmation and handed over, newest first, one row", async () => {
    const row = { formKind: "cnc_turner", generalFormCompletedAt: null };
    const { repo, q } = makeDb([row]);
    expect(await repo.latestFormHandoverClosedAfter(WORKER, AFTER)).toBe(row);
    const { sql: text, params } = compile(q.where);
    // A CONJUNCTION of the scope, with the handover markers OR-ed inside it — an `or` at the top
    // would read another worker's sessions into the mode decision.
    expect(text).toMatch(
      /^\("chat_sessions"\."worker_id" = \$1 and "chat_sessions"\."status" <> \$2 and "chat_sessions"\."ended_at" > \$3 and \(/,
    );
    expect(params.slice(0, 3)).toEqual([WORKER, "active", AFTER.toISOString()]);
    // Every marker a handover flush writes.
    expect(text).toContain(`"chat_sessions"."conversation_state" ->> 'form_kind' is not null`);
    expect(text).toContain(
      `"chat_sessions"."conversation_state" -> 'general_road' ->> 'handed_over' = 'true'`,
    );
    expect(text).toMatch(/->> 'completion_reason' in \(\$4, \$5\)/);
    expect(params.slice(3)).toEqual(["form_handoff", "general_form_handoff"]);
    expect(compile(q.orderBy![0]).sql).toMatch(/"chat_sessions"\."ended_at" desc/i);
    expect(q.limit).toBe(1);
  });

  it("selects two scalars, never the whole conversation_state (it holds the worker's answers)", async () => {
    const { repo, q } = makeDb([]);
    await repo.latestFormHandoverClosedAfter(WORKER, AFTER);
    expect(Object.keys(q.selection ?? {}).sort()).toEqual(["formKind", "generalFormCompletedAt"]);
    const projected = Object.values(q.selection ?? {}).map((node) => compile(node).sql);
    expect(projected).toEqual([
      `"chat_sessions"."conversation_state" ->> 'form_kind'`,
      `"chat_sessions"."conversation_state" ->> 'general_form_completed_at'`,
    ]);
  });

  it("no such session → null", async () => {
    expect(await makeDb([]).repo.latestFormHandoverClosedAfter(WORKER, AFTER)).toBeNull();
  });
});

describe("countApplied", () => {
  it("counts only this worker's `applied` decisions — never skips", async () => {
    const { repo, q } = makeDb([{ n: 3 }]);
    expect(await repo.countApplied(WORKER)).toBe(3);
    const { sql: text, params } = compile(q.where);
    // A CONJUNCTION — `or` would count every worker's applications.
    expect(text).toMatch(/"worker_id" = \$\d+ and "applications"\."action" = \$\d+/);
    expect(params).toEqual([WORKER, "applied"]);
  });

  it("a driver that returns the count as text still yields a number", async () => {
    expect(await makeDb([{ n: "7" }]).repo.countApplied(WORKER)).toBe(7);
  });
});

describe("the companion cannot write", () => {
  it("its repository contains no insert, update or delete", () => {
    const source = readFileSync(join(__dirname, "chat-companion.repository.ts"), "utf8");
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
  });
});
