import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import {
  CAS_SCRIPT,
  ChatTranscriptBuffer,
  TRANSCRIPT_BUFFER_MAX_MESSAGES,
  type TranscriptBuffer,
} from "./chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  type ProfilingEnvelope,
} from "../profiling/conversation-state";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const KEY = `chat:transcript:${SESSION}`;

function make(opts: { ttl?: number; throwOn?: "get" | "set" | "del" } = {}) {
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn(async (k: string) => {
      if (opts.throwOn === "get") throw new Error("ECONNREFUSED");
      return store.get(k) ?? null;
    }),
    set: vi.fn(async (k: string, v: string, _mode: string, _sec: number) => {
      if (opts.throwOn === "set") throw new Error("ECONNREFUSED");
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      if (opts.throwOn === "del") throw new Error("ECONNREFUSED");
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
  };
  const queue = { client: Promise.resolve(redis) };
  const config = { CHAT_TRANSCRIPT_TTL_SECONDS: opts.ttl ?? 86_400 };
  const buffer = new ChatTranscriptBuffer(config as never, queue as never);
  return { buffer, redis, store };
}

const sample = (over: Partial<TranscriptBuffer> = {}): TranscriptBuffer => ({
  workerId: WORKER,
  turnCount: 2,
  captured: { trade: "VMC operator" },
  roleFamily: "cnc_vmc",
  messages: [{ role: "worker", text: "VMC chalata hun", at: "2026-07-22T00:00:00.000Z" }],
  startedAt: "2026-07-22T00:00:00.000Z",
  ...over,
});

describe("ChatTranscriptBuffer — round trip", () => {
  it("saves and loads a buffer intact", async () => {
    const { buffer } = make();
    await buffer.save(SESSION, sample());
    expect(await buffer.load(SESSION)).toEqual(sample());
  });

  it("returns null when there is no buffer (first turn, or the TTL lapsed)", async () => {
    const { buffer } = make();
    expect(await buffer.load(SESSION)).toBeNull();
  });

  it("RESETS the TTL on every save, so idleness expires and length does not", async () => {
    // A worker mid-interview must not be timed out for taking thirty turns; they should
    // be timed out for walking away. That distinction is the whole reason `save` re-sets
    // the key rather than letting it age from creation.
    const { buffer, redis } = make({ ttl: 1234 });
    await buffer.save(SESSION, sample());
    await buffer.save(SESSION, sample({ turnCount: 3 }));
    for (const call of redis.set.mock.calls) {
      expect(call[0]).toBe(KEY);
      expect(call[2]).toBe("EX");
      expect(call[3]).toBe(1234);
    }
  });

  it("drop removes the key", async () => {
    const { buffer } = make();
    await buffer.save(SESSION, sample());
    await buffer.drop(SESSION);
    expect(await buffer.load(SESSION)).toBeNull();
  });
});

describe("ChatTranscriptBuffer — fails closed", () => {
  it("load throws 503 rather than silently restarting the interview at question one", async () => {
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { buffer } = make({ throwOn: "get" });
      await expect(buffer.load(SESSION)).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("save throws 503 rather than serving a reply whose answer was never recorded", async () => {
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { buffer } = make({ throwOn: "set" });
      await expect(buffer.save(SESSION, sample())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("drop NEVER throws — by then the transcript is already durable in Postgres", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { buffer } = make({ throwOn: "del" });
      await expect(buffer.drop(SESSION)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never logs the worker's words — a buffer is full of them", async () => {
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { buffer } = make({ throwOn: "set" });
      await buffer
        .save(SESSION, sample({ messages: [{ role: "worker", text: "SECRET_WORDS", at: "x" }] }))
        .catch(() => undefined);
      const logged = JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain("SECRET_WORDS");
      expect(logged).toContain(SESSION); // the opaque id IS logged — that is the point
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("ChatTranscriptBuffer — tolerating a bad value", () => {
  it("discards unparseable JSON instead of wedging the session forever", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { buffer, store, redis } = make();
      store.set(KEY, "{not json");
      expect(await buffer.load(SESSION)).toBeNull();
      // Deleted, not left in place: no retry could clear a key that always throws.
      expect(redis.del).toHaveBeenCalledWith(KEY);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("discards a value that does not look like a buffer", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { buffer, store } = make();
      store.set(KEY, JSON.stringify({ hello: "world" }));
      expect(await buffer.load(SESSION)).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("drops malformed MESSAGES rather than the whole interview", async () => {
    const { buffer, store } = make();
    store.set(
      KEY,
      JSON.stringify({
        workerId: WORKER,
        messages: [
          { role: "worker", text: "keep me", at: "2026-07-22T00:00:00.000Z" },
          { role: "narrator", text: "bad role" },
          { role: "assistant", text: 42 },
          null,
        ],
      }),
    );
    const loaded = await buffer.load(SESSION);
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0]!.text).toBe("keep me");
  });

  it("REBUILDS field-by-field, so a stale key cannot ride back into Postgres", async () => {
    const { buffer, store } = make();
    store.set(
      KEY,
      JSON.stringify({ ...sample(), legacyField: "x", captured: { trade: "welder", bad: 42 } }),
    );
    const loaded = await buffer.load(SESSION);
    expect(loaded).not.toHaveProperty("legacyField");
    // A non-string captured value is dropped too — `captured` is Record<string,string>
    // and the flush writes it straight into the conversation_state JSONB.
    expect(loaded!.captured).toEqual({ trade: "welder" });
  });
});

describe("ChatTranscriptBuffer — the unbounded-growth backstop", () => {
  it("keeps the most recent messages when a buffer exceeds the hard cap", async () => {
    // CHAT_MAX_TURNS already bounds a well-behaved interview, so this never fires in
    // normal use. It exists because that cap is enforced in ChatService, and this class
    // must not depend on that being correct.
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { buffer } = make();
      const messages = Array.from({ length: TRANSCRIPT_BUFFER_MAX_MESSAGES + 10 }, (_, i) => ({
        role: "worker" as const,
        text: `line ${i}`,
        at: "2026-07-22T00:00:00.000Z",
      }));
      await buffer.save(SESSION, sample({ messages }));
      const loaded = await buffer.load(SESSION);
      expect(loaded!.messages).toHaveLength(TRANSCRIPT_BUFFER_MAX_MESSAGES);
      expect(loaded!.messages[0]!.text).toBe("line 10");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("ChatTranscriptBuffer — the key", () => {
  it("is namespaced per session", () => {
    expect(ChatTranscriptBuffer.key(SESSION)).toBe(KEY);
  });

  it("create() starts an empty interview owned by the given worker", () => {
    const fresh = ChatTranscriptBuffer.create(WORKER, "welding", new Date("2026-07-22T00:00:00Z"));
    expect(fresh).toEqual({
      workerId: WORKER,
      turnCount: 0,
      captured: {},
      roleFamily: "welding",
      messages: [],
      startedAt: "2026-07-22T00:00:00.000Z",
    });
  });
});

// ===========================================================================
// Envelope v2 + the Lua CAS (OIE Phase 5)
// ===========================================================================

/**
 * A Redis fake that EXECUTES the CAS semantics rather than merely recording the call.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT, stated plainly. It proves the CALLER's half of the
 * protocol: that `expectedRev` is threaded from the value that was read, that a winner's write
 * carries exactly one increment, that a loser writes nothing at all, and that the `NOSCRIPT` path
 * re-loads. It does NOT execute the Lua text — there is no Lua interpreter here — so the fake and
 * the script agree BY INSPECTION, and "the script's contract" below pins the four properties that
 * agreement rests on, so an edit to one without the other is visible.
 */
function makeCas(opts: { failFirstEvalsha?: boolean } = {}) {
  const store = new Map<string, string>();
  let evalshaCalls = 0;
  const redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    script: vi.fn(async () => "sha-cas"),
    evalsha: vi.fn(
      async (_sha: string, _n: number, key: string, expected: string, payload: string) => {
        evalshaCalls++;
        if (opts.failFirstEvalsha && evalshaCalls === 1) {
          throw new Error("NOSCRIPT No matching script");
        }
        return cas(store, key, expected, payload);
      },
    ),
    eval: vi.fn(async (_body: string, _n: number, key: string, expected: string, payload: string) =>
      cas(store, key, expected, payload),
    ),
  };
  const queue = { client: Promise.resolve(redis) };
  const config = { CHAT_TRANSCRIPT_TTL_SECONDS: 86_400 };
  return { buffer: new ChatTranscriptBuffer(config as never, queue as never), redis, store };
}

/** The Lua script's semantics, in TypeScript. Mirrors CAS_SCRIPT line for line. */
function cas(store: Map<string, string>, key: string, expected: string, payload: string): number {
  const current = store.get(key);
  let rev = 0;
  if (current !== undefined) {
    try {
      const parsed = JSON.parse(current) as { profiling?: { rev?: unknown } };
      if (typeof parsed.profiling?.rev === "number") rev = parsed.profiling.rev;
    } catch {
      rev = 0;
    }
  }
  if (rev !== Number(expected)) return 0;
  store.set(key, payload);
  return 1;
}

const envelope = (over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  ...over,
});

const v2 = (over: Partial<TranscriptBuffer> = {}): TranscriptBuffer => ({
  ...sample(),
  profiling: envelope(),
  ...over,
});

function storedAt(store: Map<string, string>): TranscriptBuffer {
  return JSON.parse(store.get(KEY) as string) as TranscriptBuffer;
}

describe("the v2 envelope survives the buffer round trip", () => {
  it("carries every profiling field back out of Redis", async () => {
    const { buffer } = makeCas();
    await buffer.save(
      SESSION,
      v2({ profiling: envelope({ rev: 0, engineAsks: 3, servedQuestionKey: "q_city" }) }),
    );
    const loaded = await buffer.load(SESSION);
    expect(loaded?.profiling?.engineAsks).toBe(3);
    expect(loaded?.profiling?.servedQuestionKey).toBe("q_city");
  });

  it("leaves a v1 buffer byte-identical — no envelope is materialized", async () => {
    // The whole reason `profiling` is optional. A defaulted object here would rewrite every
    // in-flight v1 interview on its next save.
    const { buffer } = makeCas();
    await buffer.save(SESSION, sample());
    const loaded = await buffer.load(SESSION);
    expect(loaded).toEqual(sample());
    expect(loaded).not.toHaveProperty("profiling");
  });
});

describe("the CAS — two concurrent writers, exactly one rev increment", () => {
  it("lets exactly one of two writers at the same rev win", async () => {
    const { buffer, store } = makeCas();
    // Both read rev 0 — the double-submit the plan describes.
    const a = v2({ profiling: envelope({ rev: 0, engineAsks: 1 }) });
    const b = v2({ profiling: envelope({ rev: 0, engineAsks: 99 }) });

    expect(await buffer.saveWithCas(SESSION, a, 0)).toBe(true);
    expect(await buffer.saveWithCas(SESSION, b, 0)).toBe(false);

    // EXACTLY ONE increment, and the LOSER wrote nothing at all — not a merge, not a partial.
    expect(storedAt(store).profiling?.rev).toBe(1);
    expect(storedAt(store).profiling?.engineAsks).toBe(1);
  });

  it("bumps rev by exactly one per successful write, never by the caller's arithmetic", async () => {
    const { buffer, store } = makeCas();
    let rev = 0;
    for (let i = 0; i < 5; i++) {
      const won = await buffer.saveWithCas(SESSION, v2({ profiling: envelope({ rev }) }), rev);
      expect(won).toBe(true);
      rev = storedAt(store).profiling?.rev as number;
    }
    expect(rev).toBe(5);
  });

  it("creates the key when the interview has never been written", async () => {
    const { buffer } = makeCas();
    expect(await buffer.saveWithCas(SESSION, v2(), 0)).toBe(true);
    expect((await buffer.load(SESSION))?.profiling?.rev).toBe(1);
  });

  it("refuses a stale writer even after several turns", async () => {
    const { buffer } = makeCas();
    await buffer.saveWithCas(SESSION, v2({ profiling: envelope({ rev: 0 }) }), 0);
    await buffer.saveWithCas(SESSION, v2({ profiling: envelope({ rev: 1 }) }), 1);
    // A writer that read rev 1, arriving after rev 2 was already written.
    const stale = await buffer.saveWithCas(SESSION, v2({ profiling: envelope({ rev: 1 }) }), 1);
    expect(stale).toBe(false);
  });

  it("REFUSES to CAS a v1 buffer rather than silently blind-writing it", async () => {
    // `save` and `saveWithCas` are not interchangeable; conflating them is exactly how a blind
    // write lands between a CAS reader's read and its write.
    const { buffer } = makeCas();
    await expect(buffer.saveWithCas(SESSION, sample(), 0)).rejects.toThrow(/profiling envelope/);
  });

  it("still bounds messages at the hard cap on the CAS path", async () => {
    const { buffer } = makeCas();
    const many = Array.from({ length: TRANSCRIPT_BUFFER_MAX_MESSAGES + 10 }, (_, i) => ({
      role: "worker" as const,
      text: `m${i}`,
      at: "2026-07-22T00:00:00.000Z",
    }));
    await buffer.saveWithCas(SESSION, v2({ messages: many }), 0);
    expect((await buffer.load(SESSION))?.messages).toHaveLength(TRANSCRIPT_BUFFER_MAX_MESSAGES);
  });

  it("re-loads the script on NOSCRIPT instead of 503-ing every turn", async () => {
    // A Redis restart or SCRIPT FLUSH invalidates the cached sha; without the fallback every
    // subsequent turn would fail for as long as this process lived.
    const { buffer, redis } = makeCas({ failFirstEvalsha: true });
    expect(await buffer.saveWithCas(SESSION, v2(), 0)).toBe(true);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED on a Redis outage rather than reporting a write that did not happen", async () => {
    const { buffer, redis } = makeCas();
    redis.evalsha.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(buffer.saveWithCas(SESSION, v2(), 0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe("the script's contract — what the fake above assumes", () => {
  it("reads profiling.rev, defaults to 0, compares ARGV[1], and SETs with a TTL", () => {
    // These are the entire agreement between `cas()` in this file and the Lua that actually runs.
    // If the script changes shape, this is what says so.
    expect(CAS_SCRIPT).toContain("parsed.profiling.rev");
    expect(CAS_SCRIPT).toContain("local rev = 0");
    expect(CAS_SCRIPT).toContain("if rev ~= tonumber(ARGV[1]) then return 0 end");
    expect(CAS_SCRIPT).toContain("redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))");
    // pcall, so an unparseable stored value reads as rev 0 rather than erroring the script — a
    // session must never be wedged on a key no retry can clear.
    expect(CAS_SCRIPT).toContain("pcall(cjson.decode, current)");
  });
});
