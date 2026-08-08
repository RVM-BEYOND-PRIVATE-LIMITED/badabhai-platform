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
    // Not just the first: a `if (count === cost)` guard leaves a TTL-less key if the process dies
    // between INCRBY and EXPIRE, which caps the subject forever rather than for the hour.
    const { svc, redis } = setup({ results: [1] });
    await expect(
      svc.assertWithinHourlyCap("worker_actions", SUBJECT, 500),
    ).resolves.toBeUndefined();
    expect(redis.expire).toHaveBeenCalledTimes(1);
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
