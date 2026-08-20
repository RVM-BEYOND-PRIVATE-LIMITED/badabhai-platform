import { describe, it, expect } from "vitest";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";

/**
 * The cursor is client-held state, so every decode path has to survive hostile input: a
 * truncated link, a hand-edited token, a value copied from a different environment. The
 * contract is that ANY of those means "first page", never a 500 and never a query built from
 * an attacker-supplied fragment.
 */

describe("round-trip", () => {
  it("survives encode → decode intact", () => {
    const cursor = { createdAt: "2026-08-04T12:00:00.000Z", id: "80e2b2a0-3633-482b-8f5a-4f092c06e62e" };
    expect(decodeEntityCursor(encodeEntityCursor(cursor))).toEqual(cursor);
  });

  it("is base64url — URL-safe, so it survives a query string unescaped", () => {
    // `a/b+c=d` is not a lazy fixture: `+` `/` `=` are precisely the characters that separate
    // base64url from base64, so an id containing them is what makes this assertion mean
    // something. The ENCODER is what is under test here, and it does not validate — it is a
    // serializer, and keeping it dumb is what lets this case exist at all.
    const token = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "a/b+c=d" });
    expect(token).not.toMatch(/[+/=]/);
    // Deliberately NOT round-tripped. Since #1014 the decoder rejects a non-uuid id, which is
    // asserted below as its own case rather than inverted here — a round-trip through a
    // decoder that now returns null would say nothing about base64url-ness.
  });

  it("rejects an id that a uuid column could never match, however well-formed the token", () => {
    // The other half of the case above, and the #1014 contract. This token is perfectly valid
    // base64url carrying perfectly valid JSON with a perfectly valid timestamp — everything the
    // decoder used to check. Before #1014 it decoded cleanly and bound `a/b+c=d` against a
    // `uuid` column, which Postgres refuses at BIND with 22P02, surfaced as a 500.
    const token = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "a/b+c=d" });
    expect(decodeEntityCursor(token)).toBeNull();
  });

  it("is opaque — the payload is not readable as plain text in the token", () => {
    const token = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "abc" });
    expect(token).not.toContain("createdAt");
    expect(token).not.toContain("2026-08-04");
  });
});

describe("hostile / malformed input all decodes to null (first page)", () => {
  const bad = [
    undefined,
    "",
    "not-base64!!",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ c: 1, i: "x" })).toString("base64url"), // wrong type
    Buffer.from(JSON.stringify({ c: "2026-08-04T12:00:00Z" })).toString("base64url"), // no id
    Buffer.from(JSON.stringify({ i: "x" })).toString("base64url"), // no timestamp
    Buffer.from(JSON.stringify({ c: "yesterday", i: "x" })).toString("base64url"), // unparseable
    Buffer.from(JSON.stringify(["array"])).toString("base64url"),
    Buffer.from(JSON.stringify(null)).toString("base64url"),
  ];

  for (const [i, token] of bad.entries()) {
    it(`case ${i}: returns null instead of throwing`, () => {
      expect(decodeEntityCursor(token as string | undefined)).toBeNull();
    });
  }

  it("an unparseable date is rejected BEFORE it can reach a WHERE clause", () => {
    // `new Date("yesterday")` is an Invalid Date; `created_at < Invalid Date` is not a filter,
    // it is a query that returns nothing for a reason invisible from the response.
    const token = Buffer.from(JSON.stringify({ c: "yesterday", i: "x" })).toString("base64url");
    expect(decodeEntityCursor(token)).toBeNull();
  });

  it("#1014's repro — a valid timestamp with a non-uuid id no longer 500s", () => {
    // Verbatim from the issue. Everything about this token is well-formed except the id, which
    // is exactly why it got past a decoder that only checked the timestamp, and exactly why it
    // faulted at BIND rather than anywhere a reader would look.
    const token = "eyJjIjoiMjAyNi0wOC0xOVQxMjowMDowMC4wMDBaIiwiaSI6IngifQ";
    expect(Buffer.from(token, "base64url").toString("utf8")).toBe(
      '{"c":"2026-08-19T12:00:00.000Z","i":"x"}',
    );
    expect(decodeEntityCursor(token)).toBeNull();
  });
});

/**
 * The complement of the hostile block, and the more important half to hold.
 *
 * A guard that rejects everything satisfies every assertion above while breaking paging for
 * real operators — and that failure is silent, because "cursor rejected" renders as the first
 * page, not as an error. So each of these is a value a `uuid` column really accepts and a real
 * cursor could really carry.
 */
describe("the guard PERMITS every id a uuid column can actually hold", () => {
  it.each([
    ["v4, what gen_random_uuid() emits", "f47ac10b-58cc-4372-a567-0e02b2c3d479"],
    ["v1, valid in a uuid column", "c232ab00-9414-11ec-b3c8-9e6bdeced846"],
    ["v7, in case an id source ever changes", "018f2c4e-1b2a-7c3d-8e4f-5a6b7c8d9e0f"],
    ["the nil uuid", "00000000-0000-0000-0000-000000000000"],
    ["all-f, the other boundary", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["arbitrary hex — no RFC version nibble at all", "12345678-1234-1234-1234-123456789abc"],
    ["uppercase, which Postgres accepts and normalises", "F47AC10B-58CC-4372-A567-0E02B2C3D479"],
  ])("round-trips %s", (_why, id) => {
    const cursor = { createdAt: "2026-08-04T12:00:00.000Z", id };
    expect(decodeEntityCursor(encodeEntityCursor(cursor))).toEqual(cursor);
  });
});
