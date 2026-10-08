import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import {
  FREE_CHAT_NEWS_CAP_GRACE_SECONDS,
  FREE_CHAT_NEWS_DAILY_CAP,
  FreeChatNewsCap,
  istDayOf,
  newsCapExpiryOf,
  newsCapKey,
} from "./free-chat-news-cap.store";

/**
 * ADR-0054 R5 / §3.4 — five news answers per worker per IST day: INCR on the borrowed BullMQ
 * connection, expiring an hour after IST midnight, the over-cap INCR handed straight back, a DECR
 * release, and FAIL CLOSED (no Redis, no call).
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-08T10:00:00.000Z");

type Fault = "command" | "abort" | "reject" | "hang";

/**
 * An in-memory Redis with the two shapes the store uses: a MULTI … EXEC block (queued commands run
 * together; ioredis's `[error, result]` pairs, or null when aborted) and a bare DECR. `transactions`
 * records each EXEC's command names, so atomicity is asserted, not assumed.
 */
function make(opts: { fault?: Fault } = {}) {
  const kv = new Map<string, number>();
  const expiry = new Map<string, number>();
  const transactions: string[][] = [];
  const bump = (key: string, by: number) => {
    const next = (kv.get(key) ?? 0) + by;
    kv.set(key, next);
    return next;
  };
  const multi = () => {
    const queued: Array<{ name: string; run: () => unknown }> = [];
    const tx = {
      incr: (key: string) => (queued.push({ name: "incr", run: () => bump(key, 1) }), tx),
      decr: (key: string) => (queued.push({ name: "decr", run: () => bump(key, -1) }), tx),
      expireat: (key: string, at: number) => (
        queued.push({ name: "expireat", run: () => (expiry.set(key, at), 1) }),
        tx
      ),
      exec: vi.fn(async (): Promise<Array<[Error | null, unknown]> | null> => {
        if (opts.fault === "hang") return new Promise(() => undefined);
        if (opts.fault === "reject") throw new Error("ECONNREFUSED");
        if (opts.fault === "abort") return null;
        transactions.push(queued.map((q) => q.name));
        if (opts.fault === "command") return queued.map(() => [new Error("WRONGTYPE"), null]);
        return queued.map((q) => [null, q.run()]);
      }),
    };
    return tx;
  };
  const client = {
    multi: vi.fn(multi),
    decr: vi.fn(async (key: string) => bump(key, -1)),
  };
  const cap = new FreeChatNewsCap({ client: Promise.resolve(client) } as never);
  return { cap, client, kv, expiry, transactions };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the IST day — keyed by India's calendar, not UTC's", () => {
  it("turns over at 18:30 UTC (IST midnight)", () => {
    expect(istDayOf(new Date("2026-10-08T18:29:59.999Z"))).toBe("2026-10-08");
    expect(istDayOf(new Date("2026-10-08T18:30:00.000Z"))).toBe("2026-10-09");
    // Early IST morning is still "yesterday" in UTC.
    expect(istDayOf(new Date("2026-10-08T20:00:00.000Z"))).toBe("2026-10-09");
    expect(istDayOf(new Date("2026-12-31T18:30:00.000Z"))).toBe("2027-01-01");
  });

  it("the key names the worker and the IST day — ids and a date only", () => {
    expect(newsCapKey(WORKER, NOW)).toBe(`free_chat:news:${WORKER}:2026-10-08`);
    expect(newsCapKey(WORKER, new Date("2026-10-08T18:30:00.000Z"))).toBe(
      `free_chat:news:${WORKER}:2026-10-09`,
    );
  });

  it("expires one hour after the end of the IST day, whenever in that day it is reserved", () => {
    const end = Date.parse("2026-10-08T18:30:00.000Z") / 1000 + FREE_CHAT_NEWS_CAP_GRACE_SECONDS;
    expect(FREE_CHAT_NEWS_CAP_GRACE_SECONDS).toBe(3_600);
    for (const at of [
      "2026-10-07T18:30:00.000Z",
      "2026-10-08T10:00:00.000Z",
      "2026-10-08T18:29:59.999Z",
    ]) {
      expect(newsCapExpiryOf(new Date(at)), at).toBe(end);
    }
    expect(newsCapExpiryOf(new Date("2026-10-08T18:30:00.000Z"))).toBe(end + 86_400);
  });
});

describe("reserve", () => {
  it("counts up to the cap of five, INCR and EXPIREAT in ONE MULTI on every hit", async () => {
    const { cap, transactions, expiry } = make();
    expect(FREE_CHAT_NEWS_DAILY_CAP).toBe(5);
    for (let i = 1; i <= FREE_CHAT_NEWS_DAILY_CAP; i++) {
      expect(await cap.reserve(WORKER, NOW)).toEqual({ ok: true, count: i });
    }
    expect(transactions).toEqual(Array(FREE_CHAT_NEWS_DAILY_CAP).fill(["incr", "expireat"]));
    expect(expiry.get(newsCapKey(WORKER, NOW))).toBe(newsCapExpiryOf(NOW));
  });

  it("over the cap: not ok, the INCR handed straight back, the count held reported", async () => {
    const { cap, client, kv } = make();
    for (let i = 0; i < FREE_CHAT_NEWS_DAILY_CAP; i++) await cap.reserve(WORKER, NOW);
    expect(await cap.reserve(WORKER, NOW)).toEqual({ ok: false, count: 5 });
    expect(await cap.reserve(WORKER, NOW)).toEqual({ ok: false, count: 5 });
    expect(client.decr).toHaveBeenCalledTimes(2);
    expect(kv.get(newsCapKey(WORKER, NOW))).toBe(5);
  });

  it("a new IST day is a new counter", async () => {
    const { cap } = make();
    for (let i = 0; i < FREE_CHAT_NEWS_DAILY_CAP; i++) await cap.reserve(WORKER, NOW);
    expect(await cap.reserve(WORKER, new Date("2026-10-08T18:30:00.000Z"))).toEqual({
      ok: true,
      count: 1,
    });
  });

  it.each(["command", "abort", "reject", "hang"] as const)(
    "FAILS CLOSED on a %s — null, never a throw",
    async (fault) => {
      expect(await make({ fault }).cap.reserve(WORKER, NOW)).toBeNull();
    },
  );
});

describe("release", () => {
  it("hands back the slot on the key the reservation used, DECR and EXPIREAT in ONE MULTI", async () => {
    const { cap, kv, transactions, expiry } = make();
    await cap.reserve(WORKER, NOW);
    await cap.reserve(WORKER, NOW);
    await cap.release(WORKER, NOW);
    expect(kv.get(newsCapKey(WORKER, NOW))).toBe(1);
    expect(transactions.at(-1)).toEqual(["decr", "expireat"]);
    expect(expiry.get(newsCapKey(WORKER, NOW))).toBe(newsCapExpiryOf(NOW));
  });

  it("a released slot can be taken again — a failure costs the worker nothing", async () => {
    const { cap } = make();
    for (let i = 0; i < FREE_CHAT_NEWS_DAILY_CAP; i++) await cap.reserve(WORKER, NOW);
    await cap.release(WORKER, NOW);
    expect(await cap.reserve(WORKER, NOW)).toEqual({ ok: true, count: 5 });
  });

  it("a release that fails is swallowed", async () => {
    for (const fault of ["command", "abort", "reject", "hang"] as const) {
      await expect(make({ fault }).cap.release(WORKER, NOW)).resolves.toBeUndefined();
    }
  });
});
