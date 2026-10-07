import { describe, expect, it } from "vitest";
import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  PayerApplicantInboxQuerySchema,
} from "./payer-applicant-inbox.dto";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  INBOX_CURSOR_MAX_LENGTH,
} from "./payer-applicant-inbox.cursor";

const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const KEY = {
  appliedKey: "2026-10-01T10:00:00.123456Z",
  applicationId: "4444abcd-4444-4444-8444-00000000000a",
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const parse = (q: Record<string, unknown>) => PayerApplicantInboxQuerySchema.safeParse(q);

describe("PayerApplicantInboxQuerySchema — the query boundary", () => {
  it("an empty query is the first page of everything, 20 rows", () => {
    expect(parse({})).toEqual({
      success: true,
      data: { limit: INBOX_DEFAULT_LIMIT, postingId: undefined, cursor: undefined },
    });
    expect(INBOX_DEFAULT_LIMIT).toBe(20);
  });

  it("limit is bounded 1..50 and coerced from the query string", () => {
    expect(INBOX_MAX_LIMIT).toBe(50);
    expect(parse({ limit: "50" }).data?.limit).toBe(50);
    expect(parse({ limit: "1" }).data?.limit).toBe(1);
    for (const bad of ["0", "51", "-1", "2.5", "abc", "1000000"]) {
      expect(parse({ limit: bad }).success, `limit=${bad}`).toBe(false);
    }
  });

  it("postingId must be a uuid", () => {
    expect(parse({ postingId: POSTING }).data?.postingId).toBe(POSTING);
    for (const bad of ["x", "1", "' OR 1=1 --", POSTING + "0"]) {
      expect(parse({ postingId: bad }).success, bad).toBe(false);
    }
  });

  it("a repeated param (an array) is a 400, never a silent first-wins", () => {
    expect(parse({ postingId: [POSTING, POSTING] }).success).toBe(false);
    expect(parse({ cursor: [encodeInboxCursor(KEY), encodeInboxCursor(KEY)] }).success).toBe(false);
  });

  it("there is no payer slot: payer_id / payerId are rejected, not ignored (XB-A)", () => {
    expect(parse({ payer_id: "aaaaaaaa-0000-4000-8000-00000000000a" }).success).toBe(false);
    expect(parse({ payerId: "aaaaaaaa-0000-4000-8000-00000000000a" }).success).toBe(false);
  });

  it("there is no stage filter: ?stage= is a 400, not a filter that silently does nothing", () => {
    for (const stage of ["new", "shortlist", "passed", ""]) {
      expect(parse({ stage }).success, `stage=${stage}`).toBe(false);
    }
  });

  it("a minted cursor round-trips to its position; an empty cursor is the first page", () => {
    expect(parse({ cursor: encodeInboxCursor(KEY) }).data?.cursor).toEqual(KEY);
    expect(parse({ cursor: "" }).data?.cursor).toBeUndefined();
  });

  it("a cursor the server did not mint is a 400 at the boundary", () => {
    const bad = [
      "not base64!",
      b64({ v: 2, t: KEY.appliedKey, id: KEY.applicationId }), // another version
      b64({ v: 1, t: KEY.appliedKey }), // missing key
      b64({ v: 1, t: KEY.appliedKey, id: KEY.applicationId, p: "x" }), // extra key
      b64({ v: 1, t: "2026-10-01T10:00:00.123Z", id: KEY.applicationId }), // millisecond, not µs
      b64({ v: 1, t: KEY.appliedKey, id: KEY.applicationId.toUpperCase() }), // not the minted form
      b64({ v: 1, t: KEY.appliedKey, id: "x" }),
      b64("just a string"),
      "x".repeat(INBOX_CURSOR_MAX_LENGTH + 1),
    ];
    for (const cursor of bad) expect(parse({ cursor }).success, cursor.slice(0, 40)).toBe(false);
  });
});

describe("inbox cursor codec", () => {
  it("is base64url JSON of {v, t, id} and nothing else", () => {
    const raw = encodeInboxCursor(KEY);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))).toEqual({
      v: 1,
      t: KEY.appliedKey,
      id: KEY.applicationId,
    });
    expect(raw.length).toBeLessThan(INBOX_CURSOR_MAX_LENGTH);
  });

  it("decode never throws — garbage is null", () => {
    for (const raw of ["", "%%%", "e30", b64(null), b64([1, 2])]) {
      expect(() => decodeInboxCursor(raw)).not.toThrow();
      expect(decodeInboxCursor(raw)).toBeNull();
    }
  });
});
