import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { Queue } from "bullmq";
import { FaltuStore } from "./faltu.store";

const WORKER = "11111111-1111-4111-8111-111111111111";
const DAY = "2026-09-29";
const NOW = new Date("2026-09-29T10:00:00.000Z");

function setup(redis: Partial<Record<string, unknown>> = {}, cooldownMinutes = 30) {
  const client = {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    set: vi.fn(async () => "OK"),
    pttl: vi.fn(async () => -2),
    ...redis,
  };
  const queue = { client: Promise.resolve(client) } as unknown as Queue;
  const config = {
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: cooldownMinutes,
  } as unknown as ServerConfig;
  return { store: new FaltuStore(config, queue), client };
}

describe("FaltuStore (ADR-0046 O11, contracts §7)", () => {
  it("counts strikes under the per-UTC-day key and sets the 24 h TTL only on the first", async () => {
    const h = setup({ incr: vi.fn(async () => 1) });
    expect(await h.store.countStrike(WORKER, DAY)).toBe(1);
    expect(h.client.incr).toHaveBeenCalledWith(`companion:v2:strikes:${WORKER}:${DAY}`);
    expect(h.client.expire).toHaveBeenCalledWith(`companion:v2:strikes:${WORKER}:${DAY}`, 86_400);

    const second = setup({ incr: vi.fn(async () => 2) });
    expect(await second.store.countStrike(WORKER, DAY)).toBe(2);
    // The window is anchored to the day's FIRST strike; later ones must not extend it.
    expect(second.client.expire).not.toHaveBeenCalled();
  });

  it("a Redis failure means NO strike counted — null, never a fabricated count", async () => {
    const h = setup({
      incr: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    expect(await h.store.countStrike(WORKER, DAY)).toBeNull();
  });

  it("starts the cool-down with the configured minutes and returns its end instant", async () => {
    const h = setup({}, 30);
    const until = await h.store.startCooldown(WORKER, NOW);
    expect(h.client.set).toHaveBeenCalledWith(`companion:v2:cooldown:${WORKER}`, "1", "EX", 1_800);
    expect(until).toBe("2026-09-29T10:30:00.000Z");
  });

  it("a Redis failure starting the cool-down means NO cool-down — null, fail open", async () => {
    const h = setup({
      set: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    expect(await h.store.startCooldown(WORKER, NOW)).toBeNull();
  });

  it("reads the cool-down end from the remaining TTL, and only a POSITIVE TTL counts", async () => {
    const cooling = setup({ pttl: vi.fn(async () => 5 * 60_000) });
    expect(await cooling.store.cooldownUntil(WORKER, NOW)).toBe("2026-09-29T10:05:00.000Z");

    // -2 = no key, -1 = key without expiry (a state this store cannot create): not cooling.
    for (const pttl of [-2, -1, 0]) {
      const h = setup({ pttl: vi.fn(async () => pttl) });
      expect(await h.store.cooldownUntil(WORKER, NOW)).toBeNull();
    }
  });

  it("a Redis failure reading the cool-down serves normally — null, fail open", async () => {
    const h = setup({
      pttl: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    expect(await h.store.cooldownUntil(WORKER, NOW)).toBeNull();
  });
});
