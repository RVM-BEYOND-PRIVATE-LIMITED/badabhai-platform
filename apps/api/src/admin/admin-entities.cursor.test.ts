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
    const token = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "a/b+c=d" });
    expect(token).not.toMatch(/[+/=]/);
    expect(decodeEntityCursor(token)?.id).toBe("a/b+c=d");
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
});
