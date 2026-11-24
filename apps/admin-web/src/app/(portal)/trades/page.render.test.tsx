import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #3023 — the Trades page as the server renders it: the `read_entities` gate, the metadata title,
 * the catalogue in the server's order, the department/status filters, the two switches (disabled
 * for a session without `manage_postings`), the honest read failure, and the held list's three
 * states.
 */
const stub = vi.hoisted(() => ({
  gate: vi.fn(),
  capabilities: [] as string[],
  rows: [] as Record<string, unknown>[],
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
    if (stub.listError) throw stub.listError;
    return stub.rows;
  },
  getHeldCampusRoles: async () => {
    if (stub.heldError) throw stub.heldError;
    return stub.held;
  },
}));

const { default: TradesPage, metadata } = await import("./page");

const row = (over: Record<string, unknown> = {}) => ({
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  department: "production",
  department_label: "Production",
  kind: "shop_floor",
  wave: 1,
  posting_enabled: true,
  form_enabled: false,
  posting_changed_at: "2026-11-20T09:00:00.000Z",
  form_changed_at: null,
  updated_by: "a-1",
  updated_at: "2026-11-21T10:30:00.000Z",
  ...over,
});

const FIXTURE = [
  row(),
  row({
    role_kind: "arc_welder",
    role_label: "Arc Welder",
    department: "fabrication",
    department_label: "Fabrication",
    kind: "shop_floor",
    wave: 2,
    posting_enabled: false,
    form_enabled: true,
    posting_changed_at: null,
    form_changed_at: "2026-11-22T08:00:00.000Z",
  }),
  row({
    role_kind: "design_checker",
    role_label: "Design Checker",
    department: "design",
    department_label: "Design",
    kind: "desk",
    wave: null,
    posting_enabled: false,
    form_enabled: false,
    posting_changed_at: null,
    form_changed_at: null,
    updated_by: null,
    updated_at: null,
  }),
];

const render = async () =>
  renderToStaticMarkup(await TradesPage());

beforeEach(() => {
  stub.gate.mockReset();
  stub.capabilities = ["read_entities", "manage_postings"];
  stub.rows = FIXTURE;
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
  it("renders every column from the server rows, in server order", async () => {
    const out = await render();
    for (const heading of [
      "Code",
      "Name",
      "Department",
      "Kind",
      "Wave",
      "Posting on",
      "Form hand-over on",
      "Last changed by",
      "When",
    ]) {
      expect(out).toContain(`>${heading}<`);
    }
    expect(out).toContain("cnc_turner");
    expect(out).toContain("CNC Turner");
    expect(out).toContain("Production");
    expect(out).toContain("Shop floor");
    expect(out).toContain("Arc Welder");
    expect(out).toContain("Fabrication");
    expect(out).toContain("Design Checker");
    expect(out).toContain("Desk");
    expect(out).toContain("2026-11-20");
    expect(out).toContain("2026-11-21");
    // Server order is preserved: no local A–Z sort.
    expect(out.indexOf("CNC Turner")).toBeLessThan(out.indexOf("Arc Welder"));
    expect(out.indexOf("Arc Welder")).toBeLessThan(out.indexOf("Design Checker"));
  });

  it("offers the server's department labels and every status filter", async () => {
    const out = await render();
    expect(out).toContain("All departments");
    expect(out).toContain(">Production</option>");
    expect(out).toContain(">Fabrication</option>");
    expect(out).toContain(">Design</option>");
    expect(out).toContain("All trades");
    expect(out).toContain("Posting on");
    expect(out).toContain("Posting off");
    expect(out).toContain("Form hand-over on");
    expect(out).toContain("Form hand-over off");
  });

  it("disables both switches for a reader without manage_postings", async () => {
    stub.capabilities = ["read_entities"];
    const out = await render();
    expect(out).toContain("Your role can read the catalogue but not change it.");
    expect((out.match(/role="switch"[^>]*disabled=""/g) ?? []).length).toBe(6);
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
