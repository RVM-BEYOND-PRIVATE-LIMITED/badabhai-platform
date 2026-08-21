import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import { SubjectRateLimit } from "./subject-rate-limit.service";

const SUBJECT = "11111111-1111-4111-8111-111111111111";

function makeRedis(results: Array<number | Error>) {
  let i = 0;
  const incrby = vi.fn(async (_key: string, _by: number) => {
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r as number;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incrby, expire };
}

function setup(opts: { results?: Array<number | Error>; clientThrows?: boolean } = {}) {
  const redis = makeRedis(opts.results ?? [1]);
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  return { svc: new SubjectRateLimit(queue as unknown as Queue), redis };
}

async function expect429(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  await expect(p).rejects.toBeInstanceOf(HttpException);
}

describe("SubjectRateLimit.assertWithinHourlyCap", () => {
  it("allows within the cap, and re-asserts the TTL on EVERY hit", async () => {
    // ON EVERY HIT — which one call cannot demonstrate. A `if (count === cost)` guard passes a
    // single-call assertion trivially, so the anti-pattern this test names has to be shown across
    // SUBSEQUENT hits, where INCRBY returns something other than the cost.
    const { svc, redis } = setup({ results: [1, 2, 3] });
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500),
      ).resolves.toBeUndefined();
    }
    expect(redis.expire).toHaveBeenCalledTimes(3);
    // …and always on the SAME key, with a TTL inside the hour.
    for (const call of redis.expire.mock.calls) {
      expect(call[0]).toBe(redis.incrby.mock.calls[0]![0]);
      expect(call[1]).toBeGreaterThan(0);
      expect(call[1]).toBeLessThanOrEqual(3600);
    }
  });

  it("REFUNDS a rejected charge — nothing was written, so nothing stays spent", async () => {
    // Keeping the charge quietly lowers the cap for the rest of the hour: a worker at 450/500 who
    // sends a 100-batch is refused and left at 550, so the 40-item flush that WOULD have fit is
    // refused too. The refund is what stops one oversized flush from costing a worker their hour.
    const { svc, redis } = setup({ results: [550] });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500, 100));
    expect(redis.incrby).toHaveBeenCalledTimes(2);
    expect(redis.incrby).toHaveBeenLastCalledWith(redis.incrby.mock.calls[0]![0], -100);
  });

  it("still 429s when the refund itself fails, and stays conservative", async () => {
    // Fail-closed on the way out too: a failed refund must never turn a rejection into a pass.
    const { svc, redis } = setup({ results: [550, new Error("READONLY")] });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500, 100));
    expect(redis.incrby).toHaveBeenCalledTimes(2);
  });

  it("does NOT refund a request it allowed", async () => {
    const { svc, redis } = setup({ results: [100] });
    await svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500, 100);
    expect(redis.incrby).toHaveBeenCalledTimes(1);
  });

  it("CHARGES THE COST, so a batch cannot walk around a per-request cap", async () => {
    const { svc, redis } = setup({ results: [100] });
    await svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500, 100);
    expect(redis.incrby).toHaveBeenCalledWith(expect.any(String), 100);
  });

  it("429s the moment the counter passes the cap", async () => {
    const { svc } = setup({ results: [501] });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500));
  });

  it("a single oversized batch can cross the cap on its own", async () => {
    // The counter is charged BEFORE the check, so 100 units against a cap of 50 rejects rather
    // than writing 100 rows and rejecting the next caller.
    const { svc } = setup({ results: [100] });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 50, 100));
  });

  it("namespaces the key by scope AND subject, inside the UTC hour", async () => {
    const { svc, redis } = setup({ results: [1] });
    await svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500);
    const key = redis.incrby.mock.calls[0]![0];
    expect(key).toContain("ratelimit:subject:worker_actions:");
    expect(key).toContain(SUBJECT);
    // `YYYYMMDDHH` tail — two scopes, or two hours, must never share a bucket.
    expect(key).toMatch(/:\d{10}$/);
  });

  it("FAILS CLOSED with 429 when the redis client is unreachable", async () => {
    // An uncapped write path into the events table during the incident least able to absorb it
    // is a worse outcome than dropping best-effort telemetry.
    const { svc } = setup({ clientThrows: true });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500));
  });

  it("FAILS CLOSED with 429 when INCRBY throws mid-flight", async () => {
    const { svc } = setup({ results: [new Error("READONLY")] });
    await expect429(svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500));
  });
});

describe("SubjectRateLimit.assertWithinMinuteCap (#997)", () => {
  it("allows within the cap, and re-asserts the TTL on EVERY hit — inside the MINUTE", async () => {
    // Same anti-pattern this file names for the hourly bucket: a `if (count === cost)` guard
    // passes a single-call assertion trivially, so it has to be shown across SUBSEQUENT hits.
    // The extra assertion here is the CEILING — a to-end-of-HOUR ttl on a minute-stamped key
    // would leak sixty keys an hour per subject and nobody would notice.
    const { svc, redis } = setup({ results: [1, 2, 3] });
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3),
      ).resolves.toBeUndefined();
    }
    expect(redis.expire).toHaveBeenCalledTimes(3);
    for (const call of redis.expire.mock.calls) {
      expect(call[0]).toBe(redis.incrby.mock.calls[0]![0]);
      expect(call[1]).toBeGreaterThan(0);
      expect(call[1]).toBeLessThanOrEqual(60);
    }
  });

  it("429s the moment the counter passes the cap", async () => {
    const { svc } = setup({ results: [4] });
    await expect429(svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3));
  });

  it("REFUNDS a rejected charge — nothing was written, so nothing stays spent", async () => {
    // The window is short, but the reasoning is identical: keeping the charge quietly lowers
    // the cap for the rest of the minute, so a refused submission would also cost the retry.
    const { svc, redis } = setup({ results: [4] });
    await expect429(svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3));
    expect(redis.incrby).toHaveBeenCalledTimes(2);
    expect(redis.incrby).toHaveBeenLastCalledWith(redis.incrby.mock.calls[0]![0], -1);
  });

  it("still 429s when the refund itself fails, and stays conservative", async () => {
    const { svc, redis } = setup({ results: [4, new Error("READONLY")] });
    await expect429(svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3));
    expect(redis.incrby).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED with 429 when the redis client is unreachable", async () => {
    // The shared core's posture, asserted through the new door: a Redis outage must not uncap a
    // write path into an unbounded free-text column.
    const { svc } = setup({ clientThrows: true });
    await expect429(svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3));
  });

  it("FAILS CLOSED with 429 when INCRBY throws mid-flight", async () => {
    const { svc } = setup({ results: [new Error("READONLY")] });
    await expect429(svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3));
  });

  it("namespaces the key by scope AND subject, inside the UTC MINUTE", async () => {
    const { svc, redis } = setup({ results: [1] });
    await svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3);
    const key = redis.incrby.mock.calls[0]![0];
    expect(key).toContain("ratelimit:subject:worker_feedback:");
    expect(key).toContain(SUBJECT);
    // `YYYYMMDDHHmm` tail — twelve digits against the hourly key's ten.
    expect(key).toMatch(/:\d{12}$/);
  });

  it("counts in a DIFFERENT bucket from the hourly cap for the same scope + subject", async () => {
    // THE WHOLE POINT of a second method. If both stamps collided, applying both caps would
    // double-charge one counter and the tighter of the two would silently become the only one.
    const { svc, redis } = setup({ results: [1, 1] });
    await svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 3);
    await svc.assertWithinHourlyCap("worker_feedback", SUBJECT, 20);
    const [minuteKey, hourKey] = [redis.incrby.mock.calls[0]![0], redis.incrby.mock.calls[1]![0]];
    expect(minuteKey).not.toBe(hourKey);
    // The minute key is the hour key plus the two-digit minute — the shared stamp head is what
    // makes both readable in an incident.
    expect(minuteKey.startsWith(hourKey)).toBe(true);
    expect(minuteKey.length).toBe(hourKey.length + 2);
  });

  it("CHARGES THE COST, so the shared core did not lose the parameter on the way through", async () => {
    const { svc, redis } = setup({ results: [5] });
    await svc.assertWithinMinuteCap("worker_feedback", SUBJECT, 10, 5);
    expect(redis.incrby).toHaveBeenCalledWith(expect.any(String), 5);
  });
});
