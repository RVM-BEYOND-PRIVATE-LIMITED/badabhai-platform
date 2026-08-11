import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { QuestionPack } from "@badabhai/ai-contracts";

import { PackCacheService, REDIS_TIMEOUT_MS } from "./pack-cache.service";
import {
  computeContentHash,
  PACK_CACHE_TTL_SECONDS,
  PACK_RESOLUTION_TTL_SECONDS,
} from "./pack-cache.constants";

/** A pack that satisfies `QuestionPackSchema`, which is what the read path validates against. */
function pack(over: Partial<QuestionPack> = {}): QuestionPack {
  const items = [
    {
      question_key: "q_process",
      display_order: 0,
      prompt_text: "q_process?",
      why_text: null,
      retry_text: null,
      target_kind: "none",
      target_field: null,
      target_skill_id: null,
      answer_type: "text",
      is_mandatory: false,
      is_core: false,
      max_asks: 2,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      options: [],
    },
  ];
  return {
    pack_id: "qp_welding",
    version: 1,
    family_id: "fam_welding",
    locale: "hi-IN",
    status: "active",
    content_hash: computeContentHash(items),
    items,
    ...over,
  } as QuestionPack;
}

/**
 * A stubbed ioredis. `store` is the keyspace; `mode` decides how it behaves under failure, and
 * "hang" is the one that matters — see the suite below.
 */
function makeCache(mode: "ok" | "throw" | "hang" = "ok") {
  const store = new Map<string, string>();
  const sets: { key: string; ttl: number | undefined }[] = [];
  const never = new Promise<never>(() => undefined);

  const redis = {
    get: vi.fn(async (key: string) => {
      if (mode === "throw") throw new Error("redis down");
      if (mode === "hang") return never;
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, _mode?: string, seconds?: number) => {
      if (mode === "throw") throw new Error("redis down");
      if (mode === "hang") return never;
      store.set(key, value);
      sets.push({ key, ttl: seconds });
      return "OK";
    }),
    del: vi.fn(async () => 0),
  };
  // BullMQ exposes `client` as a PROMISE, and during an outage that promise itself can be pending
  // — which is why the timeout has to cover it too. `"hang"` reproduces exactly that.
  const queue = { client: mode === "hang" ? never : Promise.resolve(redis) };
  return {
    cache: new PackCacheService(queue as never),
    redis,
    store,
    sets,
  };
}

describe("PackCacheService — round trips", () => {
  it("stores and returns a resolution", async () => {
    const { cache } = makeCache();
    await cache.writeResolution("hi-IN", "dom_welder", "7212", { packId: "qp_welding", version: 3 });
    expect(await cache.readResolution("hi-IN", "dom_welder", "7212")).toEqual({
      hit: true,
      value: { packId: "qp_welding", version: 3 },
    });
  });

  it("distinguishes a MISS from a cached NOTHING", async () => {
    // The distinction is load-bearing: half the corpus is unauthored at any time, and collapsing
    // "not cached" into "no pack" would make those trades re-walk the chain on every turn.
    const { cache } = makeCache();
    expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: false });
    await cache.writeResolution("hi-IN", null, null, null);
    expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: true, value: null });
  });

  it("keys an absent component as `_`, so two absences never collide with a real value", async () => {
    const { cache, store } = makeCache();
    await cache.writeResolution("hi-IN", null, null, null);
    expect([...store.keys()]).toEqual(["packresolve:v1:hi-IN:_:_"]);
  });

  it("stores and returns a pack, under its own key space", async () => {
    const { cache, store } = makeCache();
    await cache.writePack(pack());
    expect([...store.keys()]).toEqual(["packcontent:v1:qp_welding:1"]);
    expect((await cache.readPack("qp_welding", 1))?.pack_id).toBe("qp_welding");
  });

  it("gives each key space the TTL its staleness deserves", async () => {
    // Content ages out on the slow clock (a re-seed rewriting a version in place); a resolution on
    // the fast one (a reviewer flipping which version is active).
    const { cache, sets } = makeCache();
    await cache.writePack(pack());
    await cache.writeResolution("hi-IN", null, null, null);
    expect(sets[0]?.ttl).toBe(PACK_CACHE_TTL_SECONDS);
    expect(sets[1]?.ttl).toBe(PACK_RESOLUTION_TTL_SECONDS);
  });
});

describe("PackCacheService — refusing to trust what it read", () => {
  it("drops a value that fails contract validation", async () => {
    const { cache, store } = makeCache();
    store.set(
      "packcontent:v1:qp_welding:1",
      JSON.stringify({ content_hash: "x", pack: { pack_id: "qp_welding" } }),
    );
    expect(await cache.readPack("qp_welding", 1)).toBeNull();
  });

  it("drops a TRUNCATED pack that validation alone would accept", async () => {
    // THE CHECK `safeParse` CANNOT DO. `QuestionPackSchema` has no minimum item count, so a
    // partially-written or partially-read pack is structurally valid and semantically wrong —
    // half an interview served with no error anywhere. The hash the writer computed is what
    // turns that from silent into a miss.
    const { cache, store } = makeCache();
    const full = pack();
    store.set(
      "packcontent:v1:qp_welding:1",
      JSON.stringify({
        content_hash: computeContentHash(full.items),
        pack: { ...full, items: [] },
      }),
    );
    expect(await cache.readPack("qp_welding", 1)).toBeNull();
  });

  it("ignores an off-contract resolution rather than repairing it", async () => {
    const { cache, store } = makeCache();
    store.set("packresolve:v1:hi-IN:_:_", JSON.stringify({ packId: "qp_welding" })); // no version
    expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: false });
  });

  it("survives a value that is not JSON at all", async () => {
    const { cache, store } = makeCache();
    store.set("packresolve:v1:hi-IN:_:_", "}{not json");
    expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: false });
  });

  it("REFUSES to publish an item-less pack — the mid-reseed shape", async () => {
    // `seed-question-packs.ts` DELETEs a version's items and re-INSERTs them outside a
    // transaction. A read landing in that window produces a pack that validates and hashes
    // self-consistently, so nothing downstream can detect it. Not sharing it is the one cheap
    // guard that stops a re-seed broadcasting an empty interview fleet-wide for a full TTL.
    const { cache, store } = makeCache();
    await cache.writePack(pack({ items: [] } as Partial<QuestionPack>));
    expect(store.size).toBe(0);
  });
});

describe("PackCacheService — failing open", () => {
  it("reports a miss when Redis throws", async () => {
    const { cache } = makeCache("throw");
    expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: false });
    expect(await cache.readPack("qp_welding", 1)).toBeNull();
    await expect(cache.writePack(pack())).resolves.toBeUndefined();
  });

  it("TIMES OUT rather than hanging when Redis never answers", async () => {
    // THE DEFECT A TRY/CATCH CANNOT FIX, and the reason `REDIS_TIMEOUT_MS` exists.
    //
    // `queue.module.ts` builds the shared connection with `maxRetriesPerRequest: null`, and
    // nothing in this repo sets `enableOfflineQueue` — so ioredis defaults it to `true`. A command
    // issued while the connection is down is BUFFERED IN MEMORY AND NEVER REJECTS: it waits for a
    // reconnect that may never come. The `catch` is unreachable and the `await` never returns, so
    // a Redis outage would not slow the chat hot path down, it would STOP it, for every worker at
    // once.
    //
    // Asserted with real timers on purpose: the bound is the contract, and a faked clock would
    // prove only that the code calls `setTimeout`.
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { cache } = makeCache("hang");
      const started = Date.now();
      expect(await cache.readResolution("hi-IN", null, null)).toEqual({ hit: false });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(REDIS_TIMEOUT_MS * 6);
      expect(spy).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("times out a WRITE too, so a doomed write cannot stall the turn that caused it", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { cache } = makeCache("hang");
      await expect(cache.writeResolution("hi-IN", null, null, null)).resolves.toBeUndefined();
      await expect(cache.readPack("qp_welding", 1)).resolves.toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
