import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Workers roster actually RENDERS after the 2026-08-18 name ruling.
 *
 * ── WHY A RENDER TEST ───────────────────────────────────────────────────────────────────
 * The whole feature is a decision about MARKUP. `lib/identity.test.ts` proves the posture
 * function classifies correctly; nothing there would notice a page that computed `faceless` and
 * then rendered the Name column anyway, or one that rendered the header without the cells and
 * shunted every row one column to the left. Both are invisible to a schema test and obvious in
 * the emitted HTML.
 *
 * The three postures are three different screens, and each is asserted for what it SHOWS and for
 * what it must not: a capped page must not paint dashes (which mean "no name on record"), and an
 * analyst's page must not carry a Name heading at all.
 */

const stub = vi.hoisted(() => ({
  capabilities: ["read_entities", "read_identity"] as string[],
  page: null as { items: unknown[]; nextCursor: string | null } | null,
  failure: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/entities", () => ({
  listWorkers: async () => {
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

// `useRouter` needs an app-router context this renderer does not provide. The bar is not what
// this file is about; it is stubbed so the page under test can render at all.
vi.mock("./filter-bar", () => ({ WorkerFilterBar: () => null }));

const { default: WorkersPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

/** A faceless row: exactly what an analyst, or a capped read, gets back. */
const FACELESS = {
  id: WORKER_ID,
  status: "active",
  preferred_language: "hi",
  has_photo: false,
  resume_show_photo: true,
  resume_night_shift_ready: false,
  deletion_scheduled_at: null,
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
};

/** The same row, named. A real Indian worker name, because that is what this column holds. */
const NAMED = { ...FACELESS, full_name: "Ramesh Kumar" };

/** Disclosed, and nobody ever recorded a name — the row the dash belongs to. */
const UNNAMED = { ...FACELESS, id: "5eeded00-0002-4a00-8000-000000000002", full_name: null };

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_identity"];
  stub.page = { items: [NAMED], nextCursor: null };
  stub.failure = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await WorkersPage({ searchParams: Promise.resolve(searchParams) }));

/** The cells of the first body row, in order. */
function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"));
  const row = body.slice(0, body.indexOf("</tr>"));
  return row.split("<td").slice(1);
}

describe("an admin who holds read_identity", () => {
  it("renders the name, in its own column, before the id", async () => {
    const out = await render();
    expect(out).toContain("<th scope=\"col\">Name</th>");
    expect(out).toContain("Ramesh Kumar");
    // Order matters: the name is the label an operator scans, the id is the handle.
    expect(out.indexOf("Ramesh Kumar")).toBeLessThan(out.indexOf(WORKER_ID));
  });

  it("KEEPS the opaque id link — the name does not replace the join key", async () => {
    // The id is the `actor_id`/`subject_id` on the spine and the value an operator copies into
    // a query. A name is not unique enough to be either.
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(`title="${WORKER_ID}"`);
    expect(out).toContain("5eeded00…");
  });

  it("renders a NULL name as a dash that says what a dash means", async () => {
    stub.page = { items: [UNNAMED], nextCursor: null };
    const out = await render();
    expect(out).toContain('<span class="table__meta" title="No name on record for this account.">—</span>');
  });

  it("renders a BLANK name as the same dash, never as an empty cell", async () => {
    // The layout-collapse case. `full_name` is worker-entered, so "   " is a value the column
    // can really hold, and printing it verbatim leaves a row that looks broken.
    stub.page = { items: [{ ...FACELESS, full_name: "   " }], nextCursor: null };
    const out = await render();
    expect(out).toContain('title="No name on record for this account.">—</span>');
  });

  it("keeps every row the same width as the header", async () => {
    // The structural failure: a header rendered under one condition and its cell under another
    // shifts every subsequent value one column left, so Status reads as Language and nothing
    // about the page looks wrong.
    stub.page = { items: [NAMED, UNNAMED], nextCursor: null };
    const out = await render();
    const headers = (out.match(/<th scope="col">/g) ?? []).length;
    // 6 faceless columns + Name.
    expect(headers).toBe(7);
    expect(firstRowCells(out)).toHaveLength(headers);
  });

  it("says names are shown and audited, and posts NO withheld banner", async () => {
    const out = await render();
    expect(out).toContain("Names are shown to your role");
    expect(out).toContain("capped and audited");
    expect(out).not.toContain("Names are withheld on this page");
  });

  it("still offers no search box of any kind", async () => {
    // The ruling reversed "the roster is anonymous". It did not reverse "the roster is not a
    // lookup tool" — a field that turns a name into a row is what makes this bulk queryable by
    // identity. (The filter bar is stubbed out; this asserts the PAGE adds none of its own.)
    const out = await render();
    expect(out).not.toContain("<input");
    expect(out).not.toContain('role="search"');
  });
});

describe("an analyst, who will never hold read_identity", () => {
  beforeEach(() => {
    stub.capabilities = ["read_entities"];
    stub.page = { items: [FACELESS], nextCursor: null };
  });

  it("gets NO Name column — not a column of dashes", async () => {
    // The requirement in one assertion: never render a heading promising data this operator
    // cannot be shown. A dash under it would also be a lie, since a dash means "no name on
    // record" everywhere else on this console.
    const out = await render();
    expect(out).not.toContain("<th scope=\"col\">Name</th>");
    expect(out).not.toContain("No name on record");
  });

  it("gets the pre-ruling roster, intact", async () => {
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect((out.match(/<th scope="col">/g) ?? []).length).toBe(6);
    expect(firstRowCells(out)).toHaveLength(6);
  });

  it("is told plainly that this is a property of their ROLE, not of these workers", async () => {
    const out = await render();
    expect(out).toContain("your role does not include name access");
    expect(out).not.toContain("Names are shown to your role");
  });

  it("is NOT shown the withheld banner — nothing is being withheld from this response", async () => {
    // A warning on every page load is noise that teaches operators to ignore the banner on the
    // day it means something.
    const out = await render();
    expect(out).not.toContain("Names are withheld on this page");
  });
});

describe("an entitled admin whose name budget is spent", () => {
  beforeEach(() => {
    stub.capabilities = ["read_entities", "read_identity"];
    stub.page = { items: [FACELESS], nextCursor: null };
  });

  it("says the names are withheld, and that the ROLE is not the reason", async () => {
    // Same bytes on the wire as the analyst's response; a different screen, because only the
    // client knows the capability. Without this banner the console looks like it regressed.
    const out = await render();
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).not.toContain("your role does not include name access");
  });

  it("hides the Name column rather than filling it with dashes", async () => {
    const out = await render();
    expect(out).not.toContain("<th scope=\"col\">Name</th>");
    expect(out).not.toContain("No name on record");
  });

  it("leaves every other field on the row untouched", async () => {
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain("no photo");
    expect(firstRowCells(out)).toHaveLength(6);
  });
});

describe("the states where there is nothing to be named", () => {
  it("an EMPTY page from an entitled admin posts no withheld banner", async () => {
    // Nothing was withheld — there was nothing to withhold. A banner here would be a warning
    // about a table with no rows in it.
    stub.page = { items: [], nextCursor: null };
    const out = await render();
    expect(out).not.toContain("Names are withheld on this page");
    expect(out).toContain("No workers registered yet");
  });

  it("a REJECTED filter posts no withheld banner either", async () => {
    // `page` is null, so there is no evidence about names one way or the other, and the honest
    // screen is the filter error alone.
    stub.failure = new Error("400");
    const out = await render({ status: "nonsense" });
    expect(out).toContain("The server rejected these filters");
    expect(out).not.toContain("Names are withheld on this page");
  });
});

describe("the posture is measured, not predicted", () => {
  it("renders names that ARRIVED even if /admin/me reported no capability", async () => {
    // A server that disclosed to a role the session says is not entitled is a server bug — but
    // the names are already over the wire, hiding the column would not un-disclose them, and
    // the failure worth preventing is claiming in copy that nothing was shown while showing it.
    stub.capabilities = ["read_entities"];
    stub.page = { items: [NAMED], nextCursor: null };
    const out = await render();
    expect(out).toContain("Ramesh Kumar");
    expect(out).not.toContain("your role does not include name access");
  });
});
