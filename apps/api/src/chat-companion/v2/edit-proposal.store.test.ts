import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { EditProposalStore, type StoredEditProposal } from "./edit-proposal.store";

// ---------------------------------------------------------------------------
// EditProposalStore (ADR-0046 O4/O5) — the pending edit card.
//
// The invariants pinned here:
//   - ONE active proposal per worker: a save REPLACES, never appends;
//   - the key carries a TTL (a card cannot outlive its TTL);
//   - save REPORTS success (false → the caller offers no card, contracts §7), while
//     load/delete are fail-soft (an unreadable card is an expired card);
//   - a stored payload that fails the schema is treated as absent, never applied;
//   - no proposed value ever reaches a log line.
// ---------------------------------------------------------------------------

const WORKER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const KEY = `companion:v2:proposal:${WORKER_ID}`;
const TTL = 600;
const PROPOSAL_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const ROW_ID = "cccccccc-0000-4000-8000-000000000003";

function proposal(over: Partial<StoredEditProposal> = {}): StoredEditProposal {
  return {
    proposal_id: PROPOSAL_ID,
    expires_at: "2026-09-29T12:30:00.000Z",
    rows: [
      {
        row_id: ROW_ID,
        section: "employment",
        op: "edit",
        field: "employer_name",
        value: "Mahindra",
        before: "Tata Motors",
        section_label: "Kaam",
        target: { employment_id: "dddddddd-0000-4000-8000-000000000004" },
      },
    ],
    ...over,
  };
}

/** Minimal ioredis-shaped fake of the client BullMQ's `queue.client` resolves to. */
function makeRedis(
  opts: { getThrows?: boolean; setThrows?: boolean; delThrows?: boolean } = {},
) {
  const kv = new Map<string, string>();
  const ttls = new Map<string, number>();

  const set = vi.fn(async (key: string, value: string, mode: string, seconds: number) => {
    if (opts.setThrows) throw new Error("redis SET refused");
    kv.set(key, value);
    if (mode === "EX") ttls.set(key, seconds);
    return "OK";
  });
  const get = vi.fn(async (key: string) => {
    if (opts.getThrows) throw new Error("redis GET refused");
    return kv.get(key) ?? null;
  });
  const del = vi.fn(async (key: string) => {
    if (opts.delThrows) throw new Error("redis DEL refused");
    const removed = kv.delete(key) ? 1 : 0;
    ttls.delete(key);
    return removed;
  });

  return { set, get, del, kv, ttls };
}

function setup(
  opts: {
    redis?: { getThrows?: boolean; setThrows?: boolean; delThrows?: boolean };
    clientThrows?: boolean;
  } = {},
) {
  const redis = makeRedis(opts.redis);
  const queue = {
    get client(): Promise<unknown> {
      return opts.clientThrows
        ? Promise.reject(new Error("redis connection refused"))
        : Promise.resolve(redis);
    },
  };
  const config = { CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS: TTL } as unknown as ServerConfig;
  return { store: new EditProposalStore(config, queue as unknown as Queue), redis };
}

function captureLogs(): { logged: () => string; restore: () => void } {
  const sink: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    }),
  );
  return { logged: () => sink.join(" "), restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe("EditProposalStore — save (one active card, TTL, reports success)", () => {
  it("writes the proposal JSON at the worker's key with the TTL", async () => {
    const { store, redis } = setup();
    await expect(store.save(WORKER_ID, proposal())).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, seconds] = redis.set.mock.calls[0]!;
    expect(key).toBe(KEY);
    expect(mode).toBe("EX");
    expect(seconds).toBe(TTL);
    expect(JSON.parse(value)).toMatchObject({ proposal_id: PROPOSAL_ID });
  });

  it("a second save REPLACES the first — one active proposal per worker", async () => {
    const { store, redis } = setup();
    await store.save(WORKER_ID, proposal());
    const second = proposal({ proposal_id: "eeeeeeee-0000-4000-8000-000000000005" });
    await store.save(WORKER_ID, second);

    // Same key, one value: the worker's latest card is the only confirmable one.
    expect(redis.kv.size).toBe(1);
    await expect(store.load(WORKER_ID)).resolves.toMatchObject({
      proposal_id: "eeeeeeee-0000-4000-8000-000000000005",
    });
  });

  it("returns FALSE when Redis refuses — the caller then offers no card (contracts §7)", async () => {
    const { store } = setup({ redis: { setThrows: true } });
    await expect(store.save(WORKER_ID, proposal())).resolves.toBe(false);
  });

  it("returns FALSE on a dead connection too — never throws", async () => {
    const { store } = setup({ clientThrows: true });
    await expect(store.save(WORKER_ID, proposal())).resolves.toBe(false);
  });
});

describe("EditProposalStore — load (fail-soft; an unreadable card is an expired card)", () => {
  it("round-trips a stored proposal", async () => {
    const { store } = setup();
    await store.save(WORKER_ID, proposal());
    await expect(store.load(WORKER_ID)).resolves.toEqual(proposal());
  });

  it("is null when nothing is stored", async () => {
    const { store } = setup();
    await expect(store.load(WORKER_ID)).resolves.toBeNull();
  });

  it("is null when the payload is not JSON", async () => {
    const { store, redis } = setup();
    redis.kv.set(KEY, "{not json");
    await expect(store.load(WORKER_ID)).resolves.toBeNull();
  });

  it("is null when the payload fails the schema — a half-valid card is never applied", async () => {
    const { store, redis } = setup();
    redis.kv.set(
      KEY,
      JSON.stringify({ ...proposal(), rows: [{ ...proposal().rows[0], section: "identity" }] }),
    );
    await expect(store.load(WORKER_ID)).resolves.toBeNull();
  });

  it("is null on a GET outage and on a dead connection", async () => {
    await expect(setup({ redis: { getThrows: true } }).store.load(WORKER_ID)).resolves.toBeNull();
    await expect(setup({ clientThrows: true }).store.load(WORKER_ID)).resolves.toBeNull();
  });
});

describe("EditProposalStore — delete (best-effort; the TTL is the backstop)", () => {
  it("removes the stored card", async () => {
    const { store, redis } = setup();
    await store.save(WORKER_ID, proposal());
    await store.delete(WORKER_ID);
    expect(redis.kv.has(KEY)).toBe(false);
    await expect(store.load(WORKER_ID)).resolves.toBeNull();
  });

  it("swallows a DEL outage and a dead connection — it never throws", async () => {
    await expect(
      setup({ redis: { delThrows: true } }).store.delete(WORKER_ID),
    ).resolves.toBeUndefined();
    await expect(setup({ clientThrows: true }).store.delete(WORKER_ID)).resolves.toBeUndefined();
  });
});

describe("EditProposalStore — no proposed value ever reaches a log line", () => {
  it("failures log ids/classes only, never the row's before/after values", async () => {
    const logs = captureLogs();
    try {
      await setup({ redis: { setThrows: true } }).store.save(WORKER_ID, proposal());
      await setup({ redis: { getThrows: true } }).store.load(WORKER_ID);
      await setup({ redis: { delThrows: true } }).store.delete(WORKER_ID);
    } finally {
      logs.restore();
    }
    const out = logs.logged();
    expect(out).not.toContain("Tata Motors");
    expect(out).not.toContain("Mahindra");
    expect(out).not.toContain(PROPOSAL_ID);
  });
});
