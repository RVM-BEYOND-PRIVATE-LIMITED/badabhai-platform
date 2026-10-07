import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { FREE_CHAT_FOLD_LOCK_TTL_SECONDS, FreeChatFoldLock } from "./free-chat-fold.lock";

/**
 * ADR-0051 §8 — at most one rolling-summary fold in flight per session: `SET NX EX 60` on the
 * borrowed BullMQ connection, released only by its own holder, and FAIL CLOSED (no Redis, no fold).
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const KEY = `chat:free-chat:fold:${SESSION}`;

function make(opts: { throwOn?: "set" | "eval"; hang?: boolean } = {}) {
  const kv = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string, _ex: "EX", _s: number, _nx: "NX") => {
      if (opts.hang) return new Promise<null>(() => undefined);
      if (opts.throwOn === "set") throw new Error("ECONNREFUSED");
      if (kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (opts.throwOn === "eval") throw new Error("ECONNREFUSED");
      if (kv.get(key) !== token) return 0;
      kv.delete(key);
      return 1;
    }),
  };
  const lock = new FreeChatFoldLock({ client: Promise.resolve(client) } as never);
  return { lock, client, kv };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("FreeChatFoldLock", () => {
  it("acquires with SET NX EX 60 and hands back the token that releases it", async () => {
    const { lock, client, kv } = make();
    const token = await lock.acquire(SESSION);
    expect(token).toEqual(expect.any(String));
    expect(client.set).toHaveBeenCalledWith(
      KEY,
      token,
      "EX",
      FREE_CHAT_FOLD_LOCK_TTL_SECONDS,
      "NX",
    );
    expect(FREE_CHAT_FOLD_LOCK_TTL_SECONDS).toBe(60);
    await lock.release(SESSION, token!);
    expect(kv.has(KEY)).toBe(false);
  });

  it("a second acquire while held gets null — one fold in flight", async () => {
    const { lock } = make();
    expect(await lock.acquire(SESSION)).not.toBeNull();
    expect(await lock.acquire(SESSION)).toBeNull();
  });

  it("releases only its OWN token — a lapsed holder never frees the next fold's lock", async () => {
    const { lock, kv } = make();
    const token = await lock.acquire(SESSION);
    await lock.release(SESSION, "someone-elses-token");
    expect(kv.get(KEY)).toBe(token);
  });

  it("FAILS CLOSED: a Redis error or a hung command is 'no fold now', never a throw", async () => {
    expect(await make({ throwOn: "set" }).lock.acquire(SESSION)).toBeNull();
    expect(await make({ hang: true }).lock.acquire(SESSION)).toBeNull();
  });

  it("a release that fails is swallowed — the TTL frees it", async () => {
    const { lock } = make({ throwOn: "eval" });
    await expect(lock.release(SESSION, "tok")).resolves.toBeUndefined();
  });
});
