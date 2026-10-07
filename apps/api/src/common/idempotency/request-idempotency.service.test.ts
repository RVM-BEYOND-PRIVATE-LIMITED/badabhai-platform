import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { RequestIdempotency, type RunOnceOptions } from "./request-idempotency.service";
import { caught, renderedError } from "./replay-fidelity.test-support";
import { assertExpectedPrice } from "../../pricing/charge-price";

/**
 * #2103 — REPLAY FIDELITY of a stored failure. Before this, a replayed HttpException was rebuilt
 * from `message` alone, so a structured 409 such as
 * `{ reason: "price_mismatch", expected_price_inr, current_price_inr }` came back to the retry as
 * message-only and the client lost the fields it branches on. These cases pin: the object body
 * is stored and replayed verbatim (same status, same rendered `error`); string-form exceptions,
 * non-HTTP errors and outcomes stored BEFORE #2103 replay exactly as they always did; and a
 * `secret` route keeps the body out of Redis in plaintext.
 *
 * Route-level fidelity is pinned beside each route that uses `runOnce` (credits, capacity, plan,
 * boost, quota top-up) — this suite covers the seam itself, which the OTP / verify /
 * account-delete / PIN-reset routes reach through `OtpRequestIdempotency`.
 */

function make() {
  const store = new Map<string, string>();
  const client = {
    set: vi.fn(async (key: string, value: string, _m: string, _s: number, nx?: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
  const pii = {
    hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
    // NOT the identity: the ciphertext must not contain the plaintext, or the "nothing in the
    // clear" assertion below would pass against a bug that stored the body verbatim.
    encrypt: (p: string) => `enc:${Buffer.from(p, "utf8").toString("base64")}`,
    decrypt: (t: string) => {
      if (!t.startsWith("enc:")) throw new Error("not a ciphertext");
      return Buffer.from(t.slice(4), "base64").toString("utf8");
    },
  };
  const seam = new RequestIdempotency(pii as never, { client: Promise.resolve(client) } as never);
  return { seam, store };
}

const run = <T>(
  seam: RequestIdempotency,
  work: () => Promise<T>,
  over: Partial<RunOnceOptions<T>> = {},
): Promise<T> =>
  seam.runOnce<T>({
    namespace: "test_idem",
    scope: "route",
    subject: "subject-1",
    idempotencyKey: "key-1",
    inFlight: () => {
      throw new ConflictException("in flight");
    },
    work,
    ...over,
  });

describe("#2103 — a replayed failure carries the SAME structured body", () => {
  it("price_mismatch 409: same status, identical rendered body, work ran once", async () => {
    const { seam } = make();
    const work = vi.fn(async () => {
      assertExpectedPrice(100, 250);
      return "unreachable";
    });
    const first = await caught(run(seam, work));
    const replay = await caught(run(seam, work));
    expect(work).toHaveBeenCalledTimes(1);
    expect((replay as HttpException).getStatus()).toBe(409);
    expect(renderedError(replay)).toStrictEqual(renderedError(first));
    expect(renderedError(replay)).toStrictEqual({
      statusCode: 409,
      error: "Conflict",
      message: expect.stringContaining("The price changed") as unknown as string,
      reason: "price_mismatch",
      expected_price_inr: 100,
      current_price_inr: 250,
    });
  });

  it("a built-in Nest exception (object form) replays its full body, not message-only", async () => {
    const { seam } = make();
    const work = vi.fn(async () => {
      throw new NotFoundException("Unknown credit pack: nope");
    });
    const first = await caught(run(seam, work));
    const replay = await caught(run(seam, work));
    expect(renderedError(replay)).toStrictEqual(renderedError(first));
    expect(renderedError(replay)).toStrictEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Unknown credit pack: nope",
    });
  });

  it("a `secret` route stores the body as ciphertext and still replays it identically", async () => {
    const { seam, store } = make();
    const work = vi.fn(async () => {
      throw new UnauthorizedException({ message: "Invalid or expired code", attempts_left: 2 });
    });
    const first = await caught(run(seam, work, { secret: true }));
    const raw = [...store.values()][0]!;
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("attempts_left");
    const replay = await caught(run(seam, work, { secret: true }));
    expect(work).toHaveBeenCalledTimes(1);
    expect(renderedError(replay)).toStrictEqual(renderedError(first));
  });

  it("stores nothing beyond what the response returned — the body IS getResponse()", async () => {
    const { seam, store } = make();
    const err = new ConflictException({ reason: "x", n: 1 }, { cause: new Error("db-internal") });
    await caught(run(seam, async () => Promise.reject(err)));
    const stored = JSON.parse([...store.values()][0]!) as { body?: unknown };
    expect(stored.body).toStrictEqual(err.getResponse());
    expect(JSON.stringify(stored)).not.toContain("db-internal");
  });
});

describe("#2103 — backward compatibility: everything else replays exactly as before", () => {
  it("a string-form HttpException stores no body and replays message-only", async () => {
    const { seam, store } = make();
    const work = vi.fn(async () => {
      throw new HttpException("Too many codes requested; please try again later", 429);
    });
    const first = await caught(run(seam, work));
    expect(JSON.parse([...store.values()][0]!)).not.toHaveProperty("body");
    const replay = (await caught(run(seam, work))) as HttpException;
    expect(replay.getStatus()).toBe(429);
    expect(replay.getResponse()).toBe("Too many codes requested; please try again later");
    expect(renderedError(replay)).toStrictEqual(renderedError(first));
  });

  it("an outcome stored BEFORE #2103 (no `body`) replays message-only, as it always did", async () => {
    const { seam, store } = make();
    // Prime the key the way the previous build wrote it: reserve, then a body-less failure.
    const work = vi.fn(async () => "never");
    await caught(
      run(seam, async () => {
        throw new ConflictException("seed");
      }),
    );
    const key = [...store.keys()][0]!;
    store.set(key, JSON.stringify({ ok: false, status: 409, message: "The price changed" }));
    const replay = (await caught(run(seam, work))) as HttpException;
    expect(work).not.toHaveBeenCalled();
    expect(replay.getStatus()).toBe(409);
    expect(replay.getResponse()).toBe("The price changed");
  });

  it("still writes `message` beside `body`, so a rollback build reads every new blob", async () => {
    const { seam, store } = make();
    await caught(
      run(seam, async () => {
        assertExpectedPrice(1, 2);
        return "unreachable";
      }),
    );
    const stored = JSON.parse([...store.values()][0]!) as Record<string, unknown>;
    expect(stored).toMatchObject({ ok: false, status: 409 });
    expect(typeof stored.message).toBe("string");
    expect(stored.message).toContain("The price changed");
  });

  it("a non-HTTP error still replays as the neutral 503 with no body and no internal text", async () => {
    const { seam, store } = make();
    await caught(
      run(seam, async () => {
        throw new Error("ECONNREFUSED 10.0.0.4:6379");
      }),
    );
    expect(JSON.parse([...store.values()][0]!)).not.toHaveProperty("body");
    const replay = (await caught(run(seam, async () => "never"))) as HttpException;
    expect(replay.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(JSON.stringify(renderedError(replay))).not.toContain("ECONNREFUSED");
  });
});
