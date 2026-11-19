import { describe, expect, it } from "vitest";
import { PutBillingDetailsSchema } from "./invoices.dto";

/** #2749 part 4 — `PUT /payer/billing-details`. Every GSTIN here is a FAKE fixture. */
const FAKE_HARYANA_GSTIN = "06AAAAA0000A1Z6";
const FAKE_MAHARASHTRA_GSTIN = "27AAAAA0000A1Z2";
const parse = (body: unknown) => PutBillingDetailsSchema.safeParse(body);
const issuePaths = (body: unknown): string[] => {
  const r = parse(body);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("PutBillingDetailsSchema", () => {
  it("a state alone is enough (an unregistered buyer)", () => {
    expect(parse({ state_code: "27" })).toMatchObject({ success: true, data: { state_code: "27" } });
  });

  it("a GSTIN with its legal name and address; the GSTIN is normalised", () => {
    const r = parse({
      state_code: "06",
      gstin: " 06aaaaa0000a1z6 ",
      legal_name: "  Fake Buyer Pvt Ltd ",
      address: "Plot 1\nTest Nagar",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.gstin).toBe(FAKE_HARYANA_GSTIN);
      expect(r.data.legal_name).toBe("Fake Buyer Pvt Ltd");
      expect(r.data.address).toBe("Plot 1\nTest Nagar");
    }
  });

  it("refuses an unknown or retired state code", () => {
    expect(issuePaths({ state_code: "99" })).toEqual(["state_code"]);
    expect(issuePaths({ state_code: "25" })).toEqual(["state_code"]);
    expect(issuePaths({ state_code: 6 })).toEqual(["state_code"]);
    expect(issuePaths({})).toEqual(["state_code"]);
  });

  it("refuses a GSTIN with a wrong check character or shape", () => {
    expect(
      issuePaths({ state_code: "06", gstin: "06AAAAA0000A1Z5", legal_name: "X", address: "Y" }),
    ).toEqual(["gstin"]);
  });

  it("a GSTIN's first two digits must be the state code", () => {
    expect(
      issuePaths({ state_code: "06", gstin: FAKE_MAHARASHTRA_GSTIN, legal_name: "X", address: "Y" }),
    ).toEqual(["gstin"]);
  });

  it("a GSTIN needs a legal name and an address", () => {
    expect(issuePaths({ state_code: "06", gstin: FAKE_HARYANA_GSTIN }).sort()).toEqual([
      "address",
      "legal_name",
    ]);
  });

  it("is strict, and caps the text", () => {
    expect(parse({ state_code: "06", payer_id: "x" }).success).toBe(false);
    expect(parse({ state_code: "06", legal_name: "x".repeat(201) }).success).toBe(false);
    expect(parse({ state_code: "06", address: "x".repeat(501) }).success).toBe(false);
    expect(parse({ state_code: "06", legal_name: "   " }).success).toBe(false);
  });

  it("an error message never echoes the GSTIN", () => {
    const r = parse({ state_code: "06", gstin: "06AAAAA0000A1Z5", legal_name: "X", address: "Y" });
    expect(JSON.stringify(r.error?.issues)).not.toContain("06AAAAA0000A1Z5");
  });
});
