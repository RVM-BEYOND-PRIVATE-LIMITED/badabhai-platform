import { describe, expect, it } from "vitest";
import {
  companiesPageSchema,
  companyDetailSchema,
  describeCompanyStatus,
  formatCompanyAmount,
} from "./companies";

describe("companies contract (#2564 B10)", () => {
  it("parses a full companies page through the REAL schema", () => {
    const payload = {
      items: [
        {
          org_id: "11111111-1111-4111-8111-111111111111",
          anchor_payer_id: "66666666-6666-4666-8666-666666666666",
          kind: "employer",
          status: "active",
          verification: "pending",
          org_name: "Sharma Trading",
          balance: 99,
          open_postings: 2,
          total_postings: 3,
          last_payment_at: "2026-10-02T00:00:00.000Z",
          member_count: 2,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      page_size: 50,
    };
    expect(() => companiesPageSchema.parse(payload)).not.toThrow();
  });

  it("parses a company detail with its profile through the REAL schema", () => {
    const payload = {
      org_id: "11111111-1111-4111-8111-111111111111",
      anchor_payer_id: "66666666-6666-4666-8666-666666666666",
      kind: "employer",
      status: "archived",
      verification: "verified",
      org_name: null,
      balance: 0,
      open_postings: 0,
      total_postings: 1,
      last_payment_at: null,
      member_count: 1,
      created_at: "2026-09-01T00:00:00.000Z",
      email: null,
      phone: "+919800000001",
      profile: {
        gst: null,
        address: null,
        city: "Pune",
        contact_name: "Ramesh Sharma",
        website: null,
        industry: "Fabrication",
        company_size: null,
        hiring_locations: ["Pune"],
        agency_type: null,
        service_locations: [],
        operating_cities: [],
        recruiter_count: null,
        source_channels: [],
        verification_status: "verified",
      },
    };
    expect(() => companyDetailSchema.parse(payload)).not.toThrow();
  });

  it("rejects a row that drops the identity-gated name to a non-nullable slot", () => {
    const row = {
      org_id: "p",
      anchor_payer_id: "p",
      kind: "employer",
      status: "active",
      verification: "pending",
      balance: 0,
      open_postings: 0,
      total_postings: 0,
      last_payment_at: null,
      member_count: 1,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    // org_name absent = faceless page for an analyst — parses, never an error.
    expect(() => companiesPageSchema.parse({ items: [row], total: 1, page: 1, page_size: 50 })).not.toThrow();
  });
});

describe("companies copy helpers", () => {
  it("null last-payment is 'Not recorded', never ₹0", () => {
    expect(formatCompanyAmount(null)).toBe("Not recorded");
    expect(formatCompanyAmount(0)).not.toBe("Not recorded");
    expect(formatCompanyAmount(2000)).toContain("2,000");
  });

  it("archived reads Archived, never Suspended", () => {
    expect(describeCompanyStatus("archived")).toBe("Archived");
    expect(describeCompanyStatus("suspended")).toBe("Suspended");
    expect(describeCompanyStatus("pending")).toBe("Pending");
    expect(describeCompanyStatus("active")).toBe("Active");
  });
});
