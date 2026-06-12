import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import { IpRateLimit } from "./ip-rate-limit.service";
import type { PiiCryptoService } from "../pii-crypto.service";

const IP = "203.0.113.7";

function makeRedis(incrResults: Array<number | Error>) {
  let i = 0;
  const incr = vi.fn(async (_key: string) => {
    const r = incrResults[Math.min(i, incrResults.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incr, expire };
}

function setup(opts: { incrResults?: number[] | Error[]; clientThrows?: boolean } = {}) {
  const redis = makeRedis(opts.incrResults ?? [1]);
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  // Simulate hashIp: deterministic, and (like the real HMAC) does NOT echo the
  // raw IP — so we can assert the raw IP never reaches the Redis key.
  const pii = { hashIp: vi.fn((_ip: string) => "d3adb33fcafef00dd3adb33fcafef00dd3adb33fcafef00d") };
  const svc = new IpRateLimit(
    pii as unknown as PiiCryptoService,
    queue as unknown as Queue,
  );
  return { svc, redis, pii };
}

async function expect429(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  await expect(p).rejects.toBeInstanceOf(HttpException);
}

describe("IpRateLimit.assertWithinHourlyIpCap", () => {
  it("allows when the per-IP count is within cap", async () => {
    const { svc, redis } = setup({ incrResults: [1] });
    await expect(svc.assertWithinHourlyIpCap("resume_download", IP, 20)).resolves.toBeUndefined();
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1); // TTL asserted every hit
  });

  it("429s when the per-IP count exceeds the cap", async () => {
    const { svc } = setup({ incrResults: [21] });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });

  it("NEVER uses the raw IP as the key — it hashes first", async () => {
    const { svc, redis, pii } = setup({ incrResults: [1] });
    await svc.assertWithinHourlyIpCap("interview_kit", IP, 20);
    expect(pii.hashIp).toHaveBeenCalledWith(IP);
    const key = redis.incr.mock.calls[0]![0];
    expect(key).not.toContain(IP); // raw IP must not appear in the Redis key
    expect(key).toContain("ratelimit:ip:interview_kit:");
  });

  it("FAILS CLOSED with 429 when the redis client throws (outage)", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });

  it("FAILS CLOSED with 429 when INCR throws mid-flight", async () => {
    const { svc } = setup({ incrResults: [new Error("READONLY")] });
    await expect429(svc.assertWithinHourlyIpCap("resume_download", IP, 20));
  });
});
