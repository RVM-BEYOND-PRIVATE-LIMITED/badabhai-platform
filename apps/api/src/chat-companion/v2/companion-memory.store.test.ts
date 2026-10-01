import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { REDIS_TIMEOUT_MS } from "../../queue/redis-deadline";
import { CompanionMemoryStore } from "./companion-memory.store";

// ---------------------------------------------------------------------------
// CompanionMemoryStore (ADR-0046 O13) — the companion's short-term memory.
//
// The invariants pinned here:
//   - REDIS ONLY, TTL-bounded, capped at MEMORY_TURNS, and trimmed on every append;
//   - the stored value is the turn AS GIVEN (the orchestrator hands it masked text);
//   - every failure is SOFT: a read outage is "no memory" ([]), an append outage is a
//     dropped context, never a thrown error on the worker's turn;
//   - no turn text ever reaches a log line.
// ---------------------------------------------------------------------------

const WORKER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const KEY = `companion:v2:mem:${WORKER_ID}`;
const TURNS = 6;
const TTL = 1_800;

/** Minimal ioredis-shaped fake of the client BullMQ's `queue.client` resolves to. */
function makeRedis(opts: { lrangeThrows?: boolean; rpushThrows?: boolean } = {}) {
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();

  const rpush = vi.fn(async (key: string, ...values: string[]) => {
    if (opts.rpushThrows) throw new Error("redis RPUSH refused");
    const list = lists.get(key) ?? [];
    list.push(...values);
    lists.set(key, list);
    return list.length;
  });
  const lrange = vi.fn(async (key: string, start: number, stop: number) => {
    if (opts.lrangeThrows) throw new Error("redis LRANGE refused");
    const list = lists.get(key) ?? [];
    const from = start < 0 ? Math.max(list.length + start, 0) : start;
    const to = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(from, to);
  });
  const ltrim = vi.fn(async (key: string, start: number, stop: number) => {
    const list = lists.get(key) ?? [];
    const from = start < 0 ? Math.max(list.length + start, 0) : start;
    const to = stop < 0 ? list.length + stop + 1 : stop + 1;
    lists.set(key, list.slice(from, to));
    return "OK";
  });
  const expire = vi.fn(async (key: string, seconds: number) => {
    ttls.set(key, seconds);
    return 1;
  });

  return { rpush, lrange, ltrim, expire, lists, ttls };
}

function setup(
  opts: {
    redis?: { lrangeThrows?: boolean; rpushThrows?: boolean };
    clientThrows?: boolean;
  } = {},
) {
  const redis = makeRedis(opts.redis);
  // `queue.client` is a Promise in production; mirror that here, as a lazy getter so a
  // rejection only exists when something actually asks for the client.
  const queue = {
    get client(): Promise<unknown> {
      return opts.clientThrows
        ? Promise.reject(new Error("redis connection refused"))
        : Promise.resolve(redis);
    },
  };
  const config = {
    CHAT_COMPANION_V2_MEMORY_TURNS: TURNS,
    CHAT_COMPANION_V2_MEMORY_TTL_SECONDS: TTL,
  } as unknown as ServerConfig;
  return { store: new CompanionMemoryStore(config, queue as unknown as Queue), redis };
}

function captureLogs(): { logged: () => string; restore: () => void } {
  const sink: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    }),
  );
  return { logged: () => sink.join(" "), restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe("CompanionMemoryStore — append (capped, TTL-bounded, best-effort)", () => {
  it("appends one turn as JSON, trims to the cap and (re)asserts the TTL", async () => {
    const { store, redis } = setup();
    await store.append(WORKER_ID, { role: "worker", text: "welding add karo" });

    expect(redis.rpush).toHaveBeenCalledTimes(1);
    const [key, value] = redis.rpush.mock.calls[0]!;
    expect(key).toBe(KEY);
    expect(JSON.parse(value as string)).toEqual({ role: "worker", text: "welding add karo" });
    expect(redis.ltrim).toHaveBeenCalledWith(KEY, -TURNS, -1);
    expect(redis.expire).toHaveBeenCalledWith(KEY, TTL);
  });

  it("keeps only the LAST N turns — the cap is enforced on every append", async () => {
    const { store, redis } = setup();
    for (let i = 0; i < TURNS + 3; i += 1) {
      await store.append(WORKER_ID, { role: "worker", text: `turn ${i}` });
    }
    expect(redis.lists.get(KEY)).toHaveLength(TURNS);
    // The survivors are the newest ones, in order.
    const kept = (redis.lists.get(KEY) ?? []).map((e) => JSON.parse(e).text);
    expect(kept).toEqual(["turn 3", "turn 4", "turn 5", "turn 6", "turn 7", "turn 8"]);
  });

  it("swallows an RPUSH outage — a failed append must never fail the worker's turn", async () => {
    const { store } = setup({ redis: { rpushThrows: true } });
    await expect(store.append(WORKER_ID, { role: "worker", text: "x" })).resolves.toBeUndefined();
  });
});

describe("CompanionMemoryStore — read (fail-soft, validates every entry)", () => {
  it("returns the stored turns OLDEST FIRST", async () => {
    const { store, redis } = setup();
    redis.lists.set(KEY, [
      JSON.stringify({ role: "worker", text: "pehla" }),
      JSON.stringify({ role: "bada_bhai", text: "doosra" }),
    ]);
    await expect(store.read(WORKER_ID)).resolves.toEqual([
      { role: "worker", text: "pehla" },
      { role: "bada_bhai", text: "doosra" },
    ]);
    // Reads only the tail the cap allows, never the whole list.
    expect(redis.lrange).toHaveBeenCalledWith(KEY, -TURNS, -1);
  });

  it("drops a corrupt entry but keeps the rest — one bad turn is not an incident", async () => {
    const { store, redis } = setup();
    redis.lists.set(KEY, [
      "not json at all",
      JSON.stringify({ role: "worker", text: "theek hai" }),
      JSON.stringify({ role: "system", text: "off-contract role" }),
      JSON.stringify({ role: "worker", text: "" }),
    ]);
    await expect(store.read(WORKER_ID)).resolves.toEqual([{ role: "worker", text: "theek hai" }]);
  });

  it("a read outage is 'no memory' ([]) — the classifier proceeds without context", async () => {
    const { store } = setup({ redis: { lrangeThrows: true } });
    await expect(store.read(WORKER_ID)).resolves.toEqual([]);
  });

  it("a dead connection is also [] — never a throw", async () => {
    const { store } = setup({ clientThrows: true });
    await expect(store.read(WORKER_ID)).resolves.toEqual([]);
  });

  it("a Redis that NEVER ANSWERS is [] on read and a dropped append — bounded, never hung", async () => {
    // On the shared connection a command against a downed Redis is buffered and never rejects, so
    // only the deadline keeps the read fail-soft. Real timers: the bound is the contract.
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { store, redis } = setup();
      redis.lrange.mockImplementation(() => new Promise<string[]>(() => undefined));
      redis.rpush.mockImplementation(() => new Promise<number>(() => undefined));
      const started = Date.now();
      await expect(store.read(WORKER_ID)).resolves.toEqual([]);
      await expect(store.append(WORKER_ID, { role: "worker", text: "x" })).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(REDIS_TIMEOUT_MS * 2 * 6);
    } finally {
      warn.mockRestore();
    }
  });

  it("no turn text ever reaches a log line on a failure", async () => {
    const { store, redis } = setup();
    redis.lists.set(KEY, [JSON.stringify({ role: "worker", text: "Tata Motors mein tha" })]);
    const logs = captureLogs();
    try {
      await store.read(WORKER_ID);
      await setup({ redis: { lrangeThrows: true } }).store.read(WORKER_ID);
      await setup({ redis: { rpushThrows: true } }).store.append(WORKER_ID, {
        role: "worker",
        text: "Tata Motors mein tha",
      });
    } finally {
      logs.restore();
    }
    expect(logs.logged()).not.toContain("Tata Motors");
  });
});
