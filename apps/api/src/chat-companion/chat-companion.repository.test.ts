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
