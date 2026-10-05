import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import { PendingIntentStore } from "./pending-intent.store";

// ---------------------------------------------------------------------------
// PendingIntentStore (TD146, WP6) — the one-shot intent a task-chip tap leaves.
//
// The invariants pinned here:
//   - one key per worker, value from the CLOSED set, 10-minute TTL;
//   - `take` is ONE-SHOT (GETDEL): a second take finds nothing;
//   - every failure is SOFT — a Redis outage is "no pending intent", never a thrown error;
//   - the value is validated on the way out too (an older build's value is dropped).
// ---------------------------------------------------------------------------

const WORKER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const KEY = `companion:v2:pending-intent:${WORKER_ID}`;
const TTL = 600;

function makeRedis(opts: { setThrows?: boolean; getdelThrows?: boolean; delThrows?: boolean } = {}) {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const set = vi.fn(async (key: string, value: string, _mode: "EX", seconds: number) => {
    if (opts.setThrows) throw new Error("redis SET refused");
    values.set(key, value);
    ttls.set(key, seconds);
    return "OK";
  });
  const getdel = vi.fn(async (key: string) => {
    if (opts.getdelThrows) throw new Error("redis GETDEL refused");
    const value = values.get(key) ?? null;
    values.delete(key);
    return value;
  });
  const del = vi.fn(async (key: string) => {
    if (opts.delThrows) throw new Error("redis DEL refused");
    return values.delete(key) ? 1 : 0;
  });
  return { set, getdel, del, values, ttls };
}

function setup(
  opts: {
    redis?: { setThrows?: boolean; getdelThrows?: boolean; delThrows?: boolean };
    clientThrows?: boolean;
  } = {},
) {
  const redis = makeRedis(opts.redis);
  const queue = {
    get client(): Promise<unknown> {
      return opts.clientThrows
        ? Promise.reject(new Error("redis connection refused"))
        : Promise.resolve(redis);
    },
  };
  return { store: new PendingIntentStore(queue as unknown as Queue), redis };
}

describe("PendingIntentStore — one key, the closed set, a 10-minute TTL", () => {
  it("stores an intent under the worker's own key with the 600-second TTL", async () => {
    const h = setup();
    await h.store.set(WORKER_ID, "edit_resume");
    expect(h.redis.set).toHaveBeenCalledWith(KEY, "edit_resume", "EX", TTL);
    expect(h.redis.values.get(KEY)).toBe("edit_resume");
    expect(h.redis.ttls.get(KEY)).toBe(TTL);
  });

  it("a new tap replaces the value; another chip's clear removes it", async () => {
    const h = setup();
    await h.store.set(WORKER_ID, "edit_resume");
    await h.store.set(WORKER_ID, "career_talk");
    expect(await h.store.take(WORKER_ID)).toBe("career_talk");
    await h.store.set(WORKER_ID, "edit_resume");
    await h.store.clear(WORKER_ID);
    expect(await h.store.take(WORKER_ID)).toBeNull();
  });

  it("take is ONE-SHOT: the second take finds nothing (a retry cannot reuse it)", async () => {
    const h = setup();
    await h.store.set(WORKER_ID, "career_talk");
    expect(await h.store.take(WORKER_ID)).toBe("career_talk");
    expect(await h.store.take(WORKER_ID)).toBeNull();
    expect(h.redis.getdel).toHaveBeenCalledTimes(2);
  });

  it("an unknown value is dropped, not returned (Redis is not trusted as typed)", async () => {
    const h = setup();
    h.redis.values.set(KEY, "reset_password");
    expect(await h.store.take(WORKER_ID)).toBeNull();
  });
});

describe("PendingIntentStore — every Redis failure is soft", () => {
  it("a refused SET is a warning, not a throw", async () => {
    const h = setup({ redis: { setThrows: true } });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(h.store.set(WORKER_ID, "edit_resume")).resolves.toBeUndefined();
  });

  it("a refused GETDEL is 'no pending intent'", async () => {
    const h = setup({ redis: { getdelThrows: true } });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await h.store.take(WORKER_ID)).toBeNull();
  });

  it("a refused DEL is a warning, not a throw", async () => {
    const h = setup({ redis: { delThrows: true } });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(h.store.clear(WORKER_ID)).resolves.toBeUndefined();
  });

  it("an unreachable client is soft on every method", async () => {
    const h = setup({ clientThrows: true });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(h.store.set(WORKER_ID, "career_talk")).resolves.toBeUndefined();
    expect(await h.store.take(WORKER_ID)).toBeNull();
    await expect(h.store.clear(WORKER_ID)).resolves.toBeUndefined();
  });
});
