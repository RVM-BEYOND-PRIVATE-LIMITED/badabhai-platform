import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { FeedQuerySchema } from "./applications.dto";
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
