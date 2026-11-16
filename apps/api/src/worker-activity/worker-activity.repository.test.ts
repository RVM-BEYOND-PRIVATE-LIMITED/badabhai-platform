import { describe, expect, it, vi } from "vitest";
import type { Database } from "@badabhai/db";
import { WorkerActivityRepository } from "./worker-activity.repository";

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
