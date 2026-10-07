import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as EntitiesModule from "../../../lib/entities";

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

// The real module with its read stubbed: the page also reads the directory's own status values
// (`adminRowSchema`) to tell a refused filter from an outage.
vi.mock("../../../lib/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof EntitiesModule>()),
  listAdmins: async () => {
    if (stub.failure) throw stub.failure;
    return stub.directory;
  },
}));

// Client Components (useState / useTransition), stubbed so the page renders in this harness.
vi.mock("./invite-admin-form", () => ({ InviteAdminForm: () => null }));
vi.mock("./admin-row-actions", () => ({ AdminRowActions: () => null }));

const { default: AdminsPage } = await import("./page");
const { AdminRequestError } = await import("../../../lib/admin-http");

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
  it("renders the name column first, and keeps the id behind it", async () => {
    const out = await render();
    expect(out).toContain('<th scope="col">Name</th>');
    expect(out).toContain("Divyanshu Sharma");
    expect(out).toContain(`<span class="mono" title="${ADMIN_ID}">aaaaaaaa…</span>`);
  });

  it("does not link a row's id to EVERY admin's events (owner brief 2026-10-01)", async () => {
    // Every row linked to the same /events?subjectType=admin_session: a label naming THIS admin
    // over a target holding everyone's sessions. There is no per-admin timeline to link instead.
    stub.directory = { admins: [NAMED, UNNAMED], active_super_admins: 2 };
    const out = await render();
    expect(out).not.toContain('href="/events?subjectType=admin_session"');
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
    // One sentence now (owner ruling 2026-10-01), so the clause is lower-case mid-sentence.
    expect(out).toContain("names are shown to your role and every read of one is audited");
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

  it("the description does not say names are shown directly above the notice withholding them", async () => {
    // Final re-sweep NEW-06: the description was two-valued, so the capped posture fell into the
    // "names are shown to your role" branch right above "Names are withheld on this page". Three
    // values now, as on Workers, Companies and Agencies.
    const out = await render();
    const description = out.slice(out.indexOf('class="page__sub"'), out.indexOf("Names are withheld"));
    expect(description).not.toContain("names are shown");
    expect(description).toContain("by id while names are withheld (see below)");
    expect(description).toContain("emails stay encrypted and are served to no role at all");
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

describe("the header (owner ruling 2026-10-01)", () => {
  it("puts the page's own action first: Invite an admin, to the form at the foot", async () => {
    stub.capabilities = ["manage_admins", "read_events"];
    const out = await render();
    const actions = out.slice(out.indexOf('<div class="page__actions">'));
    expect(actions).toContain('href="#ad-invite"');
    expect(actions.indexOf("Invite an admin")).toBeLessThan(
      actions.indexOf("View all admin actions"),
    );
  });

  it("offers the admin-actions log only to a session that may open /events", async () => {
    stub.capabilities = ["manage_admins", "read_events"];
    expect(await render()).toContain('href="/events?eventName=admin.action_performed"');
    stub.capabilities = ["manage_admins"];
    const without = await render();
    expect(without).not.toContain("/events?");
    expect(without).toContain("Invite an admin");
  });

  it("names role chips and pills from ROLE_LABELS, never the raw key", async () => {
    const out = await render();
    expect(out).toContain(">Super admin<");
    expect(out).toContain(">Ops admin<");
    expect(out).not.toContain(">super admin<");
    expect(out).not.toContain(">ops admin<");
  });
});

describe("the role chips keep a status narrowing (owner brief 2026-10-01)", () => {
  it("a chip carries ?status= — it used to drop it", async () => {
    const out = await render({ role: "analyst", status: "active" });
    expect(out).toContain('href="/admins?role=ops_admin&amp;status=active"');
    expect(out).toContain('href="/admins?role=super_admin&amp;status=active"');
  });

  it("marks the active role chip, and only it — as text, not a link to this page (final re-sweep O-2)", async () => {
    const out = await render({ role: "analyst" });
    expect(out).toMatch(/<span aria-current="true" class="btn btn--sm btn--selected">Analyst<\/span>/);
    expect((out.match(/aria-current="true"/g) ?? []).length).toBe(1);
    expect(out).not.toContain('href="/admins?role=analyst"');
  });
});

/** The href of the link whose visible label (after any glyph) is exactly `label`. */
const hrefOf = (out: string, label: string) =>
  [...out.matchAll(/href="([^"]*)">(?:<i [^>]*><\/i>)?([^<]*)<\/a>/g)].find((m) => m[2] === label)?.[1];

/**
 * A failed directory read, by the console's one rule (final re-sweep O-3). The directory is
 * unpaginated, so there is no cursor to refuse: a 400 with a role or status in the address
 * refused those, and a 400 with nothing — or anything else — is an outage with Retry.
 */
describe("a failed directory read: refused or unavailable (final re-sweep O-3)", () => {
  const count = (out: string, s: string) => out.split(s).length - 1;

  it("a 400 with a filter set: the filters were refused — Clear filters in the state, no Retry", async () => {
    stub.failure = new AdminRequestError(400, "Invalid enum value");
    const out = await render({ status: "bogus" });
    expect(out).toContain("The server rejected these filters");
    expect(out).not.toContain("The admin directory could not be loaded");
    expect(out).not.toContain(">Retry<");
    expect(count(out, ">Clear filters<")).toBe(1);
    const state = out.slice(out.indexOf('class="state state--error"'));
    expect(state).toContain(">Clear filters<");
    expect(hrefOf(out, "Clear filters")).toBe("/admins");
  });

  it("a 400 with nothing in the address is an outage — Retry", async () => {
    stub.failure = new AdminRequestError(400, "Invalid filter value.");
    const out = await render();
    expect(out).toContain("The admin directory could not be loaded");
    expect(out).not.toContain("rejected");
    expect(hrefOf(out, "Retry")).toBe("/admins");
  });

  it("a 5xx with filters is an outage: Retry keeps them, and the head keeps Clear filters", async () => {
    stub.failure = new AdminRequestError(500, "boom");
    const out = await render({ role: "analyst" });
    expect(out).toContain("The admin directory could not be loaded");
    expect(hrefOf(out, "Retry")).toBe("/admins?role=analyst");
    expect(count(out, ">Clear filters<")).toBe(1);
  });
});

/**
 * A role the chips offer, or a status the directory has, is never the refused part (review of
 * #2095). The directory has no cursor, so with only known values in the address a 400 is ours.
 */
describe("known role and status values are never the refused part", () => {
  it("a chip's role and a real status: the 400 is an outage, with Retry", async () => {
    stub.failure = new AdminRequestError(400, "Invalid filter value.");
    const out = await render({ role: "analyst", status: "active" });
    expect(out).toContain("The admin directory could not be loaded");
    expect(out).not.toContain("rejected");
    expect(hrefOf(out, "Retry")).toBe("/admins?role=analyst&amp;status=active");
  });

  it("a role the chips do not offer is still the refused part", async () => {
    stub.failure = new AdminRequestError(400, "Invalid enum value");
    expect(await render({ role: "root" })).toContain("The server rejected these filters");
  });
});
