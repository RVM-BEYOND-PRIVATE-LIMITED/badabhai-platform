import { describe, expect, it } from "vitest";
import { decodeDriveCursor, encodeDriveCursor } from "./campus-drive-cursor";

const AT = "2026-11-14T06:15:00.123456Z";
const ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("the campus-drive cursors", () => {
  it("round-trips the microsecond position, for each list", () => {
    for (const kind of ["company", "campus"] as const) {
      expect(decodeDriveCursor(kind, encodeDriveCursor(kind, { at: AT, id: ID }))).toEqual({
        at: AT,
        id: ID,
      });
    }
  });

  it("refuses a cursor minted by the other list: it would be read in the wrong order", () => {
    expect(
      decodeDriveCursor("campus", encodeDriveCursor("company", { at: AT, id: ID })),
    ).toBeNull();
    expect(
      decodeDriveCursor("company", encodeDriveCursor("campus", { at: AT, id: ID })),
    ).toBeNull();
  });

  it("refuses anything the server would not have minted", () => {
    const forge = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(decodeDriveCursor("company", "not base64url!")).toBeNull();
    expect(decodeDriveCursor("company", forge({ v: 2, k: "company", t: AT, id: ID }))).toBeNull();
    expect(decodeDriveCursor("company", forge({ v: 1, k: "company", t: AT }))).toBeNull();
    expect(
      decodeDriveCursor("company", forge({ v: 1, k: "company", t: AT, id: ID, payer_id: ID })),
    ).toBeNull();
    // A millisecond JS timestamp is not the keyset's microsecond text.
    expect(
      decodeDriveCursor(
        "company",
        forge({ v: 1, k: "company", t: "2026-11-14T06:15:00.123Z", id: ID }),
      ),
    ).toBeNull();
    // Not a real day (Postgres would 22008 at the bind).
    expect(
      decodeDriveCursor(
        "company",
        forge({ v: 1, k: "company", t: "2026-02-30T00:00:00.000000Z", id: ID }),
      ),
    ).toBeNull();
    expect(decodeDriveCursor("company", "a".repeat(300))).toBeNull();
  });
});
