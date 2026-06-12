import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { ResumeRateLimit } from "./resume-rate-limit.service";
import type { ResumeRenderJobData } from "../queue/queue.constants";

const WORKER_ID = "w-1";

/**
 * Minimal fake of the ioredis-shaped counter that BullMQ's `queue.client`
 * resolves to. `incr` returns a scripted value per call; `expire` is recorded.
 */
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

function setup(opts: {
  incrResults?: Array<number | Error>;
  clientThrows?: boolean;
  dailyCap?: number;
  globalCap?: number;
}) {
  const redis = makeRedis(opts.incrResults ?? [1, 1]);
  // `renderQueue.client` is a Promise in production; mirror that here.
  const renderQueue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  const config = {
    RESUME_DAILY_CAP: opts.dailyCap ?? 5,
    RESUME_GLOBAL_DAILY_CAP: opts.globalCap ?? 5000,
  } as ServerConfig;

  const svc = new ResumeRateLimit(
    config,
    renderQueue as unknown as Queue<ResumeRenderJobData>,
  );
  return { svc, redis };
}

async function expect429(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  await expect(p).rejects.toBeInstanceOf(HttpException);
}

describe("ResumeRateLimit.assertWithinDailyCap", () => {
  it("allows when both per-worker and global counts are within cap", async () => {
    // first hit of the day: worker=1, global=1
    const { svc, redis } = setup({ incrResults: [1, 1], dailyCap: 5, globalCap: 5000 });
    await expect(svc.assertWithinDailyCap(WORKER_ID)).resolves.toBeUndefined();
    expect(redis.incr).toHaveBeenCalledTimes(2);
  });

  it("429s when the per-worker INCR exceeds RESUME_DAILY_CAP", async () => {
    // worker count steps to 6 (> cap of 5); global still fine.
    const { svc } = setup({ incrResults: [6, 1], dailyCap: 5, globalCap: 5000 });
    await expect429(svc.assertWithinDailyCap(WORKER_ID));
  });

  it("429s when the GLOBAL count exceeds RESUME_GLOBAL_DAILY_CAP (worker under cap)", async () => {
    // worker fine (3), global over (5001 > 5000).
    const { svc } = setup({ incrResults: [3, 5001], dailyCap: 5, globalCap: 5000 });
    await expect429(svc.assertWithinDailyCap(WORKER_ID));
  });

  it("FAILS CLOSED with 429 when the redis client itself throws (outage)", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect429(svc.assertWithinDailyCap(WORKER_ID));
  });

  it("FAILS CLOSED with 429 when INCR throws mid-flight", async () => {
    const { svc } = setup({ incrResults: [new Error("READONLY")] });
    await expect429(svc.assertWithinDailyCap(WORKER_ID));
  });

  it("sets EXPIRE on EVERY hit (both keys) so a crash can't leave a TTL-less lockout key", async () => {
    // First-of-day (1,1): TTL asserted on both worker + global keys.
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.assertWithinDailyCap(WORKER_ID);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it("still sets EXPIRE on a later hit (value > 1) — not just the first", async () => {
    // Past the first hit (2,4): EXPIRE is idempotent and re-asserted each call.
    const { svc, redis } = setup({ incrResults: [2, 4], dailyCap: 5, globalCap: 5000 });
    await svc.assertWithinDailyCap(WORKER_ID);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it("skips the per-worker key entirely for a system-initiated call (global only)", async () => {
    // perWorker:false → only the global counter is bumped (1 incr, 1 expire).
    const { svc, redis } = setup({ incrResults: [1], dailyCap: 5, globalCap: 5000 });
    await svc.assertWithinDailyCap(WORKER_ID, { perWorker: false });
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("still enforces the GLOBAL cap on a system-initiated call", async () => {
    // perWorker:false but global over cap → 429.
    const { svc } = setup({ incrResults: [5001], dailyCap: 5, globalCap: 5000 });
    await expect429(svc.assertWithinDailyCap(WORKER_ID, { perWorker: false }));
  });
});
