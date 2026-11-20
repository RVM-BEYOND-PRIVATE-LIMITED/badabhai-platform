import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { DAILY_FACTS_CAP_SCRIPT, parseStep } from "./pre-pay-facts-daily-cap.service";

/**
 * #2838 — the daily-cap Lua script against a REAL Redis. Opt-in: runs only when
 * `PREPAY_CAP_REDIS_TEST_URL` names a throwaway Redis (e.g. `docker run --rm -p 6390:6379 redis:7`
 * then `PREPAY_CAP_REDIS_TEST_URL=redis://localhost:6390`). A dedicated variable, never `REDIS_URL`,
 * so it cannot touch a shared Redis. It flushes nothing: every key is under a per-run prefix and
 * deleted afterwards.
 */
const URL = process.env.PREPAY_CAP_REDIS_TEST_URL;
const RUN = `prepay_cap_test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

describe.skipIf(!URL)("DAILY_FACTS_CAP_SCRIPT on a real Redis (#2838)", () => {
  // The production path: a BullMQ queue's client is the app's Redis connection.
  const target = URL ? new globalThis.URL(URL) : null;
  const queue = target
    ? new Queue("prepay-cap-test", {
        connection: { host: target.hostname, port: Number(target.port || 6379) },
      })
    : (null as unknown as Queue);
  type Raw = {
    eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
    keys(pattern: string): Promise<string[]>;
    del(...keys: string[]): Promise<number>;
    ttl(key: string): Promise<number>;
  };
  const client = async () => (await queue.client) as unknown as Raw;
  let n = 0;
  let keys: string[] = [];

  beforeEach(() => {
    n += 1;
    const base = `${RUN}:${n}`;
    keys = [`${base}:workers`, `${base}:pages`, `${base}:alert:half`, `${base}:alert:cap`];
  });

  afterAll(async () => {
    const redis = await client();
    const left = await redis.keys(`${RUN}:*`);
    if (left.length > 0) await redis.del(...left);
    await queue.close();
  });

  const page = async (cap: number, ids: string[]) =>
    parseStep(await (await client()).eval(DAILY_FACTS_CAP_SCRIPT, 4, ...keys, String(cap), "3600", ...ids), ids);

  it("counts distinct workers, re-admits a worker already shown, and stops new ones at the cap", async () => {
    const first = await page(4, ["a", "b", "c"]);
    expect([...first.admitted]).toEqual(["a", "b", "c"]);
    expect(first.distinct).toBe(3);
    expect(first.pages).toBe(1);

    // b again (free), d new (the 4th, admitted), e new (over the cap, refused).
    const second = await page(4, ["b", "d", "e"]);
    expect([...second.admitted]).toEqual(["b", "d"]);
    expect(second.distinct).toBe(4);
    expect(second.pages).toBe(2);

    // Over the cap, only workers already shown today keep their facts.
    const third = await page(4, ["e", "a"]);
    expect([...third.admitted]).toEqual(["a"]);
    expect(third.distinct).toBe(4);
    expect(third.pages).toBe(3);
  });

  it("raises each alert exactly once a day", async () => {
    const one = await page(4, ["a"]);
    expect([one.halfAlert, one.capAlert]).toEqual([false, false]);
    const two = await page(4, ["b"]);
    expect([two.halfAlert, two.capAlert]).toEqual([true, false]);
    const three = await page(4, ["c", "d"]);
    expect([three.halfAlert, three.capAlert]).toEqual([false, true]);
    const four = await page(4, ["a", "z"]);
    expect([four.halfAlert, four.capAlert]).toEqual([false, false]);
  });

  it("counts an empty page and sets a TTL on every key it writes", async () => {
    const empty = await page(4, []);
    expect(empty.pages).toBe(1);
    expect(empty.distinct).toBe(0);
    await page(2, ["a", "b"]);
    for (const key of keys) {
      const ttl = await (await client()).ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3600);
    }
  });
});
