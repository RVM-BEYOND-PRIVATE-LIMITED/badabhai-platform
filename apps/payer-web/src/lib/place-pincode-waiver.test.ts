import { describe, expect, it } from "vitest";
import { looksLikePii } from "@badabhai/validators";
import {
  agencyJobInputSchema,
  createPostingInputSchema,
  placeLooksLikeContact,
  updatePostingInputSchema,
} from "./contracts";

/**
 * #1971 — PARITY with the server's city/area screen, `workerVisiblePlaceScreens` in
 * apps/api/src/common/job-content.schemas.ts (#1848). The server waives ONLY the
 * contact-details refusal when a standalone pincode alone explains it; `placeFieldSchema`
 * must do the same so the company and agency forms stop refusing places the API accepts.
 * Keep these cases in step with the server's tests for `workerVisiblePlaceScreens`.
 */

const ACCEPTED = [
  "Sector 63 201301",
  "Sector 63 - 201301",
  "Phase 2 411026",
  "MIDC Phase 2 411026",
  "Plot 7 411026",
] as const;

const REFUSED_CONTACT = [
  "Pune 9876543210", // a ten-digit mobile
  "411026 9876543210", // a pincode does not launder a mobile beside it
  "Pune 987654 3210", // a mobile split to fake a pincode token
  "Pune 020 2567 8901", // an eleven-digit landline with its STD code
  "hr@411026.xyz", // an email, even one whose host looks like a pincode
  "jobs@acme.in", // an email
] as const;

const AGENCY_BASE = {
  tradeKey: "cnc_operator",
  roleKind: "cnc_turner",
  title: "CNC Operator",
  city: "Pune",
} as const;
const CREATE_BASE = { roleTitle: "CNC Machinist", vacancies: 3 } as const;
const UPDATE_BASE = { roleTitle: "CNC Machinist" } as const;

describe("placeLooksLikeContact mirrors the server's pincode waiver (#1971)", () => {
  it.each(ACCEPTED)("waives the contact refusal of %s", (s) => {
    // Precondition: plain `looksLikePii` refuses it — the waiver is what lets it through.
    expect(looksLikePii(s)).toBe(true);
    expect(placeLooksLikeContact(s)).toBe(false);
  });

  it.each(REFUSED_CONTACT)("still refuses %s", (s) => {
    expect(placeLooksLikeContact(s)).toBe(true);
  });
});

describe("company posting form — city/area accept a sector/phase/plot + pincode (#1971)", () => {
  it.each(ACCEPTED)("accepts %s as city and area", (s) => {
    expect(createPostingInputSchema.safeParse({ ...CREATE_BASE, city: s, area: s }).success).toBe(true);
    expect(updatePostingInputSchema.safeParse({ ...UPDATE_BASE, city: s, area: s }).success).toBe(true);
  });

  it.each(REFUSED_CONTACT)("refuses %s as city or area", (s) => {
    expect(createPostingInputSchema.safeParse({ ...CREATE_BASE, city: s }).success).toBe(false);
    expect(createPostingInputSchema.safeParse({ ...CREATE_BASE, area: s }).success).toBe(false);
    expect(updatePostingInputSchema.safeParse({ ...UPDATE_BASE, city: s }).success).toBe(false);
    expect(updatePostingInputSchema.safeParse({ ...UPDATE_BASE, area: s }).success).toBe(false);
  });
});

describe("agency job form — city/area accept a sector/phase/plot + pincode (#1971)", () => {
  it.each(ACCEPTED)("accepts %s as city and area", (s) => {
    expect(agencyJobInputSchema.safeParse({ ...AGENCY_BASE, city: s, area: s }).success).toBe(true);
  });

  it.each(REFUSED_CONTACT)("refuses %s as city or area", (s) => {
    expect(agencyJobInputSchema.safeParse({ ...AGENCY_BASE, city: s }).success).toBe(false);
    expect(agencyJobInputSchema.safeParse({ ...AGENCY_BASE, area: s }).success).toBe(false);
  });
});

describe("the waiver is contact-details only — company-name and link screens unchanged", () => {
  it("still refuses a company name or a link beside a pincode", () => {
    for (const s of ["Tata Steel Pvt Ltd 411026", "https://acme.example 411026"]) {
      expect(agencyJobInputSchema.safeParse({ ...AGENCY_BASE, city: s }).success).toBe(false);
      expect(createPostingInputSchema.safeParse({ ...CREATE_BASE, area: s }).success).toBe(false);
    }
  });

  it("reports the contact-details message, naming the field, for a refused place", () => {
    const res = agencyJobInputSchema.safeParse({ ...AGENCY_BASE, area: "Pune 9876543210" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.map((i) => i.message)).toContain("Remove contact details from the area.");
    }
  });
});
