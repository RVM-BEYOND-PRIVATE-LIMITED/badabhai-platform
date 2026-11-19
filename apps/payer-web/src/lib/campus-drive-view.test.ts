import { describe, expect, it } from "vitest";
import {
  canCancelCampusDrive,
  oneYearFromTodayInIndia,
  todayInIndia,
} from "./campus-drive-view";
import { campusDriveErrorCopy } from "./campus-drive-messages";

describe("#2813 — campus-drive dates and cancellation", () => {
  it("today and the one-year ceiling are India calendar dates", () => {
    const now = new Date("2026-11-16T20:00:00.000Z"); // 17 Nov 01:30 in India
    expect(todayInIndia(now)).toBe("2026-11-17");
    expect(oneYearFromTodayInIndia(now)).toBe("2027-11-17");
  });

  it("Cancel is offered only while requested or scheduled", () => {
    expect(canCancelCampusDrive("requested")).toBe(true);
    expect(canCancelCampusDrive("scheduled")).toBe(true);
    expect(canCancelCampusDrive("declined")).toBe(false);
    expect(canCancelCampusDrive("completed")).toBe(false);
    expect(canCancelCampusDrive("cancelled")).toBe(false);
  });
});

describe("#2813 — error copy uses the API's closed reasons", () => {
  it("company_not_verified names the missing steps", () => {
    expect(
      campusDriveErrorCopy({
        reason: "company_not_verified",
        missing: ["admin_approval", "gst_number"],
      }),
    ).toContain("Admin verification");
    expect(
      campusDriveErrorCopy({
        reason: "company_not_verified",
        missing: ["admin_approval", "gst_number"],
      }),
    ).toContain("GSTIN");
  });

  it("the roles-note identifier refusal tells the company how to fix it", () => {
    expect(campusDriveErrorCopy({ reason: "roles_note_has_identifier" })).toMatch(
      /numbers in words|contact details/i,
    );
  });

  it("an unknown reason falls back to neutral copy", () => {
    expect(campusDriveErrorCopy({ reason: "something_new" })).not.toMatch(/undefined/);
  });
});
