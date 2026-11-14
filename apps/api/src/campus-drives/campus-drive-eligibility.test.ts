import { describe, expect, it } from "vitest";
import { PAYER_PROFILE_VERIFICATION_STATUSES } from "@badabhai/db";
import { driveCompanyWithdrawn, driveRequesterStanding } from "./campus-drive-eligibility";

describe("who may ask for a campus drive: a verified employer", () => {
  it("admin approval AND a GST number on file is verified", () => {
    expect(
      driveRequesterStanding({
        role: "employer",
        verificationStatus: "verified",
        hasGstNumber: true,
      }),
    ).toEqual({ eligible: true });
  });

  it("every other review state is not admin approval", () => {
    for (const status of PAYER_PROFILE_VERIFICATION_STATUSES.filter((s) => s !== "verified")) {
      expect(
        driveRequesterStanding({
          role: "employer",
          verificationStatus: status,
          hasGstNumber: true,
        }),
        status,
      ).toEqual({ eligible: false, missing: ["admin_approval"] });
    }
  });

  it("no company record at all is neither approved nor has a GST number", () => {
    expect(
      driveRequesterStanding({ role: "employer", verificationStatus: null, hasGstNumber: false }),
    ).toEqual({ eligible: false, missing: ["admin_approval", "gst_number"] });
  });

  it("an approved company without a GSTIN is NOT verified: a phone-verified owner does not count (owner ruling 14 Nov 2026)", () => {
    expect(
      driveRequesterStanding({
        role: "employer",
        verificationStatus: "verified",
        hasGstNumber: false,
      }),
    ).toEqual({ eligible: false, missing: ["gst_number"] });
  });
});

describe("withdrawn from Campus (owner ruling R2): the create check's reads, plus the account status", () => {
  const ok = {
    role: "employer" as const,
    status: "active" as const,
    verificationStatus: "verified" as const,
    hasGstNumber: true,
  };

  it("an active, verified employer with a GSTIN is not withdrawn", () => {
    expect(driveCompanyWithdrawn(ok)).toBe(false);
  });

  it.each([
    ["verification withdrawn", { verificationStatus: "pending" as const }],
    ["verification suspended", { verificationStatus: "suspended" as const }],
    ["no company record", { verificationStatus: null }],
    ["GSTIN removed", { hasGstNumber: false }],
    ["account suspended", { status: "suspended" as const }],
    ["account archived", { status: "archived" as const }],
    ["account never activated", { status: "pending" as const }],
    ["no account row", { status: null, role: null }],
    ["an agency", { role: "agent" as const }],
  ])("%s is withdrawn", (_name, change) => {
    expect(driveCompanyWithdrawn({ ...ok, ...change })).toBe(true);
  });
});
