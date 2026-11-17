import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerActivityRepository } from "./worker-activity.repository";
import { WorkerActivityService } from "./worker-activity.service";

/**
 * #2753 — the switch, and the write's "never fails anything" rule. Off is today: no write, no read,
 * and `lastActiveDays` answers null so every caller keeps its own shape.
 */
const W1 = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-16T06:00:00.000Z");

/** Drain the fire-and-forget write (deliberately not awaited by the service). */
const flush = () => new Promise((r) => setImmediate(r));

function setup(on: boolean, days?: number) {
  const repo = {
    touch: vi.fn(async () => undefined),
    lastActiveDays: vi.fn(async () => new Map([[W1, "2026-08-17"]])),
  };
  const config = { WORKER_ACTIVITY_ENABLED: on, NOT_RECENTLY_ACTIVE_DAYS: days ?? 90 };
  const svc = new WorkerActivityService(repo as unknown as WorkerActivityRepository, config);
  return { svc, repo, config };
}

afterEach(() => vi.restoreAllMocks());

describe("WorkerActivityService — switch off is today", () => {
  it("writes nothing and reads nothing", async () => {
    const { svc, repo } = setup(false);
    expect(svc.enabled).toBe(false);
    svc.touch(W1, "2026-11-16");
    svc.recordNow(W1, NOW);
    await expect(svc.lastActiveDays([W1], NOW)).resolves.toBeNull();
    await flush();
    expect(repo.touch).not.toHaveBeenCalled();
    expect(repo.lastActiveDays).not.toHaveBeenCalled();
  });
});

describe("WorkerActivityService — switch on", () => {
  it("recordNow writes today's IST day (after 18:30 UTC it is tomorrow in India)", async () => {
    const { svc, repo } = setup(true);
    svc.recordNow(W1, new Date("2026-11-16T18:45:00.000Z"));
    await flush();
    expect(repo.touch).toHaveBeenCalledWith(W1, "2026-11-17");
  });

  it("a failed write never throws, never rejects, and logs the worker id and SQLSTATE only", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup(true);
    repo.touch.mockRejectedValue(
      Object.assign(new Error('terminating connection due to administrator command for "x"'), {
        cause: { code: "57P01" },
      }),
    );
    expect(() => svc.touch(W1, "2026-11-16")).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`worker=${W1}`);
    expect(line).toContain("sqlstate=57P01");
    expect(line).not.toContain("administrator command");
  });

  // The only 42P01 in this file: the warning is once per PROCESS (module state), and vitest gives
  // each file its own module registry, so this test sees the first and only one.
  it("switched on before 0168 (42P01): writes are dropped with ONE warning per process, no worker id", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo } = setup(true);
    repo.touch.mockRejectedValue(
      Object.assign(new Error('relation "worker_activity" does not exist'), {
        cause: { code: "42P01" },
      }),
    );
    for (const day of ["2026-11-14", "2026-11-15", "2026-11-16"]) {
      expect(() => svc.touch(W1, day)).not.toThrow();
    }
    await flush();
    expect(repo.touch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("0168_worker_activity");
    expect(line).toContain("sqlstate=42P01");
    expect(line).not.toContain(W1);
  });

  it("reads the page's days through the repository, once", async () => {
    const { svc, repo } = setup(true);
    const days = await svc.lastActiveDays([W1], NOW);
    expect(days?.get(W1)).toBe("2026-08-17");
    expect(repo.lastActiveDays).toHaveBeenCalledTimes(1);
  });

  it("the mark reads NOT_RECENTLY_ACTIVE_DAYS and today's IST day", () => {
    const days = new Map([[W1, "2026-08-17"]]);
    // 2026-08-17 → 2026-11-16 is 91 days.
    expect(setup(true).svc.notRecentlyActive(days, W1, NOW)).toBe(true);
    expect(setup(true, 91).svc.notRecentlyActive(days, W1, NOW)).toBe(false);
    // Looked up by the lower-case id, whatever case the caller holds.
    expect(setup(true).svc.notRecentlyActive(days, W1.toUpperCase(), NOW)).toBe(true);
    // No day for him: not marked.
    expect(setup(true).svc.notRecentlyActive(new Map(), W1, NOW)).toBe(false);
  });

  it("falls back to the owner's 90 when the config does not carry a usable threshold", () => {
    const repo = { touch: vi.fn(), lastActiveDays: vi.fn() };
    const svc = new WorkerActivityService(
      repo as unknown as WorkerActivityRepository,
      {
        WORKER_ACTIVITY_ENABLED: true,
      } as never,
    );
    expect(svc.thresholdDays).toBe(90);
  });
});
