import { Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@badabhai/db";
import { WorkerActivityRepository } from "./worker-activity.repository";
import { WorkerActivityService } from "./worker-activity.service";

/**
 * #2753 — the repository's merge, with the database faked. The SQL itself is proven against a real
 * Postgres in `worker-activity.db.test.ts`; this file pins what is done with the rows it returns.
 */
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-16T06:00:00.000Z");

function fakeDb(rows: Array<Record<string, unknown>>) {
  const execute = vi.fn(async () => rows);
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { execute, insert } as unknown as Database,
    execute,
    insert,
    values,
    onConflictDoNothing,
  };
}

describe("WorkerActivityRepository.lastActiveDays — the merge", () => {
  it("one statement for the whole page, keyed by the lower-case id", async () => {
    const f = fakeDb([
      // He used the app after his last sign-in: the table's day wins.
      { worker_id: W1, active_on: "2026-11-14", last_seen_at: new Date("2026-08-01T10:00:00Z") },
      // History from before the table: the device's IST day wins (19:00 UTC is the next day).
      { worker_id: W2, active_on: "2026-09-01", last_seen_at: "2026-11-12T19:00:00.000Z" },
      // Neither: absent from the map.
      { worker_id: W3, active_on: null, last_seen_at: null },
    ]);
    const repo = new WorkerActivityRepository(f.db);
    const days = await repo.lastActiveDays([W1.toUpperCase(), W2, W3, W1], NOW);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect([...days.entries()]).toEqual([
      [W1, "2026-11-14"],
      [W2, "2026-11-13"],
    ]);
    expect(days.has(W3)).toBe(false);
  });

  it("an empty page reads nothing", async () => {
    const f = fakeDb([]);
    const days = await new WorkerActivityRepository(f.db).lastActiveDays([], NOW);
    expect(days.size).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe("WorkerActivityRepository.touch — one row per worker per day", () => {
  it("inserts (worker, day) and does nothing on a conflict", async () => {
    const f = fakeDb([]);
    await new WorkerActivityRepository(f.db).touch(W1, "2026-11-16");
    expect(f.values).toHaveBeenCalledWith({ workerId: W1, activeOn: "2026-11-16" });
    expect(f.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

/**
 * #2753 — WORKER_ACTIVITY_ENABLED switched on before migration 0168. The read must not 500 the
 * company lists, the inbox, search or the agency list: on 42P01 (and only 42P01) it answers the
 * device-only day, with one warning per process.
 */
describe("WorkerActivityRepository.lastActiveDays — without the table (42P01)", () => {
  const dialect = new PgDialect();
  const textOf = (query: SQL) => dialect.sqlToQuery(query).sql;
  const undefinedTable = () =>
    Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error('relation "worker_activity" does not exist'), {
        code: "42P01",
      }),
    });

  function failingDb(first: unknown, fallbackRows: Array<Record<string, unknown>> = []) {
    const execute = vi.fn<(query: SQL) => Promise<unknown>>();
    execute.mockRejectedValueOnce(first).mockResolvedValue(fallbackRows);
    return { db: { execute } as unknown as Database, execute };
  }

  // The first 42P01 in this file: the warning is once per PROCESS (module state), and vitest gives
  // each file its own module registry, so this test sees the first and only line.
  it("falls back to the device day, retries once without the table, and warns ONCE per process", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const f = failingDb(undefinedTable(), [
      // The fallback has no table term: active_on is NULL, the device's IST day is the answer.
      { worker_id: W1, active_on: null, last_seen_at: "2026-11-12T19:00:00.000Z" },
      { worker_id: W2, active_on: null, last_seen_at: null },
    ]);
    const days = await new WorkerActivityRepository(f.db).lastActiveDays([W1, W2], NOW);
    expect([...days.entries()]).toEqual([[W1, "2026-11-13"]]);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(textOf(f.execute.mock.calls[0]![0])).toContain("worker_activity");
    // The retry is the device term alone: it never names the missing table.
    expect(textOf(f.execute.mock.calls[1]![0])).not.toContain("worker_activity");
    expect(textOf(f.execute.mock.calls[1]![0])).toContain("worker_devices");

    // Another page, another repository instance: still one line for the whole process.
    const g = failingDb(undefinedTable(), []);
    await new WorkerActivityRepository(g.db).lastActiveDays([W1], NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("0168_worker_activity");
    expect(line).toContain("sqlstate=42P01");
    expect(line).not.toContain(W1);
    expect(line).not.toContain("SELECT");
    warn.mockRestore();
  });

  it("the mark is computed from the fallback day", async () => {
    // Last device sighting 2026-08-17 (IST) → 91 days before 2026-11-16: marked.
    const f = failingDb(undefinedTable(), [
      { worker_id: W1, active_on: null, last_seen_at: "2026-08-17T06:00:00.000Z" },
    ]);
    const svc = new WorkerActivityService(new WorkerActivityRepository(f.db), {
      WORKER_ACTIVITY_ENABLED: true,
      NOT_RECENTLY_ACTIVE_DAYS: 90,
    });
    const days = await svc.lastActiveDays([W1], NOW);
    expect(days?.get(W1)).toBe("2026-08-17");
    expect(svc.notRecentlyActive(days!, W1, NOW)).toBe(true);
  });

  it.each([
    ["a dropped connection", "57P01"],
    ["a missing column", "42703"],
    ["a permission error", "42501"],
  ])("%s (%s) still throws, with no retry", async (_name, code) => {
    const f = failingDb(Object.assign(new Error("Failed query"), { cause: { code } }));
    await expect(
      new WorkerActivityRepository(f.db).lastActiveDays([W1], NOW),
    ).rejects.toMatchObject({ cause: { code } });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("a 42P01 from the fallback itself (worker_devices missing) is not swallowed", async () => {
    const execute = vi.fn<(query: SQL) => Promise<unknown>>();
    execute.mockRejectedValue(undefinedTable());
    await expect(
      new WorkerActivityRepository({ execute } as unknown as Database).lastActiveDays([W1], NOW),
    ).rejects.toMatchObject({ cause: { code: "42P01" } });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
