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
  listOutOfCredits: async () => {
    if (h.page instanceof Error) throw h.page;
    return h.page;
  },
}));

const { default: OutOfCreditsPage } = await import("./page");

const PAYER = "8a110000-0001-4a00-8000-000000000001";

function page() {
  return {
    rows: [
      {
        payer_id: PAYER,
        ran_out_at: "2026-11-01T00:00:00.000Z",
        last_purchase: { at: "2026-10-01T00:00:00.000Z", pack_code: "pack_10" },
        last_open_at: null,
        last_call: {
          called_at: "2026-11-02T00:00:00.000Z",
          result: "reached_not_now",
          admin_id: "a-1",
        },
      },
      {
        payer_id: "8a110000-0001-4a00-8000-000000000002",
        ran_out_at: "2026-11-03T00:00:00.000Z",
        last_purchase: null,
        last_open_at: "2026-11-01T00:00:00.000Z",
        last_call: null,
        org_name: "Acme Works",
      },
    ],
    next_cursor: "next-page",
    accounts_link_hint: true,
  };
}

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await OutOfCreditsPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  h.gate.length = 0;
  h.page = page();
});

describe("the out-of-credits call list", () => {
  it("gates on read_business_numbers", async () => {
    await render();
    expect(h.gate).toEqual(["read_business_numbers"]);
  });

  it("shows a name when disclosed and the id when it is absent", async () => {
    const out = await render();
    expect(out).toContain("Acme Works");
    expect(out).toContain("8a11…0001");
  });

  it("offers a Phone link to User accounts, never the phone itself", async () => {
    const out = await render();
    expect(out).toContain(`/accounts?org_id=${PAYER}`);
    expect(out).toContain(">Phone<");
  });

  it("offers all five log-call results and shows the latest call", async () => {
    const out = await render();
    for (const label of [
      "Reached — will buy",
      "Reached — not now",
      "Reached — declined",
      "No answer",
      "Wrong number",
    ]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("Reached — not now");
    expect(out).toContain("10-credit pack");
  });

  it("pages with a keyset cursor", async () => {
    const out = await render();
    expect(out).toContain('href="/numbers/out-of-credits?cursor=next-page"');
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
