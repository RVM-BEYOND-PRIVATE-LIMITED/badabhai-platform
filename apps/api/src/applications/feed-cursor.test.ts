import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { FeedQuerySchema } from "./applications.dto";
import { ApplicationsController } from "./applications.controller";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  FEED_CURSOR_MAX_AHEAD,
  FEED_CURSOR_MAX_LENGTH,
  type FeedCursor,
} from "./feed-cursor";

/**
 * #1961 / ADR-0052 — the `GET /feed` cursor codec and its DTO boundary. Every value the server
 * did not mint must come back as `null` from the codec and as a validation failure (the pipe's
 * 400) from the DTO — never a throw, never a cursor that reaches a query.
 */

const ID_A = "a0000000-0000-4000-8000-000000000001";
const ID_B = "b0000000-0000-4000-8000-000000000002";
const T = "2099-01-05T00:00:00.123456Z";

const JOBS: FeedCursor = { v: 1, m: "jobs", o: 50, j: { t: T, id: ID_A } };
const UNION: FeedCursor = { v: 1, m: "union", o: 100, j: null, p: { t: T, id: ID_B } };
const V1: FeedCursor = {
  v: 1,
  m: "v1",
  o: 50,
  k: { b: true, r: 2, t: null, id: ID_B },
  a: [ID_A],
};

const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

const raw = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("encodeFeedCursor / decodeFeedCursor", () => {
  it.each([
    ["jobs", JOBS],
    ["union", UNION],
    ["v1", V1],
  ])("round-trips a %s cursor exactly", (_mode, cursor) => {
    const wire = encodeFeedCursor(cursor);
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding: safe in a query string
    expect(decodeFeedCursor(wire)).toEqual(cursor);
  });

  it("keeps the microsecond digits — a millisecond key would skip rows in one millisecond", () => {
    const decoded = decodeFeedCursor(encodeFeedCursor(JOBS));
    expect(decoded?.m === "jobs" && decoded.j.t).toBe(T);
  });

  it.each([
    ["not base64url", "!!!"],
    ["standard base64 padding", `${encodeFeedCursor(JOBS)}=`],
    ["base64 of non-JSON", Buffer.from("nope").toString("base64url")],
    ["an unknown version", raw({ ...JOBS, v: 2 })],
    ["an unknown mode", raw({ ...JOBS, m: "offset" })],
    ["an extra key", raw({ ...JOBS, worker_id: ID_A })],
    ["a missing key", raw({ v: 1, m: "jobs", o: 0 })],
    ["a negative offset", raw({ ...JOBS, o: -1 })],
    ["a fractional offset", raw({ ...JOBS, o: 1.5 })],
    ["an offset past the bound", raw({ ...JOBS, o: 1_000_001 })],
    ["a millisecond timestamp", raw({ ...JOBS, j: { t: "2099-01-05T00:00:00.123Z", id: ID_A } })],
    ["an impossible date", raw({ ...JOBS, j: { t: "2099-13-45T00:00:00.000000Z", id: ID_A } })],
    ["a non-uuid id", raw({ ...JOBS, j: { t: T, id: "1; DROP TABLE jobs" } })],
    ["an uppercase uuid", raw({ ...JOBS, j: { t: T, id: ID_A.toUpperCase() } })],
    ["a union cursor naming no arm", raw({ ...UNION, p: null })],
    ["a v1 tier outside 1|2", raw({ ...V1, k: { b: true, r: 3, t: null, id: ID_B } })],
    ["a v1 ahead set past the cap", raw({ ...V1, a: Array(FEED_CURSOR_MAX_AHEAD + 1).fill(ID_A) })],
    ["JSON null", raw(null)],
    ["a JSON array", raw([JOBS])],
    ["an over-long value", "A".repeat(FEED_CURSOR_MAX_LENGTH + 1)],
  ])("rejects %s with null, never a throw", (_why, value) => {
    expect(() => decodeFeedCursor(value)).not.toThrow();
    expect(decodeFeedCursor(value)).toBeNull();
  });
});

describe("FeedQuerySchema.cursor (#1961: additive, malformed is a 400)", () => {
  it("is absent by default — the first page", () => {
    expect(FeedQuerySchema.parse({}).cursor).toBeUndefined();
  });

  it("treats an empty `?cursor=` as absent, not as malformed", () => {
    expect(FeedQuerySchema.parse({ cursor: "" }).cursor).toBeUndefined();
  });

  it("decodes a minted cursor into its typed shape", () => {
    expect(FeedQuerySchema.parse({ cursor: encodeFeedCursor(V1) }).cursor).toEqual(V1);
  });

  it.each([
    ["garbage", "garbage!"],
    ["a forged shape", raw({ v: 1, m: "jobs", o: 0, j: { t: "yesterday", id: ID_A } })],
    ["a repeated param (array)", [encodeFeedCursor(JOBS), encodeFeedCursor(JOBS)]],
    ["a number", 42],
    ["an over-long value", "A".repeat(FEED_CURSOR_MAX_LENGTH + 1)],
  ])("fails validation for %s, with the issue on `cursor`", (_why, cursor) => {
    const parsed = FeedQuerySchema.safeParse({ cursor });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["cursor"]);
  });

  it("leaves the other params exactly as they were", () => {
    const parsed = FeedQuerySchema.parse({
      limit: "20",
      city: "Pune",
      cursor: encodeFeedCursor(JOBS),
    });
    expect(parsed.limit).toBe(20);
    expect(parsed.city).toBe("Pune");
  });
});

describe("GET /feed through the real ZodValidationPipe (#1961)", () => {
  it("a malformed cursor is a 400 BadRequestException naming `cursor`, never a 500", () => {
    const pipe = new ZodValidationPipe(FeedQuerySchema);
    let thrown: unknown;
    try {
      pipe.transform({ cursor: "not-a-cursor!" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      issues: [{ path: "cursor", message: "cursor is malformed" }],
    });
  });
});

/**
 * L1 (security review, PR #2116) — `Date.parse` is not a calendar check: it rolls `2026-02-30`
 * over to 2 March and accepts year `0000`, both of which Postgres refuses at the bind (22008) —
 * a forged cursor used to come back as a 500 out of the feed query. The cursor timestamp must
 * round-trip exactly (to the second; the microseconds are the keyset's own) and have a year >= 1,
 * so an impossible date is a 400 at the DTO and never reaches a read.
 */
describe("GET /feed cursor — an impossible calendar date is a 400 and nothing is read (L1)", () => {
  const IMPOSSIBLE = [
    "2026-02-30T00:00:00.000000Z", // 30 February (Date.parse rolls it to 2 March)
    "0000-01-01T00:00:00.000000Z", // year zero (Date.parse accepts it; Postgres does not)
    "2026-13-01T00:00:00.000000Z", // month 13
  ];
  const cursorsAt = (t: string): [string, FeedCursor][] => [
    ["jobs", { v: 1, m: "jobs", o: 50, j: { t, id: ID_A } }],
    ["union", { v: 1, m: "union", o: 50, j: { t, id: ID_A }, p: null }],
    ["v1", { v: 1, m: "v1", o: 50, k: { b: false, r: 1, t, id: ID_B }, a: [] }],
  ];

  function feedThroughThePipe(query: Record<string, unknown>) {
    const getFeed = vi.fn(async () => ({ jobs: [], next_cursor: null }));
    const ctrl = new ApplicationsController({ getFeed } as never);
    const pipe = new ZodValidationPipe(FeedQuerySchema);
    let thrown: unknown;
    try {
      // Nest's order: the @Query pipe runs, THEN the handler. A pipe throw means no handler.
      void ctrl.feed({ id: ID_A } as never, pipe.transform(query), CTX as never);
    } catch (e) {
      thrown = e;
    }
    return { thrown, getFeed };
  }

  it.each(IMPOSSIBLE.flatMap((t) => cursorsAt(t).map(([mode, c]) => [t, mode, c] as const)))(
    "%s in a %s cursor → decode null, 400 naming `cursor`, getFeed never called",
    (_t, _mode, cursor) => {
      const value = encodeFeedCursor(cursor);
      expect(decodeFeedCursor(value)).toBeNull();
      const { thrown, getFeed } = feedThroughThePipe({ cursor: value });
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getStatus()).toBe(400);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({
        issues: [{ path: "cursor", message: "cursor is malformed" }],
      });
      expect(getFeed).not.toHaveBeenCalled();
    },
  );

  it.each([
    "2024-02-29T23:59:59.999999Z", // a real leap day
    "0001-01-01T00:00:00.000000Z", // the smallest year Postgres takes
    "9999-12-31T23:59:59.999999Z",
    T,
  ])("CONTROL: a real instant %s still decodes and reaches the read", (t) => {
    for (const [, cursor] of cursorsAt(t)) {
      expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
      const { thrown, getFeed } = feedThroughThePipe({ cursor: encodeFeedCursor(cursor) });
      expect(thrown).toBeUndefined();
      expect(getFeed).toHaveBeenCalledOnce();
    }
  });
});
