import { describe, expect, it } from "vitest";
import { PAYER_PROFILE_VERIFICATION_STATUSES } from "@badabhai/db";
import { driveRequesterStanding } from "./campus-drive-eligibility";

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

  it("an approved company without a GST number is NOT verified: the phone-verified-owner alternative is not built (pending owner decision)", () => {
    expect(
      driveRequesterStanding({
        role: "employer",
        verificationStatus: "verified",
        hasGstNumber: false,
      }),
    ).toEqual({ eligible: false, missing: ["gst_number"] });
  });
});
