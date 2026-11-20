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
vi.mock("../../../lib/hires", () => ({
  listHires: async (filters: Record<string, unknown>) => {
    stub.order.push("fetch");
    stub.requests.push(filters);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));
vi.mock("./filter-bar", () => ({ HireFilterBar: () => null }));

const { default: HireRecordsPage, metadata } = await import("./page");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const WORKER = "33333333-3333-4333-8333-333333333333";
const POSTING = "44444444-4444-4444-8444-444444444444";

const row = (over: Record<string, unknown> = {}) => ({
  id: "55555555-5555-4555-8555-555555555555",
  tenant_payer_id: COMPANY,
  worker_id: WORKER,
  posting_kind: "company_posting",
  posting_id: POSTING,
  status: "reported",
  company_marked_at: null,
  company_answered_at: null,
  worker_answered_at: null,
  desk_confirmed_at: null,
  hired_on: null,
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
    await HireRecordsPage({ searchParams: Promise.resolve(searchParams) }),
  );

describe("the gate and the title", () => {
  it("requires manage_companies, before the read", async () => {
    await render();
    expect(stub.order).toEqual(["gate:manage_companies", "fetch"]);
    expect(metadata.title).toBe("Hire records");
  });
});

describe("the request", () => {
  it("forwards the status and cursor, and asks for one page", async () => {
    await render({ status: "confirmed", cursor: "Y3Vyc29y" });
    expect(stub.requests[0]).toEqual({
      status: "confirmed",
      cursor: "Y3Vyc29y",
      limit: 50,
    });
  });

  it("takes the first repeated value and trims it", async () => {
    await render({ status: ["confirmed", "rejected"], cursor: "  c1  " });
    expect(stub.requests[0]).toMatchObject({ status: "confirmed", cursor: "c1" });
  });
});

describe("a row", () => {
  it("renders the status by its label", async () => {
    stub.page = {
      items: [
        row({ id: "a", status: "confirmed" }),
        row({ id: "b", status: "reported" }),
        row({ id: "c", status: "rejected" }),
      ],
      nextCursor: null,
    };
    const out = await render();
    expect(out).toContain(">Confirmed<");
    expect(out).toContain(">Reported<");
    expect(out).toContain(">Rejected<");
    expect(out).toContain("3 records on this page.");
  });

  it("links the related pay-on-joining view from the header", async () => {
    stub.page = { items: [row()], nextCursor: null };
    expect(await render()).toContain('href="/pay-on-joining-hires"');
  });

  it("offers a confirmed-only filter without losing it on the next page", async () => {
    stub.page = { items: [row()], nextCursor: "next-cursor" };
    const out = await render({ status: "confirmed" });
    expect(out).toContain('href="/hires?status=confirmed&amp;cursor=next-cursor"');
  });
});

describe("the switch and the outage", () => {
  it("404 is 'not switched on yet', not an error", async () => {
    stub.failure = new stub.RequestError(404);
    const out = await render();
    expect(out).toContain("Hire records are not switched on yet");
    expect(out).not.toContain('<div class="grid"');
  });

  it("503 is unavailable, with Retry", async () => {
    stub.failure = new stub.RequestError(503);
    const out = await render();
    expect(out).toContain("Hire records are unavailable");
    expect(out).toContain('href="/hires"');
    expect(out).toContain("Retry");
  });
});
