import { describe, expect, it } from "vitest";
import { AdminRequestError } from "./admin-http";
import { readRefusal } from "./read-refusal";

/**
 * What a failed list read REFUSED — the console's one rule (docs/design/NAVIGATION.md, "A refused
 * read is not an outage"). Credits, Payment orders and Admin users read every failure as an outage
 * (final re-sweep O-3), so a hand-edited `?status=` earned a Retry that could only be refused again.
 */
describe("readRefusal", () => {
  const refused = new AdminRequestError(400, "Invalid filter value.");

  it("a 400 with a filter set refused the filters — even with a cursor beside them", () => {
    // The API refuses a cursor only when it is longer than any it issues (a malformed one falls
    // back to page one), so with a filter in the address the filter is what was refused.
    expect(readRefusal(refused, { filtered: true })).toBe("filters");
    expect(readRefusal(refused, { filtered: true, cursor: "c2" })).toBe("filters");
  });

  it("a 400 with no filter but a page cursor refused the cursor", () => {
    expect(readRefusal(refused, { filtered: false, cursor: "c2" })).toBe("cursor");
  });

  it("a 400 with nothing in the address cannot be the operator's: it is an outage", () => {
    expect(readRefusal(refused, { filtered: false })).toBeNull();
    expect(readRefusal(refused, { filtered: false, cursor: "" })).toBeNull();
  });

  it("anything that is not a 400 is an outage, whatever the address holds", () => {
    for (const err of [
      new AdminRequestError(500, "boom"),
      new AdminRequestError(404, "Not found"),
      new Error("network down"),
      "a thrown string",
    ]) {
      expect(readRefusal(err, { filtered: true, cursor: "c2" })).toBeNull();
    }
  });
});
