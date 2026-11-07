import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  companyDetailSchema,
  companyListItemSchema,
  getCompanyMetrics,
  lastPaymentOf,
  listCompanies,
} from "./companies";
import { companyKindFilter, companyPage, companyPageSize } from "./company-vocabulary";

/**
 * The company-record data layer (A9, #2579).
 *
 * The two load-bearing behaviours here are: a 100-row UI page is transported as TWO 50-row API
 * pages (the API caps a named response at 50), and a failed metrics read is a dash — never a
 * zero that reads like data.
 */

const stub = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  getPayer: vi.fn(),
  getPaymentHistory: vi.fn(),
}));

vi.mock("./admin-http", () => ({ adminFetch: stub.adminFetch }));
vi.mock("./entities", () => ({ getPayer: stub.getPayer }));
vi.mock("./payment-history", () => ({ getPaymentHistory: stub.getPaymentHistory }));

const ROW = {
  id: "6155050c-c91b-4c6e-96a7-8da023f1d2d2",
  org_id: "0f0f0f0f-0000-4000-8000-000000000001",
  org_name: "Acme Fabrication Pvt Ltd",
  kind: "employer",
  status: "active",
  previous_status: null,
  verification_status: "pending",
  cities: ["Pune"],
  member_count: 0,
  members: [],
  last_login_at: null,
  created_at: "2026-09-01T09:00:00.000Z",
};

const PAGE = {
  items: [ROW],
  page: 1,
  page_size: 25,
  total: 1,
  total_pages: 1,
  name_search_available: true,
};

beforeEach(() => {
  stub.adminFetch.mockReset();
  stub.getPayer.mockReset();
  stub.getPaymentHistory.mockReset();
});

describe("the address vocabulary", () => {
  it("maps the console's kind words and ignores anything else", () => {
    expect(companyKindFilter("company")).toBe("company");
    expect(companyKindFilter("agency")).toBe("agency");
    for (const value of [undefined, "agent", "employer", "all"]) {
      expect(companyKindFilter(value)).toBeUndefined();
    }
  });

  it("reads the page size and page defensively", () => {
    expect(companyPageSize("25")).toBe(25);
    expect(companyPageSize("50")).toBe(50);
    expect(companyPageSize("100")).toBe(100);
    expect(companyPageSize("200")).toBe(25);
    expect(companyPageSize(undefined)).toBe(25);
    expect(companyPage("3")).toBe(3);
    expect(companyPage("0")).toBe(1);
    expect(companyPage("nonsense")).toBe(1);
  });
});

describe("the wire shapes", () => {
  it("parses a company row and detail through the real schemas", () => {
    expect(() => companyListItemSchema.parse(ROW)).not.toThrow();
    expect(() =>
      companyDetailSchema.parse({
        ...ROW,
        has_profile: true,
        website: "https://acme.example",
        industry: "Fabrication",
        company_size: "11-50",
        hiring_locations: ["Pune"],
        agency_type: null,
        operating_cities: [],
        recruiter_count: null,
        profile_updated_at: "2026-09-02T00:00:00.000Z",
        contact: {
          gst_number: "27AAPFU0939F1ZV",
          address: "Pune",
          phone: "+919876543210",
          email: "ops@acme.example",
          contact_person: "Asha",
        },
      }),
    ).not.toThrow();
  });

  it("keeps an absent name distinct from a null one", () => {
    const { org_name: _omit, ...absent } = ROW;
    expect(companyListItemSchema.parse(absent)).not.toHaveProperty("org_name");
    expect(companyListItemSchema.parse({ ...ROW, org_name: null }).org_name).toBeNull();
  });
});

describe("listCompanies", () => {
  it("asks for one API page at 25/50 and rewrites the total's page count", async () => {
    stub.adminFetch.mockResolvedValue({ ...PAGE, total: 80, total_pages: 4 });
    const page = await listCompanies({ page: 2, pageSize: 25, kind: "employer", status: "active" });
    expect(stub.adminFetch).toHaveBeenCalledTimes(1);
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("/admin/companies?");
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("page=2");
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("page_size=25");
    expect(page.total).toBe(80);
    expect(page.total_pages).toBe(4);
  });

  it("transports a 100-row page as two 50-row API pages, in order", async () => {
    const secondRow = { ...ROW, id: "b".repeat(36) };
    stub.adminFetch
      .mockResolvedValueOnce({ ...PAGE, page: 1, page_size: 50, total: 80, total_pages: 2 })
      .mockResolvedValueOnce({
        ...PAGE,
        items: [secondRow],
        page: 2,
        page_size: 50,
        total: 80,
        total_pages: 2,
      });
    const page = await listCompanies({ page: 1, pageSize: 100 });
    expect(stub.adminFetch).toHaveBeenCalledTimes(2);
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("page=1");
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("page_size=50");
    expect(stub.adminFetch.mock.calls[1]![0]).toContain("page=2");
    expect(stub.adminFetch.mock.calls[1]![0]).toContain("page_size=50");
    expect(page.items.map((row) => row.id)).toEqual([ROW.id, secondRow.id]);
    expect(page.page_size).toBe(100);
    expect(page.total_pages).toBe(1);
  });

  it("requests the second pair for UI page 2 at size 100", async () => {
    stub.adminFetch.mockResolvedValue(PAGE);
    await listCompanies({ page: 2, pageSize: 100 });
    expect(stub.adminFetch.mock.calls[0]![0]).toContain("page=3");
    expect(stub.adminFetch.mock.calls[1]![0]).toContain("page=4");
  });
});

describe("the list metrics", () => {
  it("uses the payer counts and the payment timeline's balance + last stamped payment", async () => {
    stub.getPayer.mockResolvedValue({ open_posting_count: 2, posting_count: 5, credit_balance: 40 });
    stub.getPaymentHistory.mockResolvedValue({
      items: [
        {
          id: "credit_spend:1",
          date: "2026-10-03T00:00:00.000Z",
          type: "credit_spend",
          item: "unlock",
          credits: -1,
          amount_inr: null,
          status: "spent",
          provider_reference: null,
          simulated: true,
        },
        {
          id: "payment_order:1",
          date: "2026-10-02T00:00:00.000Z",
          type: "payment_order",
          item: "pack_50",
          credits: 50,
          amount_inr: 2000,
          status: "paid",
          provider_reference: "razorpay:order_1",
          simulated: true,
        },
      ],
      totals: { inr_spent: 2000, credits_bought: 50, credits_used: 1, balance: 99 },
    });
    const metrics = await getCompanyMetrics(ROW.id);
    expect(metrics).toMatchObject({
      openPostings: 2,
      totalPostings: 5,
      balance: 99,
      lastPaymentAt: "2026-10-02T00:00:00.000Z",
      lastPaymentInr: 2000,
      countsLoaded: true,
      paymentsLoaded: true,
    });
  });

  it("a failed metrics read is null + a loaded=false flag, never zero", async () => {
    stub.getPayer.mockRejectedValue(new Error("down"));
    stub.getPaymentHistory.mockRejectedValue(new Error("down"));
    const metrics = await getCompanyMetrics(ROW.id);
    expect(metrics).toEqual({
      openPostings: null,
      totalPostings: null,
      balance: null,
      lastPaymentAt: null,
      lastPaymentInr: null,
      countsLoaded: false,
      paymentsLoaded: false,
    });
  });

  it("finds the newest money row and skips spends, grants and null prices", () => {
    const base = {
      id: "x",
      date: "2026-10-01T00:00:00.000Z",
      item: "x",
      credits: null,
      amount_inr: null,
      status: "x",
      provider_reference: null,
      simulated: true,
    };
    expect(
      lastPaymentOf([
        { ...base, id: "a", type: "credit_spend", amount_inr: 10 },
        { ...base, id: "b", type: "credit_grant", amount_inr: 0 },
        { ...base, id: "c", type: "posting_plan", amount_inr: 499 },
        { ...base, id: "d", type: "payment_order", amount_inr: 2000 },
      ])?.id,
    ).toBe("c");
    expect(lastPaymentOf([{ ...base, type: "payment_order", amount_inr: null }])).toBeNull();
  });
});
