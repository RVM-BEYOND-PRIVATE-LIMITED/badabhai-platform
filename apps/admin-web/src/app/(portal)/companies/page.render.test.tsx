import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { columnHeaders } from "../../../../test/grid-markup";

/**
 * Companies (A9, #2579) — the numbered list on the #2574 grid.
 *
 * Pins the API call it makes (address words map to the stored roles, unknown kinds are not
 * forwarded, 100 is sent as the UI page size), the grid's columns, the name postures, the
 * archive/restore controls, and the distinct refusal / unavailable / name-index-off states.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    capabilities: ["read_entities", "read_identity"] as string[],
    page: null as unknown,
    metrics: new Map<string, unknown>(),
    failure: null as unknown,
    calls: [] as Array<Record<string, unknown>>,
    gates: [] as string[],
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/companies",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
  isAdminForbidden: () => false,
  isAdminUnauthorized: () => false,
}));

vi.mock("../../../lib/companies", () => ({
  listCompanies: async (filters: Record<string, unknown>) => {
    stub.calls.push(filters);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
  getCompanyMetricsFor: async () => stub.metrics,
}));

const { default: CompaniesPage } = await import("./page");

const ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

const ROW = {
  id: ID,
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

const METRICS = new Map([
  [
    ID,
    {
      openPostings: 2,
      totalPostings: 5,
      balance: 42,
      lastPaymentAt: "2026-10-02T00:00:00.000Z",
      lastPaymentInr: 2000,
      countsLoaded: true,
      paymentsLoaded: true,
    },
  ],
]);

const render = async (searchParams: Record<string, string | undefined> = {}) =>
  renderToStaticMarkup(await CompaniesPage({ searchParams: Promise.resolve(searchParams) }));

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_identity"];
  stub.page = PAGE;
  stub.metrics = METRICS;
  stub.failure = null;
  stub.calls.length = 0;
  stub.gates.length = 0;
});

describe("the gate", () => {
  it("is read_entities", async () => {
    await render();
    expect(stub.gates).toEqual(["read_entities"]);
  });
});

describe("the API call", () => {
  it("maps the address's kind words to the stored roles", async () => {
    await render({ kind: "company" });
    await render({ kind: "agency" });
    expect(stub.calls.map((c) => c.kind)).toEqual(["employer", "agent"]);
  });

  it("does not forward an unknown kind", async () => {
    await render({ kind: "reseller" });
    expect(stub.calls[0]!.kind).toBeUndefined();
  });

  it("forwards every filter, the page and the page size", async () => {
    await render({
      kind: "agency",
      status: "suspended",
      verification: "verified",
      name: "Acme",
      city: "Pune",
      gst: "27AAPFU0939F1ZV",
      sort: "oldest",
      page: "2",
      size: "50",
    });
    expect(stub.calls[0]).toMatchObject({
      kind: "agent",
      status: "suspended",
      verification: "verified",
      name: "Acme",
      city: "Pune",
      gst: "27AAPFU0939F1ZV",
      sort: "oldest",
      page: 2,
      pageSize: 50,
    });
  });

  it("passes 100 through as the UI page size (the data layer merges two API pages)", async () => {
    await render({ size: "100" });
    expect(stub.calls[0]!.pageSize).toBe(100);
  });
});

describe("the grid", () => {
  it("draws the A9 columns", async () => {
    const out = await render();
    expect(columnHeaders(out)).toEqual([
      "Name",
      "Kind",
      "Status",
      "Postings",
      "Credit balance",
      "Last payment",
      "Registered",
      "Actions",
    ]);
  });

  it("renders the API's metrics rather than zeros", async () => {
    const out = await render();
    expect(out).toContain("2 / 5");
    expect(out).toContain("42");
    expect(out).toContain("2 Oct 2026");
    expect(out).toContain("₹2,000");
  });

  it("renders an honest dash when a metrics read failed", async () => {
    stub.metrics = new Map([
      [
        ID,
        {
          openPostings: null,
          totalPostings: null,
          balance: null,
          lastPaymentAt: null,
          lastPaymentInr: null,
          countsLoaded: false,
          paymentsLoaded: false,
        },
      ],
    ]);
    const out = await render();
    expect(out).toContain("could not be loaded");
    expect(out).not.toContain("0 / 0");
  });

  it("uses numbered pages with the exact total", async () => {
    stub.page = { ...PAGE, total: 24_310, total_pages: 973 };
    const out = await render();
    expect(out).toContain("1–25 of 24,310");
    expect(out).toContain("pager--numbered");
  });

  it("a row opens the one customer detail route", async () => {
    const out = await render();
    expect(out).toContain(`href="/companies/${ID}"`);
  });

  it("names the kinds on the All view and draws both chips", async () => {
    const out = await render();
    expect(out).toContain("Company");
    expect(out).toContain('aria-label="Kind"');
    expect(out).toContain('href="/companies?kind=company"');
    expect(out).toContain('href="/companies?kind=agency"');
  });

  it("the Kind chips keep the other filters and drop the page number", async () => {
    const out = await render({ status: "active", name: "Acme", page: "3" });
    expect(out).toContain('href="/companies?kind=company&amp;status=active&amp;name=Acme"');
    expect(out).toContain('href="/companies?kind=agency&amp;status=active&amp;name=Acme"');
    expect(out).not.toContain("page=3");
  });

  it("offers Clear filters once when a filter is set, and not on the bare list", async () => {
    expect(await render()).not.toContain(">Clear filters<");
    const out = await render({ status: "active" });
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });
});

describe("the name postures", () => {
  it("shows the registered name when the read disclosed it", async () => {
    const out = await render();
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out).not.toContain("hourly name budget");
  });

  it("entitled but capped: ids instead, with the budget notice", async () => {
    const { org_name: _omit, ...faceless } = ROW;
    stub.page = { ...PAGE, items: [faceless] };
    const out = await render();
    expect(out).not.toContain("Acme Fabrication Pvt Ltd");
    expect(out).toContain("hourly name budget");
    expect(out).toContain("6155…d2d2");
  });

  it("faceless: ids and an honest description, no withheld notice", async () => {
    stub.capabilities = ["read_entities"];
    const { org_name: _omit, ...faceless } = ROW;
    stub.page = { ...PAGE, items: [faceless] };
    const out = await render();
    expect(out).toContain("your role does not include name access");
    expect(out).not.toContain("hourly name budget");
  });
});

describe("the writes", () => {
  it("Add company is offered only with manage_companies", async () => {
    expect(await render()).not.toContain("Add company");
    stub.capabilities = ["read_entities", "read_identity", "manage_companies"];
    expect(await render()).toContain("Add company");
  });

  it("Archive is offered on a live row with manage_companies; Restore on an archived one", async () => {
    stub.capabilities = ["read_entities", "read_identity", "manage_companies"];
    expect(await render()).toContain(">Archive<");
    stub.page = { ...PAGE, items: [{ ...ROW, status: "archived" }] };
    expect(await render()).toContain(">Restore<");
  });
});

describe("the failure states", () => {
  it("400 with a filter is the operator's refusal, with no Retry", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ status: "nonsense" });
    expect(out).toContain("The server rejected that filter");
    expect(out).not.toContain(">Retry<");
  });

  it("an outage is ours, with Retry, and never blames the filter", async () => {
    stub.failure = new TypeError("fetch failed");
    const out = await render();
    expect(out).toContain("Companies are unavailable");
    expect(out).toContain("Retry");
    expect(out).not.toContain("The server rejected");
  });

  it("a refused name search says the index is off and offers to clear the name", async () => {
    stub.failure = new stub.RequestError(503);
    const out = await render({ name: "Acme" });
    expect(out).toContain("Name search is unavailable");
    expect(out).toContain("Clear the name filter");
  });
});
