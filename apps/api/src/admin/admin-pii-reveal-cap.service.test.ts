import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AdminPiiRevealCapService } from "./admin-pii-reveal-cap.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/** Redis whose INCR returns a queued sequence (hour call, then day call). An Error throws. */
function makeRedis(incrResults: Array<number | Error>) {
  let i = 0;
  const incr = vi.fn(async (_key: string) => {
    const r = incrResults[Math.min(i, incrResults.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r as number;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incr, expire };
}

function setup(opts: {
  incrResults?: Array<number | Error>;
  clientThrows?: boolean;
  maxPerHour?: number;
  maxPerDay?: number;
}) {
  const redis = makeRedis(opts.incrResults ?? [1, 1]);
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };
  const config = {
    ADMIN_PII_REVEAL_MAX_PER_HOUR: opts.maxPerHour ?? 10,
    ADMIN_PII_REVEAL_MAX_PER_DAY: opts.maxPerDay ?? 30,
  } as unknown as ServerConfig;
  const svc = new AdminPiiRevealCapService(config, queue as unknown as Queue);
  return { svc, redis };
}

describe("AdminPiiRevealCapService.consume (must-fix #8) — per-admin hour+day cap, fail-closed", () => {
  it("allows when BOTH the hour and day counts are within cap", async () => {
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: true });
    // Two windows checked: hour INCR, then day INCR (TTL re-asserted on each).
    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it("DENIES with window=hour when the hourly count exceeds the cap (day not even checked)", async () => {
    const { svc, redis } = setup({ incrResults: [11, 1], maxPerHour: 10 });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
    // Short-circuit: only the hour counter was touched.
    expect(redis.incr).toHaveBeenCalledTimes(1);
  });

  it("DENIES with window=day when the hour is fine but the daily count exceeds the cap", async () => {
    const { svc, redis } = setup({ incrResults: [5, 31], maxPerHour: 10, maxPerDay: 30 });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "day" });
    expect(redis.incr).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED (deny) when the redis client itself throws (outage)", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("FAILS CLOSED (deny) when the hour INCR throws mid-flight", async () => {
    const { svc } = setup({ incrResults: [new Error("READONLY")] });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("FAILS CLOSED (deny window=day) when the day INCR throws after the hour passed", async () => {
    const { svc } = setup({ incrResults: [1, new Error("READONLY")] });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "day" });
  });

  it("keys are NAMESPACED per-admin (admin_pii_reveal:*) and carry the opaque admin id only", async () => {
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.consume(ADMIN_ID);
    const hourKey = redis.incr.mock.calls[0]![0];
    const dayKey = redis.incr.mock.calls[1]![0];
    expect(hourKey).toContain(`admin_pii_reveal:hour:${ADMIN_ID}:`);
    expect(dayKey).toContain(`admin_pii_reveal:day:${ADMIN_ID}:`);
  });
});
