import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Response } from "express";
import type { Database } from "@badabhai/db";
import type { Queue } from "bullmq";
import { ACCOUNT_DELETION_SWEEP_SCHEDULER_ID } from "../queue/queue.constants";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

const CONFIG = { NODE_ENV: "test" } as never;

/** A Response stub that records the status code the controller sets. */
function fakeRes() {
  const res = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number };
}

/**
 * Build a HealthService over mocked DB + queue clients.
 *   - `db`: pass a function for `execute` (resolve = up, reject/hang = down).
 *   - `redisPing`: the `client.ping` implementation.
 *   - `getJobScheduler`: the ADR-0031 sweep-scheduler lookup (a record = registered,
 *     `undefined` = the sweep's clock does not exist, reject/hang = probe failed).
 */
function setup(opts: {
  dbExecute?: () => Promise<unknown>;
  redisPing?: () => Promise<unknown>;
  getJobScheduler?: () => Promise<unknown>;
}) {
  const dbExecute = opts.dbExecute ?? (async () => [{ "?column?": 1 }]);
  const redisPing = opts.redisPing ?? (async () => "PONG");
  const getJobSchedulerImpl =
    opts.getJobScheduler ?? (async () => ({ key: "account-deletion-sweep", every: "3600000" }));

  const db = { execute: vi.fn(dbExecute) } as unknown as Database;
  // queue.client is a Promise<ioredis> in BullMQ; ping() lives on the resolved client.
  const pingFn = vi.fn(redisPing);
  const queue = { client: Promise.resolve({ ping: pingFn }) } as unknown as Queue;
  const getJobScheduler = vi.fn(getJobSchedulerImpl);
  const deletionQueue = { getJobScheduler } as unknown as Queue;

  const service = new HealthService(db, queue, deletionQueue);
  const controller = new HealthController(CONFIG, service);
  return { controller, db, pingFn, getJobScheduler };
}

/** A promise that never resolves — exercises the timeout path. */
const NEVER = () => new Promise<never>(() => {});

describe("HealthController.check — readiness probes", () => {
  it("both up → 200 + status ok + checks up/up", async () => {
    const { controller } = setup({});
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(body.environment).toBe("test");
    expect(body.checks).toEqual({ database: "up", redis: "up", deletion_sweep: "up" });
  });

  it("DB down (probe rejects) → 503 + status error + database down, redis up", async () => {
    const { controller } = setup({
      dbExecute: async () => {
        throw new Error("connection refused 127.0.0.1:5432 password=hunter2");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toMatchObject({ database: "down", redis: "up" });
  });

  it("Redis down (client.ping rejects) → 503 + redis down, database up", async () => {
    const { controller } = setup({
      redisPing: async () => {
        throw new Error("ECONNREFUSED redis://localhost:6379");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toMatchObject({ database: "up", redis: "down" });
  });

  it("a hung probe is treated as down (timeout), not a hang → 503", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ dbExecute: NEVER });
      const res = fakeRes();
      const promise = controller.check(res);
      // Fast-forward past the 2s probe timeout so the race resolves to down.
      await vi.advanceTimersByTimeAsync(2001);
      const body = await promise;

      expect(res.statusCode).toBe(503);
      expect(body.status).toBe("error");
      expect(body.checks.database).toBe("down");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never leaks a connection string or error detail into the body", async () => {
    const { controller } = setup({
      dbExecute: async () => {
        throw new Error("postgres://user:secret@db.internal:5432/app failed");
      },
      redisPing: async () => {
        throw new Error("redis://:topsecret@cache.internal:6379");
      },
      getJobScheduler: async () => {
        throw new Error("redis://:topsecret@cache.internal:6379 scheduler read failed");
      },
    });
    const res = fakeRes();
    const body = await controller.check(res);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/postgres:\/\//);
    expect(serialized).not.toMatch(/redis:\/\//);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/5432|6379/);
    // The body carries only the structured up/down checks — no error/host/stack.
    expect(Object.keys(body)).toEqual([
      "status",
      "service",
      "environment",
      "timestamp",
      "checks",
    ]);
    expect(body.checks).toEqual({ database: "down", redis: "down", deletion_sweep: "down" });
  });

  // ---- ADR-0031: the deletion-sweep scheduler signal ----

  it("a MISSING sweep scheduler → checks.deletion_sweep down (a dead sweep is DETECTABLE)", async () => {
    // The Blocker-2 failure mode: registration failed (or the scheduler was removed
    // out-of-band), so nothing ticks and overdue erasures accumulate — silently, until here.
    const { controller } = setup({ getJobScheduler: async () => undefined });
    const body = await controller.check(fakeRes());

    expect(body.checks.deletion_sweep).toBe("down");
  });

  it("a dead sweep does NOT 503 the API: dependencies up → still 200/ok, sweep reported down", async () => {
    const { controller } = setup({ getJobScheduler: async () => undefined });
    const res = fakeRes();
    const body = await controller.check(res);

    // Readiness = "can this process serve requests?". A dead background clock delays
    // erasure; it breaks no request path. 503-ing here would fail the CD /health gate and
    // the staging smoke — turning a delayed erasure into a self-inflicted outage.
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ database: "up", redis: "up", deletion_sweep: "down" });
  });

  it("probes the SHARED scheduler id — the /health reader can't drift from the processor's writer", async () => {
    const { controller, getJobScheduler } = setup({});
    await controller.check(fakeRes());
    expect(getJobScheduler).toHaveBeenCalledWith(ACCOUNT_DELETION_SWEEP_SCHEDULER_ID);
  });

  it("a hung sweep probe is down, not a hang (the timeout covers it too)", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ getJobScheduler: NEVER });
      const res = fakeRes();
      const promise = controller.check(res);
      await vi.advanceTimersByTimeAsync(2001);
      const body = await promise;

      expect(body.checks.deletion_sweep).toBe("down");
      expect(res.statusCode).toBe(200); // still not an outage
    } finally {
      vi.useRealTimers();
    }
  });

  it("the sweep signal is PII-free: no worker id/phone/name in the body or the log", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({ getJobScheduler: async () => undefined });
      const body = await controller.check(fakeRes());

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/phone|full_?name|worker_id|\+91/i);
      // The probe reports the EXISTENCE of a scheduler — it never reads a worker row, so
      // there is nothing PII-shaped to leak by construction.
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/deletion_sweep=down/);
      expect(logged).toMatch(/SchedulerMissingError/); // the safe name tag
      expect(logged).not.toMatch(/phone|full_?name|\+91/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs only a secret-safe failure tag (the code/name), never the raw error message", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { controller } = setup({
        dbExecute: async () => {
          const e = new Error("postgres://user:secret@db.internal:5432/app failed") as Error & {
            code?: string;
          };
          e.code = "ECONNREFUSED";
          throw e;
        },
      });
      await controller.check(fakeRes());

      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/database=down/);
      expect(logged).toMatch(/ECONNREFUSED/); // the safe code IS logged
      expect(logged).not.toMatch(/postgres:\/\//); // the message is NOT
      expect(logged).not.toMatch(/secret/i);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
