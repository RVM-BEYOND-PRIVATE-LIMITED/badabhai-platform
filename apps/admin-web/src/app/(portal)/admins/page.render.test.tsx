import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The admin directory under the name ruling — the surface where the dash is the ORDINARY case.
 *
 * The invite flow does not collect a name, so a directory of freshly invited accounts is a
 * column of dashes even for a fully entitled super_admin. That makes it the screen where
 * conflating "not disclosed to you" with "no name recorded" would be least visible and most
 * misleading, which is why the column is hidden outright in the other two postures rather than
 * dashed.
 *
 * It is also the one route with a SECOND way to be capped: it is deliberately unpaginated, so
 * above the server's 50-name response bound it serves every row faceless rather than naming the
 * first fifty. The banner names both causes instead of asserting the wrong one.
 */

const stub = vi.hoisted(() => ({
  capabilities: ["manage_admins", "read_identity"] as string[],
  directory: null as { admins: unknown[]; active_super_admins: number } | null,
  failure: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "aaaaaaaa-0000-4000-8000-000000000001",
    role: "super_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/entities", () => ({
  listAdmins: async () => {
    if (stub.failure) throw stub.failure;
    return stub.directory;
  },
}));

// Client Components (useState / useTransition), stubbed so the page renders in this harness.
vi.mock("./invite-admin-form", () => ({ InviteAdminForm: () => null }));
vi.mock("./admin-row-actions", () => ({ AdminRowActions: () => null }));

const { default: AdminsPage } = await import("./page");

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const FACELESS = {
  id: ADMIN_ID,
  role: "ops_admin",
  status: "active",
  mfa_enrolled: true,
  last_login_at: "2026-08-19T09:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  is_self: false,
};

const NAMED = { ...FACELESS, name: "Divyanshu Sharma" };
/** Invited and never named — the common row on this screen, not an edge case. */
const UNNAMED = { ...FACELESS, id: "aaaaaaaa-0000-4000-8000-000000000002", name: null };

beforeEach(() => {
  stub.capabilities = ["manage_admins", "read_identity"];
  stub.directory = { admins: [NAMED], active_super_admins: 2 };
  stub.failure = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await AdminsPage({ searchParams: Promise.resolve(searchParams) }));

function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"));
  return body.slice(0, body.indexOf("</tr>")).split("<td").slice(1);
}

describe("a super_admin, who holds read_identity", () => {
  it("renders the name column first, and keeps the id link behind it", async () => {
    const out = await render();
    expect(out).toContain('<th scope="col">Name</th>');
    expect(out).toContain("Divyanshu Sharma");
    expect(out).toContain('href="/events?subjectType=admin_session"');
    expect(out).toContain("aaaaaaaa…");
  });

  it("dashes an account nobody has named — the invite flow never asks", async () => {
    stub.directory = { admins: [UNNAMED], active_super_admins: 2 };
    const out = await render();
    expect(out).toContain('title="No name on record for this account.">—</span>');
  });

  it("keeps header and row widths in step", async () => {
    stub.directory = { admins: [NAMED, UNNAMED], active_super_admins: 2 };
    const out = await render();
    const headers = (out.match(/<th scope="col">/g) ?? []).length;
    expect(headers).toBe(8);
    expect(firstRowCells(out)).toHaveLength(headers);
  });

  it("marks `you` EXACTLY once, on the name cell", async () => {
    // The marker moved to the name cell, which is now the row's primary label. Rendering it in
    // both places would read as two separate accounts belonging to the reader.
    stub.directory = { admins: [{ ...NAMED, is_self: true }], active_super_admins: 2 };
    const out = await render();
    expect((out.match(/>you</g) ?? []).length).toBe(1);
    expect(out).toContain('Divyanshu Sharma<span class="table__meta">you</span>');
  });

  it("says names are audited and emails still reach nobody", async () => {
    const out = await render();
    expect(out).toContain("Names are shown to your role");
    expect(out).toContain("emails stay encrypted and are served to no role at all");
  });

  it("still renders no email anywhere — that half of the ruling did not reverse", async () => {
    stub.directory = {
      admins: [{ ...NAMED, email: "divyanshu@example.com" }],
      active_super_admins: 2,
    };
    const out = await render();
    expect(out).not.toContain("divyanshu@example.com");
    expect(out).not.toContain("@example.com");
  });
});

describe("the capped posture on the one unpaginated route", () => {
  beforeEach(() => {
    stub.directory = { admins: [FACELESS], active_super_admins: 2 };
  });

  it("names BOTH causes rather than asserting the wrong one", async () => {
    // On the paged lists a cap can only be the hourly budget, because the page is clamped to the
    // server's 50-name bound. Here it can also be a directory that outgrew that bound, and
    // telling a super_admin their budget is spent when it is not sends them to wait it out.
    const out = await render();
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).toContain("more than the 50 accounts a single response may name");
  });

  it("hides the Name column rather than dashing it", async () => {
    const out = await render();
    expect(out).not.toContain('<th scope="col">Name</th>');
    expect(out).not.toContain("No name on record");
  });

  it("keeps `you` on the id cell when there is no name cell to carry it", async () => {
    stub.directory = { admins: [{ ...FACELESS, is_self: true }], active_super_admins: 2 };
    const out = await render();
    expect((out.match(/>you</g) ?? []).length).toBe(1);
  });

  it("leaves the SECURITY answers complete — that is what this screen is for", async () => {
    // The deliberate backend choice this banner explains: serve every row faceless rather than
    // truncate the audit list to fifty. If the rows were dropped, this screen would answer "who
    // holds access" with a subset and look complete doing it.
    stub.directory = {
      admins: [FACELESS, { ...FACELESS, id: "aaaaaaaa-0000-4000-8000-000000000003" }],
      active_super_admins: 2,
    };
    const out = await render();
    expect(out).toContain("2</span><span class=\"stat__label\">Admin accounts");
    expect((out.match(/<tr>/g) ?? []).length).toBe(3); // header + two rows
  });
});

describe("a directory read that failed", () => {
  it("posts no withheld banner over a list that does not exist", async () => {
    stub.failure = new Error("boom");
    const out = await render();
    expect(out).toContain("The admin directory could not be loaded");
    expect(out).not.toContain("Names are withheld on this page");
  });
});
