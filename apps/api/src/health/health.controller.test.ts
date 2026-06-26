import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Response } from "express";
import type { Database } from "@badabhai/db";
import type { Queue } from "bullmq";
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
 */
function setup(opts: {
  dbExecute?: () => Promise<unknown>;
  redisPing?: () => Promise<unknown>;
}) {
  const dbExecute = opts.dbExecute ?? (async () => [{ "?column?": 1 }]);
  const redisPing = opts.redisPing ?? (async () => "PONG");

  const db = { execute: vi.fn(dbExecute) } as unknown as Database;
  // queue.client is a Promise<ioredis> in BullMQ; ping() lives on the resolved client.
  const pingFn = vi.fn(redisPing);
  const queue = { client: Promise.resolve({ ping: pingFn }) } as unknown as Queue;

  const service = new HealthService(db, queue);
  const controller = new HealthController(CONFIG, service);
  return { controller, db, pingFn };
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
    expect(body.checks).toEqual({ database: "up", redis: "up" });
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
    expect(body.checks).toEqual({ database: "down", redis: "up" });
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
    expect(body.checks).toEqual({ database: "up", redis: "down" });
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
    expect(body.checks).toEqual({ database: "down", redis: "down" });
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
