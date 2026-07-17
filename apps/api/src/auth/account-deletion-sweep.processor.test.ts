import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AccountDeletionSweepProcessor } from "./account-deletion-sweep.processor";
import type { WorkersRepository } from "../workers/workers.repository";
import type { AccountDeletionService } from "./account-deletion.service";

const DUE_YESTERDAY = "aaaaaaaa-1111-4111-8111-111111111111";
const DUE_TOMORROW = "bbbbbbbb-2222-4222-8222-222222222222";
const DUE_LAST_WEEK = "cccccccc-3333-4333-8333-333333333333";

const DAY_MS = 86_400_000;

/**
 * In-memory double of the pending-deletion rows (id → deletion_scheduled_at). The repo
 * mocks implement findDueDeletions/claimDueDeletion faithfully against it, and execute()
 * removes the row (the hard-delete cascade) — so the tests exercise the sweep's real
 * contract: overdue-only, claim-guarded, idempotent across runs.
 */
function setup(
  rows: Array<[id: string, dueAt: Date]> = [],
  opts: { sweepIntervalHours?: number } = {},
) {
  const store = new Map<string, Date>(rows);

  const workers = {
    findDueDeletions: vi.fn(async (now: Date, limit: number) =>
      [...store.entries()]
        .filter(([, at]) => at.getTime() <= now.getTime())
        .sort((a, b) => a[1].getTime() - b[1].getTime())
        .slice(0, limit)
        .map(([id]) => id),
    ),
    claimDueDeletion: vi.fn(async (id: string, now: Date) => {
      const at = store.get(id);
      return at !== undefined && at.getTime() <= now.getTime();
    }),
  };
  const accountDeletion = {
    // The erasure removes the workers row entirely (cascade) — the marker is gone.
    execute: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const config = {
    ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: opts.sweepIntervalHours ?? 1,
  } as ServerConfig;

  const proc = new AccountDeletionSweepProcessor(
    workers as unknown as WorkersRepository,
    accountDeletion as unknown as AccountDeletionService,
    queue as unknown as Queue,
    config,
  );
  return { proc, store, workers, accountDeletion, queue };
}

describe("AccountDeletionSweepProcessor (ADR-0031 grace-elapse sweep)", () => {
  it("erases ONLY overdue rows: due yesterday → execute; due tomorrow → untouched", async () => {
    const now = Date.now();
    const h = setup([
      [DUE_YESTERDAY, new Date(now - DAY_MS)],
      [DUE_TOMORROW, new Date(now + DAY_MS)],
    ]);

    const result = await h.proc.process();

    expect(h.accountDeletion.execute).toHaveBeenCalledTimes(1);
    expect(h.accountDeletion.execute).toHaveBeenCalledWith(DUE_YESTERDAY);
    expect(h.accountDeletion.execute).not.toHaveBeenCalledWith(DUE_TOMORROW);
    expect(result).toEqual({ due: 1, erased: 1 });
    // The not-yet-due row keeps its marker for a later tick.
    expect(h.store.has(DUE_TOMORROW)).toBe(true);
  });

  it("a row cancelled between the SELECT and the claim is NEVER executed (cancel-vs-sweep race)", async () => {
    const h = setup([[DUE_YESTERDAY, new Date(Date.now() - DAY_MS)]]);
    // Simulate the worker's cancel landing after findDueDeletions returned the id: the
    // atomic re-check (conditional UPDATE) then matches nothing.
    h.workers.claimDueDeletion.mockResolvedValueOnce(false);

    const result = await h.proc.process();

    expect(h.workers.claimDueDeletion).toHaveBeenCalledWith(DUE_YESTERDAY, expect.any(Date));
    expect(h.accountDeletion.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ due: 1, erased: 0 });
  });

  it("a mid-loop execute() failure logs and CONTINUES — later workers still erased", async () => {
    const now = Date.now();
    // Ordered oldest-due first: LAST_WEEK sorts before YESTERDAY, and its erase blows up.
    const h = setup([
      [DUE_LAST_WEEK, new Date(now - 7 * DAY_MS)],
      [DUE_YESTERDAY, new Date(now - DAY_MS)],
    ]);
    h.accountDeletion.execute.mockRejectedValueOnce(new Error("storage down"));

    const result = await h.proc.process();

    // Both were attempted; the failure never aborted the loop or the run.
    expect(h.accountDeletion.execute).toHaveBeenCalledTimes(2);
    expect(h.accountDeletion.execute).toHaveBeenNthCalledWith(1, DUE_LAST_WEEK);
    expect(h.accountDeletion.execute).toHaveBeenNthCalledWith(2, DUE_YESTERDAY);
    expect(result).toEqual({ due: 2, erased: 1 });
    // The failed worker keeps its marker (the DB is authoritative) → the next tick retries.
    expect(h.store.has(DUE_LAST_WEEK)).toBe(true);
  });

  it("is idempotent across two runs: an erased worker is never re-executed", async () => {
    const h = setup([[DUE_YESTERDAY, new Date(Date.now() - DAY_MS)]]);

    const first = await h.proc.process();
    const second = await h.proc.process();

    expect(first).toEqual({ due: 1, erased: 1 });
    // Run 2 finds nothing due (the row is gone) — a duplicated Redis tick is harmless.
    expect(second).toEqual({ due: 0, erased: 0 });
    expect(h.accountDeletion.execute).toHaveBeenCalledTimes(1);
  });

  it("passes the SAME `now` to the select and every claim (a row can't become due mid-run)", async () => {
    const h = setup([[DUE_YESTERDAY, new Date(Date.now() - DAY_MS)]]);
    await h.proc.process();
    const selectNow = h.workers.findDueDeletions.mock.calls[0]![0] as Date;
    const claimNow = h.workers.claimDueDeletion.mock.calls[0]![1] as Date;
    expect(claimNow).toBe(selectNow);
    // And the batch is bounded.
    expect(h.workers.findDueDeletions).toHaveBeenCalledWith(selectNow, 100);
  });

  it("onApplicationBootstrap registers the repeatable sweep via upsertJobScheduler (idempotent id)", async () => {
    const h = setup([], { sweepIntervalHours: 1 });
    await h.proc.onApplicationBootstrap();
    expect(h.queue.upsertJobScheduler).toHaveBeenCalledWith("account-deletion-sweep", {
      every: 3_600_000,
    });
  });

  it("honors a fractional ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS (tests/staging cadence)", async () => {
    const h = setup([], { sweepIntervalHours: 0.5 });
    await h.proc.onApplicationBootstrap();
    expect(h.queue.upsertJobScheduler).toHaveBeenCalledWith("account-deletion-sweep", {
      every: 1_800_000,
    });
  });

  it("a scheduler-registration failure is logged, never thrown (boot must not die on Redis)", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
      await expect(h.proc.onApplicationBootstrap()).resolves.toBeUndefined();
      // Boot is NOT blocked by the retry ladder (onApplicationBootstrap gates app.listen —
      // the API, and /health with it, must come up even while Redis is down).
      expect(h.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
      h.proc.onModuleDestroy();
      await h.proc.whenRegistrationSettled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a TRANSIENT registration failure SELF-HEALS: the backoff retries and attempt 2 registers", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      // Boot lands while Redis is still coming up; the next attempt succeeds.
      h.queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
      await h.proc.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(1_000); // first backoff step
      await h.proc.whenRegistrationSettled();

      expect(h.queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
      // The retry registers the SAME scheduler id + cadence — never a second/duplicate one.
      expect(h.queue.upsertJobScheduler).toHaveBeenLastCalledWith("account-deletion-sweep", {
        every: 3_600_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PERMANENTLY-failing registration is bounded (5 attempts) and goes LOUD — never silently swallowed", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const h = setup();
      // The non-outage class the ADR's "the next sweep catches it" does NOT cover: a bad
      // Redis ACL / bullmq API mismatch fails identically on every attempt AND every boot.
      h.queue.upsertJobScheduler.mockRejectedValue(new Error("NOPERM this user has no permissions"));
      await h.proc.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(81_000); // 1s + 5s + 15s + 60s ladder
      await h.proc.whenRegistrationSettled();

      // Bounded: 1 boot attempt + 4 retries, then it STOPS (no infinite hammering).
      expect(h.queue.upsertJobScheduler).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.queue.upsertJobScheduler).toHaveBeenCalledTimes(5);

      // LOUD: a terminal error naming the consequence + where it is detectable.
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/registration FAILED after 5 attempts/);
      expect(logged).toMatch(/deletion_sweep=down/);
      // ...and no PII/secret rides along in the terminal log.
      expect(logged).not.toMatch(/\+91|phone|full_?name/i);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a dead sweep NEVER touches the DB marker — the overdue rows survive for a later tick", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const h = setup([[DUE_YESTERDAY, new Date(Date.now() - DAY_MS)]]);
      h.queue.upsertJobScheduler.mockRejectedValue(new Error("redis down"));
      await h.proc.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(81_000);
      await h.proc.whenRegistrationSettled();

      // Registration is dead, so nothing ticked — but the marker (authoritative) is intact
      // and no erasure ran: erasure is DELAYED + detectable, never lost or half-applied.
      expect(h.accountDeletion.execute).not.toHaveBeenCalled();
      expect(h.store.has(DUE_YESTERDAY)).toBe(true);
      // A later tick (re-registered, or another replica) still erases it.
      expect(await h.proc.process()).toEqual({ due: 1, erased: 1 });
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shutdown aborts a pending backoff (no retry against a closing queue)", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.queue.upsertJobScheduler.mockRejectedValue(new Error("redis down"));
      await h.proc.onApplicationBootstrap();

      h.proc.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(81_000);
      await h.proc.whenRegistrationSettled();

      // Only the boot attempt ever ran — the ladder stopped at destroy.
      expect(h.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
