import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import {
  ChatTranscriptBuffer,
  TRANSCRIPT_BUFFER_MAX_MESSAGES,
  type TranscriptBuffer,
} from "./chat-transcript.buffer";

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
