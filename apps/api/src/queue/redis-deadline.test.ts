import { describe, expect, it, vi } from "vitest";
import { REDIS_TIMEOUT_MS, RedisDeadlineExceededError, withinRedisDeadline } from "./redis-deadline";

/** A command against a downed connection under `maxRetriesPerRequest: null`: it never settles. */
const never = <T>() => new Promise<T>(() => undefined);

describe("withinRedisDeadline — the bound behind every fail-open Redis read", () => {
  it("returns the command's value when it settles in time", async () => {
    await expect(withinRedisDeadline(async () => "OK")).resolves.toBe("OK");
  });

  it("propagates the command's own rejection unchanged", async () => {
    const boom = new Error("redis down");
    await expect(
      withinRedisDeadline(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("REJECTS WITH A DEADLINE ERROR instead of hanging when the command never settles", async () => {
    // Real timers on purpose: the bound is the contract, and a faked clock would prove only that
    // the code calls `setTimeout`.
    const started = Date.now();
    const err = await withinRedisDeadline(never, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisDeadlineExceededError);
    expect((err as Error).name).toBe("RedisDeadlineExceededError");
    expect(Date.now() - started).toBeLessThan(20 * 10);
  });

  it("bounds a pending CONNECTION too — the client await is inside the race", async () => {
    const pendingClient = never<{ get(): Promise<string> }>();
    await expect(
      withinRedisDeadline(async () => (await pendingClient).get(), 20),
    ).rejects.toBeInstanceOf(RedisDeadlineExceededError);
  });

  it("an abandoned command that rejects LATER is defused, never an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (e: Error) => void = () => undefined;
      const late = new Promise<string>((_resolve, reject) => {
        rejectLate = reject;
      });
      await expect(withinRedisDeadline(() => late, 10)).rejects.toBeInstanceOf(
        RedisDeadlineExceededError,
      );
      rejectLate(new Error("reconnect failed"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("clears its timer when the command wins, so nothing fires after the caller moved on", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      await withinRedisDeadline(async () => 1);
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });

  it("defaults to the shared 150 ms bound", () => {
    expect(REDIS_TIMEOUT_MS).toBe(150);
  });
});
