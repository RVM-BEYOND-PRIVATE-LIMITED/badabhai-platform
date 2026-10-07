import { describe, expect, it } from "vitest";
import { AdminRequestError } from "./admin-http";
import { isMalformedUuid, isOverLength, isUnknownValue, readRefusal } from "./read-refusal";

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

/**
 * Which filters in the address the server could have refused (review of #2095): a value the
 * page's own chips offer never can be, so a valid filter beside an over-long cursor leaves the
 * cursor as the refused part — not "the reason is not one the ledger records".
 */
describe("isUnknownValue", () => {
  const REASONS = ["pack_purchase", "grant", "unlock_debit", "refund"] as const;

  it("a value the chips offer is known", () => {
    expect(isUnknownValue("grant", REASONS)).toBe(false);
  });

  it("a hand-edited value is unknown — the server may have refused it", () => {
    expect(isUnknownValue("bogus", REASONS)).toBe(true);
    expect(isUnknownValue("GRANT", REASONS)).toBe(true);
  });

  it("an absent value is not a filter at all", () => {
    expect(isUnknownValue(undefined, REASONS)).toBe(false);
  });
});

/** The other two shapes a list filter can take (delta review of #2095): an id, and free text. */
describe("isMalformedUuid", () => {
  it("a uuid is well-formed — the server cannot refuse it for its shape", () => {
    expect(isMalformedUuid("6155050c-c91b-4c6e-96a7-8da023f1d2d2")).toBe(false);
  });

  it("anything else is malformed, and an absent id is no filter", () => {
    expect(isMalformedUuid("nope")).toBe(true);
    expect(isMalformedUuid("6155050c")).toBe(true);
    expect(isMalformedUuid(undefined)).toBe(false);
  });
});

describe("isOverLength", () => {
  it("free text within the API's bound cannot be refused; past it, it can", () => {
    expect(isOverLength("worker.registered", 128)).toBe(false);
    expect(isOverLength("x".repeat(128), 128)).toBe(false);
    expect(isOverLength("x".repeat(129), 128)).toBe(true);
    expect(isOverLength(undefined, 64)).toBe(false);
  });
});
