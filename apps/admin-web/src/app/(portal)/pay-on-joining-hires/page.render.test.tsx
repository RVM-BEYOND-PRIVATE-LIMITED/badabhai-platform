import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    status: number;
    constructor(status: number) {
      super(`the admin API returned ${status}`);
      this.status = status;
    }
  }
  return {
    RequestError,
    order: [] as string[],
    requests: [] as Array<Record<string, unknown>>,
    page: { items: [] as unknown[], nextCursor: null as string | null },
    failure: null as unknown,
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));
vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
  isAdminForbidden: () => false,
  isAdminUnauthorized: () => false,
}));
vi.mock("../../../lib/pay-on-joining", () => ({
  listPayOnJoiningHires: async (filters: Record<string, unknown>) => {
    stub.order.push("fetch");
    stub.requests.push(filters);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));
vi.mock("./filter-bar", () => ({ PayOnJoiningHiresFilterBar: () => null }));
vi.mock("./pay-on-joining-hire-form", () => ({ PayOnJoiningHireDialog: () => null }));

const { default: PayOnJoiningHiresPage, metadata } = await import("./page");

const FACTORY = "11111111-1111-4111-8111-111111111111";
const WORKER = "33333333-3333-4333-8333-333333333333";
const PARTNER = "22222222-2222-4222-8222-222222222222";
const HIRE = "55555555-5555-4555-8555-555555555555";

const row = (over: Record<string, unknown> = {}) => ({
  id: HIRE,
  factory_payer_id: FACTORY,
  job_posting_id: null,
  worker_id: WORKER,
  partner_payer_id: PARTNER,
  joined_on: "2026-11-01",
  stay_checked_on: null,
  stayed_30_days: null,
  fee_paise: 500000,
  partner_share_percent: 70,
  partner_share_paise: 350000,
  invoiced_on: null,
  factory_paid_on: null,
  partner_paid_on: null,
  note: null,
  payment_state: "awaiting_factory",
  created_by_admin_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  updated_by_admin_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created_at: "2026-11-01T09:00:00.000Z",
  updated_at: "2026-11-01T09:00:00.000Z",
  ...over,
});

beforeEach(() => {
  stub.order.length = 0;
  stub.requests.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.failure = null;
});

const render = async (searchParams: Record<string, string | string[]> = {}) =>
  renderToStaticMarkup(
    await PayOnJoiningHiresPage({ searchParams: Promise.resolve(searchParams) }),
  );

describe("the gate and the title", () => {
  it("requires manage_companies, before the read", async () => {
    await render();
    expect(stub.order).toEqual(["gate:manage_companies", "fetch"]);
    expect(metadata.title).toBe("Pay-on-joining hires");
  });
});

describe("the request", () => {
  it("forwards every filter and the cursor, and asks for one page", async () => {
    await render({
      factory_payer_id: FACTORY,
      partner_payer_id: PARTNER,
      paid: "partner_due",
      cursor: "Y3Vyc29y",
    });
    expect(stub.requests[0]).toEqual({
      factoryPayerId: FACTORY,
      partnerPayerId: PARTNER,
      paid: "partner_due",
      cursor: "Y3Vyc29y",
      limit: 50,
    });
  });
});

describe("a row", () => {
  it("renders the fee in rupees, the share and the payment state", async () => {
    stub.page = { items: [row()], nextCursor: null };
    const out = await render();
    expect(out).toContain("₹5,000");
    expect(out).toContain("₹3,500");
    expect(out).toContain("70%");
    expect(out).toContain(">Awaiting factory<");
    expect(out).toContain("1 record on this page.");
  });

  it("renders a settled record as settled", async () => {
    stub.page = {
      items: [row({ payment_state: "settled", factory_paid_on: "2026-11-03" })],
      nextCursor: null,
    };
    expect(await render()).toContain(">Settled<");
  });

  it("has the hire-records list as its back link", async () => {
    stub.page = { items: [row()], nextCursor: null };
    const out = await render();
    expect(out).toContain('href="/hires"');
  });
});

describe("the switch and the outage", () => {
  it("404 is 'not switched on yet', not an error", async () => {
    stub.failure = new stub.RequestError(404);
    const out = await render();
    expect(out).toContain("Pay-on-joining records are not switched on yet");
    expect(out).not.toContain('<div class="grid"');
  });

  it("503 is unavailable, with Retry", async () => {
    stub.failure = new stub.RequestError(503);
    const out = await render();
    expect(out).toContain("Pay-on-joining records are unavailable");
    expect(out).toContain('href="/pay-on-joining-hires"');
    expect(out).toContain("Retry");
  });
});
