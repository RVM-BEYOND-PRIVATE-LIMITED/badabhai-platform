import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The company record detail (A9, #2579): header facts, the six tabs, the hidden-posting mark,
 * the payment totals (exactly the API's), the credits ledger, the Users link into User accounts
 * filtered to the organisation, and the timeline.
 */
const stub = vi.hoisted(() => ({
  capabilities: ["read_entities", "read_identity", "read_events"] as string[],
  gates: [] as string[],
  company: null as unknown,
  history: null as unknown,
  credits: null as unknown,
  postings: null as unknown,
  timeline: null as unknown,
  calls: [] as string[],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/companies/6155050c-c91b-4c6e-96a7-8da023f1d2d2",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: () => false,
}));

vi.mock("../../../../lib/companies", () => ({
  getCompany: async (id: string) => {
    stub.calls.push(`company:${id}`);
    return stub.company;
  },
}));

vi.mock("../../../../lib/payment-history", () => ({
  getPaymentHistory: async () => {
    stub.calls.push("history");
    return stub.history;
  },
  describeHistorySimulated: (simulated: boolean) => (simulated ? "Simulated" : "Real"),
  formatHistoryAmount: (amount: number | null) =>
    amount === null ? "Not recorded" : `₹${amount.toLocaleString("en-IN")}`,
}));

vi.mock("../../../../lib/entities", () => ({
  getPayerCredits: async () => {
    stub.calls.push("credits");
    return stub.credits;
  },
  listCompanyJobPostings: async () => {
    stub.calls.push("postings");
    return stub.postings;
  },
  getJobPosting: async () => {
    throw new Error("not used in this render");
  },
}));

vi.mock("../../../../lib/events", () => ({
  getEntityTimeline: async () => {
    stub.calls.push("timeline");
    return stub.timeline;
  },
}));

const { CompanyDetailRoute } = await import("../../../../components/company-detail-route");

const ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";
const ORG = "0f0f0f0f-0000-4000-8000-000000000001";

const COMPANY = {
  id: ID,
  org_id: ORG,
  org_name: "Acme Fabrication Pvt Ltd",
  kind: "employer",
  status: "active",
  previous_status: null,
  verification_status: "verified",
  cities: ["Pune"],
  member_count: 1,
  members: [
    {
      member_id: "m-1",
      payer_id: "11111111-1111-4111-8111-111111111111",
      org_role: "recruiter",
      member_status: "active",
      payer_status: "active",
      last_login_at: "2026-10-01T09:00:00.000Z",
      invited_at: "2026-09-10T09:00:00.000Z",
      accepted_at: "2026-09-11T09:00:00.000Z",
    },
  ],
  last_login_at: "2026-10-02T09:00:00.000Z",
  created_at: "2026-09-01T09:00:00.000Z",
  has_profile: true,
  website: "https://acme.example",
  industry: "Fabrication",
  company_size: "11-50",
  hiring_locations: ["Pune", "Nashik"],
  agency_type: null,
  operating_cities: [],
  recruiter_count: null,
  profile_updated_at: "2026-09-02T09:00:00.000Z",
  contact: {
    gst_number: "27AAPFU0939F1ZV",
    address: "Plot 7, Chakan, Pune",
    phone: "+919876543210",
    email: "ops@acme.example",
    contact_person: "Asha Rao",
  },
};

const HISTORY = {
  payer_id: ID,
  member_payer_ids: [ID, "11111111-1111-4111-8111-111111111111"],
  items: [
    {
      id: "payment_order:o1",
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
  nextCursor: null,
  totals: { inr_spent: 2000, credits_bought: 50, credits_used: 7, balance: 99 },
  payments: { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL is not set" },
};

const CREDITS = {
  payer_id: ID,
  balance: 42,
  ledger: {
    items: [
      {
        id: "l-1",
        delta: 25,
        reason: "grant",
        unlock_id: null,
        pack_code: null,
        price_inr: null,
        created_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  },
};

const POSTINGS = [
  {
    id: "bc765f2b-902f-4cba-81c2-6abab75e4bf5",
    payer_id: ID,
    payer_role: "employer",
    org_label: "Acme Fabrication Pvt Ltd",
    role_title: "CNC Operator",
    location_label: "Chakan",
    city: "Pune",
    status: "open",
    verification_status: "verified",
    hidden: true,
    hidden_at: "2026-10-03T00:00:00.000Z",
    hidden_by: "admin-1",
    hidden_reason_code: "policy_violation",
    hidden_reason_text: "A misleading pay claim was reported by workers.",
    vacancy_band: "2-5",
    pay_min: 18000,
    pay_max: 25000,
    published_at: "2026-09-20T00:00:00.000Z",
    closed_at: null,
    created_at: "2026-09-18T09:00:00.000Z",
  },
];

const TIMELINE = {
  subject_type: "payer",
  subject_id: ID,
  events: [
    {
      id: "e-1",
      event_name: "payer.suspended",
      event_version: 1,
      actor_type: "admin",
      actor_id: "a-1",
      subject_type: "payer",
      subject_id: ID,
      occurred_at: "2026-10-01T09:00:00.000Z",
      correlation_id: "c-1",
      causation_id: null,
    },
  ],
  nextCursor: null,
};

beforeEach(() => {
  stub.capabilities = [
    "read_entities",
    "read_identity",
    "read_events",
    "manage_payer_credentials",
  ];
  stub.gates.length = 0;
  stub.calls.length = 0;
  stub.company = COMPANY;
  stub.history = HISTORY;
  stub.credits = CREDITS;
  stub.postings = POSTINGS;
  stub.timeline = TIMELINE;
});

const render = async (tab?: string) =>
  renderToStaticMarkup(
    await CompanyDetailRoute({
      id: ID,
      tab,
      ledgerCursor: undefined,
      paymentsCursor: undefined,
      eventsCursor: undefined,
    }),
  );

describe("the route", () => {
  it("gates on read_entities and reads the company + payment totals", async () => {
    await render();
    expect(stub.gates).toEqual(["read_entities"]);
    expect(stub.calls).toContain(`company:${ID}`);
    expect(stub.calls).toContain("history");
  });

  it("draws the header facts and the six tabs", async () => {
    const out = await render();
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out).toContain("Company");
    expect(out).toContain("Credit balance");
    expect(out).toContain(">99<");
    for (const tab of ["Overview", "Postings", "Payment history", "Credits ledger", "Users", "Timeline"]) {
      expect(out).toContain(tab);
    }
    expect(out).toContain('href="/companies/6155050c-c91b-4c6e-96a7-8da023f1d2d2?tab=payments"');
  });
});

describe("Overview", () => {
  it("shows the profile and contact fields the API disclosed", async () => {
    const out = await render("overview");
    for (const value of [
      "27AAPFU0939F1ZV",
      "Plot 7, Chakan, Pune",
      "Asha Rao",
      "+919876543210",
      "ops@acme.example",
      "https://acme.example",
      "Fabrication",
      "11-50",
      "Pune",
      "Nashik",
    ]) {
      expect(out).toContain(value);
    }
  });
});

describe("Postings", () => {
  it("reads the organisation's postings and marks a hidden row clearly", async () => {
    const out = await render("postings");
    expect(stub.calls).toContain("postings");
    expect(out).toContain("CNC Operator");
    expect(out).toContain("Hidden by BadaBhai");
    expect(out).toContain("A misleading pay claim was reported by workers.");
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain("posting-row--hidden");
  });
});

describe("Payment history", () => {
  it("renders the API's totals, IST date, whole rupees and the Simulated tag", async () => {
    const out = await render("payments");
    expect(out).toContain("₹2,000");
    expect(out).toContain("2 Oct 2026, 05:30 IST");
    expect(out).toContain("Simulated");
    expect(out).toContain("razorpay:order_1");
    expect(out).toContain("50");
    expect(out).toContain("99");
  });
});

describe("Credits ledger", () => {
  it("shows the balance and the movement", async () => {
    const out = await render("credits");
    expect(stub.calls).toContain("credits");
    expect(out).toContain("42");
    expect(out).toContain("Credit grant");
    expect(out).toContain("+25");
  });
});

describe("Users", () => {
  it("links into User accounts filtered to the organisation", async () => {
    const out = await render("users");
    expect(out).toContain(`href="/accounts?org_id=${ORG}"`);
    expect(out).toContain("Founder");
    expect(out).toContain("Recruiter");
  });
});

describe("Timeline", () => {
  it("renders the payer events", async () => {
    const out = await render("timeline");
    expect(stub.calls).toContain("timeline");
    expect(out).toContain("Customer · suspended");
  });

  it("degrades to a clean refusal without read_events", async () => {
    stub.capabilities = ["read_entities"];
    const out = await render("timeline");
    expect(out).toContain("Your role cannot read the event timeline");
    expect(stub.calls).not.toContain("timeline");
  });
});
