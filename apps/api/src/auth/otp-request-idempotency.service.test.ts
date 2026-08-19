import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import { OtpRequestIdempotency } from "./otp-request-idempotency.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";

/**
 * #1019 — the transport-retry amplification that 429'd every worker on every device.
 *
 * WHAT THESE TESTS ARE REALLY ASSERTING. The counters live in `OtpService` and the per-IP cap in
 * the controllers; none of them are under test here. What is under test is the ONE property that
 * makes all four safe at once: for a given key, the work runs EXACTLY ONCE. The `work` spy's call
 * count IS the number of counted sends and the number of paid SMS — so `toHaveBeenCalledTimes(1)`
 * after three attempts is the whole bug, stated as an assertion.
 */

/** An in-memory Redis with real `SET NX` semantics — the mutex is the thing being tested. */
function fakeRedis() {
  const store = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string, _mode: string, _ttl: number, nx?: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  return { client, store };
}

function make(over: { redis?: unknown; failClient?: boolean } = {}) {
  const { client, store } = fakeRedis();
  const queue = {
    get client() {
      if (over.failClient) return Promise.reject(new Error("redis connection refused"));
      return Promise.resolve(over.redis ?? client);
    },
  };
  // A REAL digest, not `hash_of_${phone}`. The stub has to be as opaque as the thing it stands
  // in for, or the "never the raw number" assertion below is testing the stub instead of the key
  // builder — and would pass for a production bug that interpolated the phone directly.
  const pii = {
    hashPhone: (p: string) => createHash("sha256").update(p).digest("hex"),
    hmac: (v: string) =>
      createHash("sha256")
        .update("pepper" + v)
        .digest("hex"),
  } as unknown as PiiCryptoService;
  const svc = new OtpRequestIdempotency(pii, queue as never);
  return { svc, client, store };
}

const PHONE = "+919876543210";
const KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SENT = { success: true as const, channel: "sms" as const, resend_in_seconds: 30 };
const IN_FLIGHT_REPLY = { success: true as const, channel: "sms" as const, resend_in_seconds: 30 };

const run = <T>(
  svc: OtpRequestIdempotency,
  work: () => Promise<T>,
  over: { key?: string; phone?: string; scope?: string; inFlight?: () => T } = {},
) =>
  svc.runOnce({
    scope: over.scope ?? "otp_request",
    phoneE164: over.phone ?? PHONE,
    idempotencyKey: "key" in over ? over.key : KEY,
    work,
    inFlight: over.inFlight ?? (() => IN_FLIGHT_REPLY as unknown as T),
  });

describe("the retry ladder — one tap must not become three sends", () => {
  it("runs the work ONCE across the client's three attempts under one key", async () => {
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    // The measured ladder (#999): t=0, t≈15.3s, t≈30.9s, all under the SAME key because the
    // client mints it once per `send()` and reuses it on transport failures.
    const first = await run(svc, work);
    const second = await run(svc, work);
    const third = await run(svc, work);

    // ONE counted send, ONE paid SMS — where it used to be three of each.
    expect(work).toHaveBeenCalledTimes(1);
    // …and every attempt still gets the answer the worker's app needs.
    expect(first).toEqual(SENT);
    expect(second).toEqual(SENT);
    expect(third).toEqual(SENT);
  });

  it("does not run the work a second time while the first attempt is STILL sending", async () => {
    // The case the bug is actually made of: the client's 15s timeout is shorter than a slow
    // Fast2SMS send, so the retry lands while attempt one is mid-flight and nothing has been
    // stored yet. A result-cache alone would miss this; the NX reservation is what catches it.
    const { svc } = make();
    let release!: (v: typeof SENT) => void;
    const work = vi.fn(() => new Promise<typeof SENT>((res) => (release = res)));

    const inflight = run(svc, work);
    const duplicate = await run(svc, work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(duplicate).toEqual(IN_FLIGHT_REPLY);

    release(SENT);
    await expect(inflight).resolves.toEqual(SENT);
  });

  it("serialises a true dead heat — two attempts in the same tick, one send", async () => {
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    const [a, b] = await Promise.all([run(svc, work), run(svc, work)]);

    expect(work).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([SENT, IN_FLIGHT_REPLY]);
  });
});

describe("a failed attempt is replayed, NOT retried — the counters have already moved", () => {
  it("replays the same 429 without re-running the work", async () => {
    // The hourly cap increments BEFORE it checks, so by the time this 429 is thrown the budget
    // is already spent. Re-running would spend it again, which is the amplification itself.
    const { svc } = make();
    const work = vi.fn(async () => {
      throw new HttpException("Too many codes requested; please try again later", 429);
    });

    await expect(run(svc, work)).rejects.toMatchObject({ status: 429 });
    const replayed = await run(svc, work).catch((e: unknown) => e as HttpException);

    expect(work).toHaveBeenCalledTimes(1);
    expect(replayed).toBeInstanceOf(HttpException);
    expect((replayed as HttpException).getStatus()).toBe(429);
    expect((replayed as HttpException).getResponse()).toBe(
      "Too many codes requested; please try again later",
    );
  });

  it("replays a provider 502 identically — a failed send is still one send", async () => {
    const { svc } = make();
    const work = vi.fn(async () => {
      throw new HttpException("Could not send the code, please retry", HttpStatus.BAD_GATEWAY);
    });

    await expect(run(svc, work)).rejects.toMatchObject({ status: 502 });
    const replayed = (await run(svc, work).catch((e: unknown) => e)) as HttpException;

    expect(work).toHaveBeenCalledTimes(1);
    expect(replayed.getStatus()).toBe(502);
  });

  it("does not leak an internal error's text to the worker", async () => {
    // A non-HttpException is not ours to reinterpret: it replays as the same neutral 503 the OTP
    // path already returns, never as the raw message.
    const { svc } = make();
    const work = vi.fn(async () => {
      throw new Error("ECONNREFUSED 10.0.0.4:6379 redis");
    });

    await expect(run(svc, work)).rejects.toThrow("ECONNREFUSED");
    const replayed = (await run(svc, work).catch((e: unknown) => e)) as HttpException;

    expect(work).toHaveBeenCalledTimes(1);
    expect(replayed.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(JSON.stringify(replayed.getResponse())).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(replayed.getResponse())).not.toContain("6379");
  });
});

describe("scoping — a key means one thing, in one place, for one number", () => {
  it("keys on the phone HASH and never the number itself (§2)", async () => {
    const { svc, store } = make();
    await run(
      svc,
      vi.fn(async () => SENT),
    );

    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^otp_idem:otp_request:[0-9a-f]{64}:/);
    expect(keys[0]).not.toContain(PHONE);
    expect(keys[0]).not.toContain("9876543210");
  });

  it("does not let one number's key suppress another number's send", async () => {
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work);
    await run(svc, work, { phone: "+919000000001" });

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not let a login key suppress a PIN reset (or the reverse)", async () => {
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { scope: "otp_request" });
    await run(svc, work, { scope: "pin_reset_request" });

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("treats a genuinely new key as a new request — resend still works", async () => {
    // The recovery path that makes "never release on failure" safe: a worker who waits out the
    // cooldown and taps resend arrives with a FRESH uuid, because the client mints one per call.
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work);
    await run(svc, work, { key: "9a1c0305-e82c-4f89-91d3-3f2504e04f89" });

    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe("the header is optional, and Redis is not a new way to lock workers out", () => {
  it("runs unguarded when no key is sent — the header is not required (§3)", async () => {
    const { svc, store } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { key: undefined });
    await run(svc, work, { key: undefined });

    // Both ran, and nothing was reserved: a caller that never sent the header is unaffected.
    expect(work).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it("treats a whitespace-only key as absent rather than as one shared bucket", async () => {
    // Every caller sending `Idempotency-Key: " "` would otherwise collide on ONE key and
    // suppress each other's sends — a self-inflicted outage.
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { key: "   " });
    await run(svc, work, { key: "   " });

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("FAILS OPEN when Redis is unreachable, because everything downstream fails closed", async () => {
    // Refusing here would add a brand-new way to lock every worker out during an outage, in
    // exchange for deduplication that cannot be performed anyway. The caps and the code store
    // still reject on their own Redis errors, so no SMS escapes and no counter moves.
    const { svc } = make({ failClient: true });
    const work = vi.fn(async () => SENT);

    await expect(run(svc, work)).resolves.toEqual(SENT);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("still answers a duplicate without sending when the replay READ fails", async () => {
    // The reservation is known to exist — the NX lost to it — so the one thing that must not
    // happen is a second send, even though we cannot read what the first attempt decided.
    const { client } = fakeRedis();
    let reads = 0;
    const flaky = {
      set: client.set,
      get: vi.fn(async (k: string) => {
        reads += 1;
        if (reads === 1) throw new Error("redis read failed");
        return client.get(k);
      }),
    };
    const { svc } = make({ redis: flaky });
    const work = vi.fn(async () => SENT);

    await run(svc, work);
    const duplicate = await run(svc, work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(duplicate).toEqual(IN_FLIGHT_REPLY);
  });

  it("lets the attempt through when the window expired between the NX and the GET", async () => {
    // A genuine race, not a duplicate: the reservation is gone, so this attempt is entitled to
    // be a request of its own rather than be answered from a record that no longer exists.
    const { client, store } = fakeRedis();
    const vanishing = {
      set: vi.fn(async (k: string, v: string, m: string, t: number, nx?: string) => {
        const res = await client.set(k, v, m, t, nx);
        if (nx === "NX" && res === null) store.delete(k); // expires right after we lose the NX
        return res;
      }),
      get: client.get,
    };
    const { svc } = make({ redis: vanishing });
    const work = vi.fn(async () => SENT);

    await run(svc, work);
    await run(svc, work);

    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe("the window", () => {
  it("is the 180s the refresh grace already measured for this same retry ladder", () => {
    // Not a fresh guess: #999 measured the client's last honest retry at t≈30.9s and sized
    // SessionService.IDEM_GRACE_SECONDS at ~6× that. Same client, same ladder, same number.
    expect(OtpRequestIdempotency.WINDOW_SECONDS).toBe(180);
    // It must comfortably outlive the ladder, or the last retry lands outside the window and
    // becomes a second send — which is the bug.
    expect(OtpRequestIdempotency.WINDOW_SECONDS).toBeGreaterThan(31);
  });

  it("writes the reservation with that TTL before any work runs", async () => {
    const { svc, client } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work);

    const [, value, mode, ttl, nx] = client.set.mock.calls[0]!;
    expect(value).toBe("in_flight");
    expect(mode).toBe("EX");
    expect(ttl).toBe(OtpRequestIdempotency.WINDOW_SECONDS);
    expect(nx).toBe("NX");
  });
});

/**
 * The Redis key is the one thing on this path an UNAUTHENTICATED caller can size, and the
 * reservation is written before the route's only rate limit runs (the per-IP cap moved inside
 * `work` so a retry does not burn a CGNAT-shared bucket). Left raw, that turns attacker bandwidth
 * into non-evictable memory on the Redis that holds the session store — the same platform-wide
 * lockout #1019 exists to end, reachable without credentials. Caught in review; pinned here.
 */
describe("the Redis key is bounded, whatever the client sends", () => {
  const bigKey = "A".repeat(16 * 1024);

  it("is a FIXED width for a 16KB header, not 16KB of Redis key", async () => {
    const { svc, store } = make();
    await run(
      svc,
      vi.fn(async () => SENT),
      { key: bigKey },
    );

    const key = [...store.keys()][0]!;
    expect(key.length).toBeLessThan(200);
    // Nothing the caller typed survives into the namespace.
    expect(key).not.toContain("AAAA");
    expect(key).toMatch(/^otp_idem:otp_request:[0-9a-f]{64}:[0-9a-f]{64}$/);
  });

  it("keeps every key the same length regardless of input length", async () => {
    const { svc, store } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { key: "a" });
    await run(svc, work, { key: bigKey });

    const lengths = new Set([...store.keys()].map((k) => k.length));
    expect(lengths.size).toBe(1);
  });

  it("still tells two different keys apart after hashing", async () => {
    // Bounding must not collapse distinct requests into one bucket — that would suppress a
    // genuine resend, which is the failure in the opposite direction.
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { key: "key-one" });
    await run(svc, work, { key: "key-two" });

    expect(work).toHaveBeenCalledTimes(2);
  });

  it("still dedupes the SAME key after hashing — the fix must not break the fix", async () => {
    const { svc } = make();
    const work = vi.fn(async () => SENT);

    await run(svc, work, { key: bigKey });
    await run(svc, work, { key: bigKey });

    expect(work).toHaveBeenCalledTimes(1);
  });
});
