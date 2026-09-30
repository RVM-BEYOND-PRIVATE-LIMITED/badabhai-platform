import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import { REDIS_TIMEOUT_MS } from "../../queue/redis-deadline";
import { V2_FALTU_REDIRECT } from "../companion-replies";
import { v2CopyTurn } from "./companion-v2-compose";
import { CompanionTurnReplayStore, TURN_REPLAY_TTL_SECONDS } from "./turn-replay.store";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const KEY = `companion:v2:turn:${WORKER}:${SID}`;
const TURN = v2CopyTurn(V2_FALTU_REDIRECT);

function setup(redis: Partial<Record<string, unknown>> = {}) {
  const client = {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => "OK"),
    ...redis,
  };
  const queue = { client: Promise.resolve(client) } as unknown as Queue;
  return { store: new CompanionTurnReplayStore(queue), client };
}

const boom = () =>
  vi.fn(async () => {
    throw new Error("redis down");
  });

describe("CompanionTurnReplayStore (contracts §7) — a retried submission is answered once", () => {
  it("remembers the served turn under the worker+submission key, with the replay TTL", async () => {
    const h = setup();
    await h.store.remember(WORKER, SID, TURN);
    expect(h.client.set).toHaveBeenCalledWith(KEY, JSON.stringify(TURN), "EX", TURN_REPLAY_TTL_SECONDS);
  });

  it("reads back exactly the turn it stored", async () => {
    const h = setup({ get: vi.fn(async () => JSON.stringify(TURN)) });
    expect(await h.store.read(WORKER, SID)).toEqual(TURN);
    expect(h.client.get).toHaveBeenCalledWith(KEY);
  });

  it("a miss is null — the message is processed", async () => {
    expect(await setup().store.read(WORKER, SID)).toBeNull();
  });

  it("a stored value that is not a valid turn is a miss, never a half-trusted replay", async () => {
    for (const raw of ["not json", JSON.stringify({ mode: "companion" }), JSON.stringify({ ...TURN, leak: 1 })]) {
      expect(await setup({ get: vi.fn(async () => raw) }).store.read(WORKER, SID)).toBeNull();
    }
  });

  it("FAILS OPEN: an unreadable cache is a miss and an unwritable one throws nothing", async () => {
    expect(await setup({ get: boom() }).store.read(WORKER, SID)).toBeNull();
    await expect(setup({ set: boom() }).store.remember(WORKER, SID, TURN)).resolves.toBeUndefined();
  });

  it("a Redis that NEVER ANSWERS is a miss and a skipped write — bounded, never a hung message", async () => {
    // Every v1-miss message that carries a submission_id awaits this read. On the shared
    // connection a command against a downed Redis never rejects, so only the deadline keeps it
    // fail-open. Real timers: the bound is the contract.
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const never = () => vi.fn(() => new Promise<never>(() => undefined));
    try {
      const started = Date.now();
      expect(await setup({ get: never() }).store.read(WORKER, SID)).toBeNull();
      await expect(setup({ set: never() }).store.remember(WORKER, SID, TURN)).resolves.toBeUndefined();
      // A connection that never comes up is bounded too — the client await is inside the race.
      const pending = new CompanionTurnReplayStore({
        client: new Promise<never>(() => undefined),
      } as unknown as Queue);
      expect(await pending.read(WORKER, SID)).toBeNull();
      expect(Date.now() - started).toBeLessThan(REDIS_TIMEOUT_MS * 3 * 6);
    } finally {
      warn.mockRestore();
    }
  });
});
