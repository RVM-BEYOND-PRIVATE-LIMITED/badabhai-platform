import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { loadServerConfig } from "@badabhai/config";
import { AdminPiiRevealCapService } from "./admin-pii-reveal-cap.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/** Redis whose INCRBY returns a queued sequence (hour call, then day call). An Error throws. */
function makeRedis(incrResults: Array<number | Error>) {
  let i = 0;
  const incrby = vi.fn(async (_key: string, _by: number) => {
    const r = incrResults[Math.min(i, incrResults.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r as number;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);
  return { incrby, expire };
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
    // Two windows checked: hour INCRBY, then day INCRBY (TTL re-asserted on each).
    expect(redis.incrby).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledTimes(2);
  });

  it("DENIES with window=hour when the hourly count exceeds the cap (day not even checked)", async () => {
    const { svc, redis } = setup({ incrResults: [11, 1], maxPerHour: 10 });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
    // Short-circuit: only the hour counter was touched.
    expect(redis.incrby).toHaveBeenCalledTimes(1);
  });

  it("DENIES with window=day when the hour is fine but the daily count exceeds the cap", async () => {
    const { svc, redis } = setup({ incrResults: [5, 31], maxPerHour: 10, maxPerDay: 30 });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "day" });
    expect(redis.incrby).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED (deny) when the redis client itself throws (outage)", async () => {
    const { svc } = setup({ clientThrows: true });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("FAILS CLOSED (deny) when the hour INCRBY throws mid-flight", async () => {
    const { svc } = setup({ incrResults: [new Error("READONLY")] });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });
  });

  it("FAILS CLOSED (deny window=day) when the day INCRBY throws after the hour passed", async () => {
    const { svc } = setup({ incrResults: [1, new Error("READONLY")] });
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "day" });
  });

  it("keys are NAMESPACED per-admin (admin_pii_reveal:*) and carry the opaque admin id only", async () => {
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.consume(ADMIN_ID);
    const hourKey = redis.incrby.mock.calls[0]![0];
    const dayKey = redis.incrby.mock.calls[1]![0];
    expect(hourKey).toContain(`admin_pii_reveal:hour:${ADMIN_ID}:`);
    expect(dayKey).toContain(`admin_pii_reveal:day:${ADMIN_ID}:`);
  });
});

/**
 * REGRESSION PIN for the generalisation into {@link
 * import("./admin-egress-cap.service").AdminEgressCapService}.
 *
 * The mechanism moved to a base class so the identity read could reuse it with a different
 * budget and an increment > 1. Nothing about THIS caller was supposed to move with it, and
 * "nothing moved" is not a claim worth making in a commit message — so it is asserted here,
 * against the concrete reveal service rather than the base, on the three things a shared parent
 * could plausibly have changed: which config keys feed the limits, which keyspace the counters
 * live in, and how much a single reveal charges.
 */
describe("the reveal cap is UNCHANGED by the shared egress-cap base", () => {
  it("one reveal charges EXACTLY 1 — the default increment, on both windows", async () => {
    // The generalisation added `increment`. If it ever defaulted to anything else — or if the
    // identity caller's `result_count` leaked in as a shared default — a single reveal would
    // silently consume several units of a 10/hour budget.
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.consume(ADMIN_ID);
    expect(redis.incrby.mock.calls[0]![1]).toBe(1);
    expect(redis.incrby.mock.calls[1]![1]).toBe(1);
  });

  it("reads its limits from ADMIN_PII_REVEAL_MAX_PER_{HOUR,DAY}, whose defaults are still 10/30", async () => {
    // Bound to the REAL config loader, not to a literal in this file: a test that hardcodes 10
    // and 30 would still pass if the schema's defaults changed underneath it, which is exactly
    // the drift this pin exists to catch.
    const real = loadServerConfig({});
    expect(real.ADMIN_PII_REVEAL_MAX_PER_HOUR).toBe(10);
    expect(real.ADMIN_PII_REVEAL_MAX_PER_DAY).toBe(30);

    // ...and the service really reads THOSE keys. Tripping the hour at 11 and the day at 31 is
    // only possible if the base resolved `ADMIN_PII_REVEAL_MAX_PER_*` rather than, say, the
    // identity budget (300/1000), under which both of these would be allowed.
    const redis = makeRedis([11, 1]);
    const svc = new AdminPiiRevealCapService(real, {
      client: Promise.resolve(redis),
    } as unknown as Queue);
    await expect(svc.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "hour" });

    const redis2 = makeRedis([10, 31]);
    const svc2 = new AdminPiiRevealCapService(real, {
      client: Promise.resolve(redis2),
    } as unknown as Queue);
    await expect(svc2.consume(ADMIN_ID)).resolves.toEqual({ ok: false, window: "day" });

    // The boundary itself: at exactly the cap the reveal still goes through.
    const redis3 = makeRedis([10, 30]);
    const svc3 = new AdminPiiRevealCapService(real, {
      client: Promise.resolve(redis3),
    } as unknown as Queue);
    await expect(svc3.consume(ADMIN_ID)).resolves.toEqual({ ok: true });
  });

  it("its keyspace does not collide with the identity cap's", async () => {
    // Two caps sharing a namespace would share a budget by accident: one page of 50 names would
    // exhaust the reveal cap for the rest of the hour.
    const { svc, redis } = setup({ incrResults: [1, 1] });
    await svc.consume(ADMIN_ID);
    for (const call of redis.incrby.mock.calls) {
      expect(call[0]).toMatch(/^admin_pii_reveal:/);
      expect(call[0]).not.toContain("admin_identity");
    }
  });
});
