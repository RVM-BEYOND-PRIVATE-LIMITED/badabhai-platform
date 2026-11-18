import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  class RequestError extends Error {
    status: number;
    constructor(status: number) {
      super("request failed");
      this.name = "AdminRequestError";
      this.status = status;
    }
  }
  return { RequestError, gate: [] as string[], page: null as unknown };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    h.gate.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));
vi.mock("../../../../lib/admin-http", () => ({
  adminFetch: vi.fn(),
  isAdminRequestError: (err: unknown) => err instanceof h.RequestError,
  isAdminUnauthorized: () => false,
}));
vi.mock("../../../../lib/numbers", () => ({
  listLaunchCohort: async () => {
    if (h.page instanceof Error) throw h.page;
    return h.page;
  },
}));

const { default: LaunchTestAPage } = await import("./page");

const FACTORY = "0d110000-0001-4a00-8000-000000000001";
const WORKER = "1e110000-0001-4a00-8000-000000000001";

function page() {
  return {
    rows: [
      {
        id: FACTORY,
        factory_name: "Acme Works",
        has_phone: true,
        city_group: "ncr",
        trade_group: "cnc_operator",
        payer_id: null,
        sent_by_admin_id: "a-1",
        sent_at: "2026-11-01T00:00:00.000Z",
        payment_link_ref: "plink_123",
        link_created_at: "2026-11-01T00:00:00.000Z",
        result: "paid",
        paid_at: "2026-11-02T00:00:00.000Z",
        payment_order_id: null,
        share_count: 1,
        worker_ids: [WORKER],
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
        updated_by_admin_id: "a-1",
      },
      {
        id: "0d110000-0001-4a00-8000-000000000002",
        has_phone: false,
        city_group: "pune",
        trade_group: "sheet_metal",
        payer_id: null,
        sent_by_admin_id: "a-1",
        sent_at: "2026-11-03T00:00:00.000Z",
        payment_link_ref: null,
        link_created_at: null,
        result: "pending",
        paid_at: null,
        payment_order_id: null,
        share_count: 1,
        worker_ids: [WORKER],
        created_at: "2026-11-03T00:00:00.000Z",
        updated_at: "2026-11-03T00:00:00.000Z",
        updated_by_admin_id: "a-1",
      },
    ],
    next_cursor: null,
  };
}

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await LaunchTestAPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  h.gate.length = 0;
  h.page = page();
});

describe("launch test A", () => {
  it("gates on read_business_numbers", async () => {
    await render();
    expect(h.gate).toEqual(["read_business_numbers"]);
  });

  it("shows the create form and the cohort table", async () => {
    const out = await render();
    expect(out).toContain("Add factory");
    expect(out).toContain("Factory name");
    expect(out).toContain("Worker ids sent");
    expect(out).toContain("Acme Works");
    expect(out).toContain("Phone on file");
    expect(out).toContain("No phone");
    expect(out).toContain("Paid");
    expect(out).toContain("plink_123");
    expect(out).toContain("Update");
  });

  it("shows the id when a name is absent, never a made-up name", async () => {
    const out = await render();
    expect(out).toContain("0d11…0002");
  });

  it("a switch-off 404 reads as Not switched on yet", async () => {
    h.page = new h.RequestError(404);
    const out = await render();
    expect(out).toContain("Not switched on yet");
  });

  it("a missing migration 503 reads as Try again later", async () => {
    h.page = new h.RequestError(503);
    const out = await render();
    expect(out).toContain("Try again later");
  });
});
