import { describe, it, expect } from "vitest";
import { decodeCursor, encodeCursor, type KeysetCursor } from "./admin-events.cursor";

describe("admin-events keyset cursor (ADMIN-2)", () => {
  const cursor: KeysetCursor = { occurredAt: "2026-06-27T10:00:00.000Z", id: "11111111-1111-1111-1111-111111111111" };

  it("round-trips encode → decode losslessly", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("the token is opaque base64url (no raw json / not the id verbatim)", () => {
    const tok = encodeCursor(cursor);
    expect(tok).not.toContain("occurred");
    expect(tok).not.toContain(cursor.id);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
  });

  it("returns null on undefined / empty / garbage / tampered tokens (fail-safe, no throw)", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-$$$")).toBeNull();
    expect(decodeCursor(Buffer.from("[]", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"o":"nope","i":"x"}', "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"o":"2026-01-01T00:00:00Z"}', "utf8").toString("base64url"))).toBeNull();
  });
});
