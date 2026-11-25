import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #3023 / #3067 — the Trades page as the server renders it: the `read_entities` gate, the
 * metadata title, the catalogue in the order the lib returns, the department/status filters, the
 * two switches (only for a session holding `manage_trade_release`, which the API needs for the
 * read too), the catalogue-only view for everyone else, the honest read failure, and the held
 * list's three states.
 */
const stub = vi.hoisted(() => ({
  gate: vi.fn(),
  capabilities: [] as string[],
  rows: [] as Record<string, unknown>[],
  catalogue: [] as Record<string, unknown>[],
  releaseReads: 0,
  held: [] as { role_label: string; count: number }[],
  listError: null as Error | null,
  heldError: null as Error | null,
}));

class FakeRequestError extends Error {
  status: number;
  constructor(status: number) {
    super(`status ${status}`);
    this.status = status;
  }
}

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gate(capability);
    return {
      adminId: "a-1",
      role: "ops_admin",
      capabilities: stub.capabilities,
    };
  },
}));
vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../../../lib/trade-release", () => ({
  getTradeRelease: async () => {
    stub.releaseReads += 1;
    if (stub.listError) throw stub.listError;
    return stub.rows;
  },
  getTradeCatalogue: () => stub.catalogue,
  getHeldCampusRoles: async () => {
    if (stub.heldError) throw stub.heldError;
    return stub.held;
  },
}));

const { default: TradesPage, metadata } = await import("./page");

const release = (over: Record<string, unknown> = {}) => ({
  role_kind: "cnc_turner",
  posting_enabled: true,
  form_enabled: false,
  updated_by: "a-1",
  updated_at: "2026-11-21T10:30:00.000Z",
  ...over,
});

const row = (over: Record<string, unknown> = {}, rel: Record<string, unknown> | null = {}) => {
  const base = {
    role_kind: "cnc_turner",
    role_label: "CNC Turner",
    department: "Machining",
    kind: "shop_floor",
    wave: 0,
    ...over,
  };
  return { ...base, release: rel === null ? null : release({ role_kind: base.role_kind, ...rel }) };
};

const FIXTURE = [
  row(),
  row(
    {
      role_kind: "welder",
      role_label: "Welder",
      department: "Sheet Metal & Fabrication",
      wave: 0,
    },
    { posting_enabled: false, form_enabled: true, updated_at: "2026-11-22T08:00:00.000Z" },
  ),
  row(
    {
      role_kind: "foundry_forging_operator",
      role_label: "Foundry / Forging Operator",
      department: "Not in the catalogue",
      kind: null,
      wave: null,
    },
    { posting_enabled: false, form_enabled: false, updated_by: null, updated_at: null },
  ),
];

const CATALOGUE = FIXTURE.map((r) => ({ ...r, release: null }));

const render = async () =>
  renderToStaticMarkup(await TradesPage());

beforeEach(() => {
  stub.gate.mockReset();
  stub.capabilities = ["read_entities", "manage_trade_release"];
  stub.rows = FIXTURE;
  stub.catalogue = CATALOGUE;
  stub.releaseReads = 0;
  stub.held = [
    { role_label: "CNC Operator", count: 4 },
    { role_label: "Lathe Setter", count: 2 },
  ];
  stub.listError = null;
  stub.heldError = null;
});

describe("the gate and the title", () => {
  it("requires read_entities and names the tab Trades", async () => {
    await render();
    expect(stub.gate).toHaveBeenCalledWith("read_entities");
    expect(metadata.title).toBe("Trades");
  });
});

describe("the catalogue", () => {
  it("renders every column from the rows, in the order given", async () => {
    const out = await render();
    for (const heading of ["Code", "Name", "Department", "Kind", "Wave", "Last changed by", "When"]) {
      expect(out).toContain(`>${heading}</th>`);
    }
    expect(out).toContain("cnc_turner");
    expect(out).toContain("CNC Turner");
    expect(out).toContain("Machining");
    expect(out).toContain("Shop floor");
    expect(out).toContain("Welder");
    expect(out).toContain("Sheet Metal &amp; Fabrication");
    expect(out).toContain("Foundry / Forging Operator");
    expect(out).toContain("Not in the catalogue");
    expect(out).toContain("2026-11-21");
    expect(out).toContain("2026-11-22");
    // The given order is kept: no local A–Z sort.
    expect(out.indexOf("CNC Turner")).toBeLessThan(out.indexOf("Welder"));
    expect(out.indexOf("Welder")).toBeLessThan(out.indexOf("Foundry / Forging Operator"));
  });

  it("offers the catalogue's departments and every status filter", async () => {
    const out = await render();
    expect(out).toContain("All departments");
    expect(out).toContain(">Machining</option>");
    expect(out).toContain(">Sheet Metal &amp; Fabrication</option>");
    expect(out).toContain(">Not in the catalogue</option>");
    expect(out).toContain("All trades");
    expect(out).toContain(">Posting on</option>");
    expect(out).toContain(">Posting off</option>");
    expect(out).toContain(">Form hand-over on</option>");
    expect(out).toContain(">Form hand-over off</option>");
  });

  it("draws both switches per row, live, for a session holding manage_trade_release", async () => {
    const out = await render();
    expect(stub.releaseReads).toBe(1);
    expect((out.match(/role="switch"/g) ?? []).length).toBe(6);
    expect(out).not.toMatch(/role="switch"[^>]*disabled=""/);
    expect(out).toContain("Changing a switch asks for confirmation first.");
  });

  it("shows the catalogue read-only, with no switch read, without manage_trade_release", async () => {
    stub.capabilities = ["read_entities", "manage_postings"];
    const out = await render();
    expect(stub.releaseReads).toBe(0);
    expect(out).toContain("Only a super admin can see and change the release switches.");
    expect(out).toContain("CNC Turner");
    expect(out).toContain("Foundry / Forging Operator");
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain(">Last changed by</th>");
    expect(out).not.toContain(">Posting off</option>");
  });

  it("says an empty catalogue is empty, not a broken table", async () => {
    stub.rows = [];
    const out = await render();
    expect(out).toContain("No trades declared yet");
  });
});

describe("an honest read failure", () => {
  it("renders the error state with Retry, not a blank table", async () => {
    stub.listError = new FakeRequestError(500);
    const out = await render();
    expect(out).toContain("Trades are unavailable");
    expect(out).toContain("fault on our side");
    expect(out).toContain('href="/trades"');
    expect(out).toContain("Retry");
    expect(out).not.toContain("No trades declared yet");
  });
});

describe("the held Campus roles", () => {
  it("renders names and counts with a copy action", async () => {
    const out = await render();
    expect(out).toContain("Held Campus roles");
    expect(out).toContain("CNC Operator · 4");
    expect(out).toContain("Lathe Setter · 2");
    expect(out).toContain("Copy list");
  });

  it("says Not switched on yet for a 404 rather than an error", async () => {
    stub.heldError = new FakeRequestError(404);
    const out = await render();
    expect(out).toContain("Held Campus roles");
    expect(out).toContain("Not switched on yet");
    expect(out).not.toContain("The held list could not be read");
  });

  it("shows an honest error for any other held-read failure", async () => {
    stub.heldError = new FakeRequestError(503);
    const out = await render();
    expect(out).toContain("The held list could not be read");
  });

  it("says No held roles when the list is empty", async () => {
    stub.held = [];
    const out = await render();
    expect(out).toContain("No held roles");
    expect(out).not.toContain("Copy list");
  });
});
