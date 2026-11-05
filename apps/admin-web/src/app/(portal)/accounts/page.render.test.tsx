import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { columnHeaders } from "../../../../test/grid-markup";

/**
 * The User accounts screen (#2578): the columns it promises, the two hidden-identity states,
 * the keyset pager, and the empty/refused states.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    capabilities: ["manage_payer_credentials", "read_events", "read_identity"] as string[],
    page: null as { items: unknown[]; nextCursor: string | null } | null,
    failure: null as unknown,
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "super_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../lib/accounts", () => ({
  listAccounts: async () => {
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

// Client Components (hooks) — stubbed so the server page renders in this harness.
vi.mock("./accounts-filter-bar", () => ({ AccountsFilterBar: () => null }));
vi.mock("./create-login-dialog", () => ({
  CreateLoginDialog: () => <button className="btn btn--primary">Create a login</button>,
}));
vi.mock("./account-row-actions", () => ({ AccountRowActions: () => null }));

const { default: AccountsPage } = await import("./page");

const PAYER_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const ROW = {
  id: PAYER_ID,
  login_id: "owner@acme.test",
  type: "company_owner",
  organisation: "Acme Works",
  org_id: ORG_ID,
  role: "employer",
  status: "active",
  last_login_at: "2026-11-01T09:00:00.000Z",
  password_state: "set",
  password_set_at: "2026-10-01T09:00:00.000Z",
  locked: false,
};

beforeEach(() => {
  stub.capabilities = ["manage_payer_credentials", "read_events", "read_identity"];
  stub.page = { items: [ROW], nextCursor: null };
  stub.failure = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve(searchParams) }));

describe("the list", () => {
  it("renders the promised columns and the row's values", async () => {
    const out = await render();
    expect(columnHeaders(out)).toEqual([
      "Login ID",
      "Type",
      "Organisation",
      "Status",
      "Last sign-in",
      "Password",
      "Actions",
    ]);
    expect(out).toContain("owner@acme.test");
    expect(out).toContain("Company owner");
    expect(out).toContain("Acme Works");
    expect(out).toContain("Active");
    // A server-supplied next cursor gives the keyset "Next page" link.
  });

  it("says Hidden for your role when a name-bearing field was withheld, and a dash when absent", async () => {
    stub.page = {
      items: [
        { ...ROW, login_id: undefined, organisation: undefined },
        { ...ROW, id: "5", login_id: null, organisation: null },
      ],
      nextCursor: null,
    };
    const out = await render();
    expect(out).toContain("Hidden for your role");
    expect(out).toContain("—");
  });

  it("offers the keyset pager when there is a next page", async () => {
    stub.page = { items: [ROW], nextCursor: "cursor-2" };
    const out = await render();
    expect(out).toContain("Next page");
    expect(out).toContain("cursor-2");
  });
});

describe("states", () => {
  it("shows the unfiltered empty state", async () => {
    stub.page = { items: [], nextCursor: null };
    const out = await render();
    expect(out).toContain("No customer logins yet");
  });

  it("shows the filtered empty state and keeps Clear filters", async () => {
    stub.page = { items: [], nextCursor: null };
    const out = await render({ status: "active" });
    expect(out).toContain("No logins match these filters");
    expect(out).toContain("Clear filters");
  });

  it("tells a refused filter apart from an outage", async () => {
    stub.failure = new stub.RequestError(400);
    const refused = await render({ role: "not-a-role" });
    expect(refused).toContain("The server rejected these filters");
    expect(refused).not.toContain("Retry");
  });

  it("offers Retry on an outage", async () => {
    stub.failure = new stub.RequestError(500);
    const out = await render();
    expect(out).toContain("User accounts are unavailable");
    expect(out).toContain("Retry");
  });
});
