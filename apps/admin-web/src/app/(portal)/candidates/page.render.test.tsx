import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { columnHeaders } from "../../../../test/grid-markup";

/**
 * What the Candidates DATA BANK renders (A7, #2577) after the 2026-08-18 name ruling.
 *
 * The list reads `POST /admin/candidates/search` (bare-filters body from the address; the
 * universal term never touches a URL) and pages by number over its exact total. The name
 * postures are the roster's three screens: a Name column only when names arrived, a withheld
 * banner only for a capped entitled read, and the analyst's list exactly as the faceless
 * roster — no column, no dashes, no header promising data they will never be shown.
 */
const stub = vi.hoisted(() => {
  /** Stands in for `AdminRequestError`, whose `status` is what separates the two failures. */
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    capabilities: ["read_candidates", "read_identity"] as string[],
    response: null as null | {
      candidates: unknown[];
      page: number;
      page_size: number;
      total: number;
      total_pages: number;
      counts: {
        by_status: Array<{ value: string; count: number }>;
        by_trade: Array<{ value: string; count: number }>;
        by_city: Array<{ value: string; count: number }>;
        by_profile_status: Array<{ value: string; count: number }>;
      };
      q_type: null;
    },
    failure: null as unknown,
    searchBody: null as unknown,
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../lib/candidate-search-server", () => ({
  searchCandidates: async (body: unknown) => {
    stub.searchBody = body;
    if (stub.failure) throw stub.failure;
    return stub.response;
  },
}));

vi.mock("../../../lib/candidate-detail", () => ({
  readCandidateRecord: async () => ({ status: "not_found" }),
}));

// `useSearchParams` needs an app-router context this renderer does not provide; the box is
// covered by its own tests, so it renders nothing here.
vi.mock("./candidate-search-box", () => ({ CandidateSearchBox: () => null }));
vi.mock("./filter-bar", () => ({ CandidateFilterBar: () => null }));
vi.mock("./saved-views", () => ({ CandidateSavedViews: () => null }));
vi.mock("./candidate-drawer", () => ({ CandidateDrawer: () => null }));

const { default: CandidatesPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

/** A faceless row: exactly what an analyst, or a capped read, gets back. */
const FACELESS = {
  worker_id: WORKER_ID,
  status: "active",
  flagged: false,
  is_test_account: false,
  deletion_scheduled_at: null,
  current_city: "Pune",
  current_state: "Maharashtra",
  trade_label: "Welder",
  role_label: "TIG Welder",
  domain_label: "Fabrication",
  total_experience_years: "4",
  role_experience_months: 30,
  availability_status: "within_a_month",
  shift_preference: "day",
  form_level: "medium",
  skills: ["skill_welding"],
  languages: ["hi", "mr"],
  education_level: "10th pass",
  resume_count: 2,
  latest_resume_status: "rendered",
  profile_status: "confirmed",
  last_active_at: "2026-11-01T09:00:00.000Z",
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
};

/** The same row, named. A real Indian worker name, because that is what this column holds. */
const NAMED = { ...FACELESS, name: "Ramesh Kumar" };

/** Disclosed, and nobody ever recorded a name — the row the dash belongs to. */
const UNNAMED = {
  ...FACELESS,
  worker_id: "5eeded00-0002-4a00-8000-000000000002",
  name: null,
};

const EMPTY_RESPONSE: {
  candidates: Record<string, unknown>[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: {
    by_status: Array<{ value: string; count: number }>;
    by_trade: Array<{ value: string; count: number }>;
    by_city: Array<{ value: string; count: number }>;
    by_profile_status: Array<{ value: string; count: number }>;
  };
  q_type: null;
} = {
  candidates: [],
  page: 1,
  page_size: 50,
  total: 0,
  total_pages: 1,
  counts: { by_status: [], by_trade: [], by_city: [], by_profile_status: [] },
  q_type: null,
};

const FULL_RESPONSE = {
  ...EMPTY_RESPONSE,
  candidates: [NAMED],
  total: 24310,
  total_pages: 487,
  counts: {
    by_status: [{ value: "active", count: 20000 }],
    by_trade: [{ value: "dom_welding", count: 3200 }],
    by_city: [{ value: "Pune", count: 4100 }],
    by_profile_status: [{ value: "confirmed", count: 18000 }],
  },
};

beforeEach(() => {
  stub.capabilities = ["read_candidates", "read_identity"];
  stub.response = { ...FULL_RESPONSE, candidates: [{ ...NAMED }] };
  stub.failure = null;
  stub.searchBody = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await CandidatesPage({ searchParams: Promise.resolve(searchParams) }));

/**
 * The DATA cells of the first body row, in order — the row link's end chevron (an aria-hidden
 * cell with no header of its own, A4) is decoration, not a column.
 */
function firstRowCells(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"));
  const row = body.slice(0, body.indexOf("</tr>"));
  return row
    .split("<td")
    .slice(1)
    .filter((cell) => !cell.startsWith(' class="grid__end"'));
}

describe("an admin who holds read_identity", () => {
  it("renders the name, in its own column, before the id", async () => {
    const out = await render();
    expect(columnHeaders(out)[0]).toBe("Name");
    expect(out).toContain("Ramesh Kumar");
    expect(out.indexOf("Ramesh Kumar")).toBeLessThan(out.indexOf(`title="${WORKER_ID}"`));
  });

  it("heads the results with the search's exact total — never the page size", async () => {
    const out = await render();
    expect(out).toContain("Candidates · 24,310");
  });

  it("pages by number over that total, with the row count on the page", async () => {
    const out = await render();
    expect(out).toContain("of 24,310");
    expect(out).toContain("1 on this page");
    expect(out).toContain("page 1 of 487");
  });

  it("links the row through the NAME into the drawer, filters and page kept", async () => {
    const out = await render({ status: "active", page: "3" });
    expect(out).toContain(
      `/candidates?status=active&amp;page=3&amp;c=${WORKER_ID}`,
    );
    expect(out).toContain(`<span class="mono" title="${WORKER_ID}">5eed…0001</span>`);
    expect(out).toContain('aria-label="Copy worker id"');
  });

  it("renders a NULL name as a dash that says what a dash means", async () => {
    stub.response = { ...FULL_RESPONSE, candidates: [{ ...UNNAMED }] };
    const out = await render();
    expect(out).toContain('<span class="table__meta" title="No name on record for this account.">—</span>');
  });

  it("renders a BLANK name as the same dash, never as an empty cell", async () => {
    stub.response = { ...FULL_RESPONSE, candidates: [{ ...NAMED, name: "   " }] };
    const out = await render();
    expect(out).toContain('title="No name on record for this account.">—</span>');
  });

  it("keeps every row the same width as the header", async () => {
    stub.response = { ...FULL_RESPONSE, candidates: [{ ...NAMED }, { ...UNNAMED }] };
    const out = await render();
    const headers = columnHeaders(out).length;
    // 10 default columns with the Name column.
    expect(headers).toBe(10);
    expect(firstRowCells(out)).toHaveLength(headers);
  });

  it("draws the #2577 defaults with the Identity / Work / Activity / Account chooser", async () => {
    const out = await render();
    expect(columnHeaders(out)).toEqual([
      "Name",
      "ID",
      "Trade",
      "Experience",
      "City",
      "Status",
      "Profile",
      "Resume",
      "Last active",
      "Registered",
    ]);
    // The chooser groups (Identity / Work / Activity / Account) travel with the columns.
    expect(out).toContain("Identity");
    expect(out).toContain("Work");
    expect(out).toContain("Activity");
    expect(out).toContain("Account");
  });

  it("reads the work columns off the row, never inventing one", async () => {
    const out = await render();
    expect(out).toContain("Welder");
    expect(out).toContain("4 years");
    expect(out).toContain("Pune");
    expect(out).toContain("2 · Rendered");
  });

  it("sorts by the allow-listed columns, keeping every filter and restarting at page one", async () => {
    const out = await render({ status: "active", page: "3" });
    expect(out).toContain("/candidates?status=active&amp;sort=trade_label");
  });

  it("says names are shown and audited, and posts NO withheld banner", async () => {
    const out = await render();
    expect(out).toContain("Names are shown to your role");
    expect(out).toContain("capped and audited");
    expect(out).not.toContain("Names are withheld on this page");
  });

  it("keeps the contact caveat one click away, behind the subtitle's ⓘ (#2573)", async () => {
    const out = await render();
    const info = out.slice(out.indexOf('<details class="infopop">'));
    expect(out.indexOf('<details class="infopop">')).toBeGreaterThan(out.indexOf('class="page__sub"'));
    expect(info).toContain("reason-gated action");
  });
});

describe("an analyst, who will never hold read_identity", () => {
  beforeEach(() => {
    // No read_candidates either: rows open the worker's page and `?c=` is ignored.
    stub.capabilities = ["read_entities"];
    stub.response = { ...FULL_RESPONSE, candidates: [{ ...FACELESS }] };
  });

  it("gets NO Name column — not a column of dashes", async () => {
    const out = await render();
    expect(columnHeaders(out)).not.toContain("Name");
    expect(out).not.toContain("No name on record");
  });

  it("gets the numbered list intact, rows opening the worker's page", async () => {
    const out = await render();
    expect(out).toContain(`href="/candidates/${WORKER_ID}"`);
    expect(out).toContain("Candidates · 24,310");
    expect(columnHeaders(out)).toHaveLength(9);
    expect(firstRowCells(out)).toHaveLength(9);
  });

  it("is told plainly that this is a property of their ROLE, not of these workers", async () => {
    const out = await render();
    expect(out).toContain("your role does not include name access");
    expect(out).not.toContain("Names are shown to your role");
  });
});

describe("an entitled admin whose name budget is spent", () => {
  beforeEach(() => {
    stub.capabilities = ["read_candidates", "read_identity"];
    stub.response = { ...FULL_RESPONSE, candidates: [{ ...FACELESS }] };
  });

  it("says the names are withheld, and that the ROLE is not the reason", async () => {
    const out = await render();
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).not.toContain("your role does not include name access");
  });

  it("hides the Name column rather than filling it with dashes", async () => {
    const out = await render();
    expect(columnHeaders(out)).not.toContain("Name");
    expect(out).not.toContain("No name on record");
  });
});

describe("the states where there is nothing to be named", () => {
  it("an EMPTY page from an entitled admin posts no withheld banner", async () => {
    stub.response = { ...EMPTY_RESPONSE, candidates: [] };
    const out = await render();
    expect(out).not.toContain("Names are withheld on this page");
    expect(out).toContain("No candidates registered yet");
  });

  it("a REJECTED filter posts no withheld banner either", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ status: "nonsense" });
    expect(out).toContain("The server rejected these filters");
    expect(out).not.toContain("Names are withheld on this page");
  });
});

describe("the empty roster's events link follows read_events (owner brief 2026-10-01)", () => {
  it("is offered to a session that may open /events", async () => {
    stub.capabilities = ["read_candidates", "read_identity", "read_events"];
    stub.response = { ...EMPTY_RESPONSE, candidates: [] };
    const out = await render();
    expect(out).toContain("No candidates registered yet");
    expect(out).toMatch(/href="\/events">(<i [^>]*><\/i>)?View events<\/a>/);
  });

  it("is withheld from one that may not — the route would only redirect them", async () => {
    stub.capabilities = ["read_candidates", "read_identity"];
    stub.response = { ...EMPTY_RESPONSE, candidates: [] };
    const out = await render();
    expect(out).toContain("No candidates registered yet");
    expect(out).not.toContain('href="/events"');
    expect(out).not.toContain("View events");
  });
});

describe("what the page asks the search for", () => {
  it("a bare list is a bare-filters body — the term never rides the address", async () => {
    await render();
    expect(stub.searchBody).toEqual({
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      page_size: 50,
    });
  });

  it("filters, sort, direction, page and page size travel in the body", async () => {
    await render({ status: "active,suspended", city: "Pune", sort: "trade_label", dir: "asc", page: "3", page_size: "25" });
    expect(stub.searchBody).toEqual({
      filters: { status: ["active", "suspended"], city: ["Pune"] },
      sort: "trade_label",
      dir: "asc",
      page: 3,
      page_size: 25,
    });
  });

  it("an unparseable page is page one, not a 400", async () => {
    await render({ page: "nonsense" });
    expect(stub.searchBody).toMatchObject({ page: 1 });
  });
});

describe("a failed search: Retry repeats the query, the refusal names the filters", () => {
  it("keeps every filter on Retry, and offers Clear filters once in the head", async () => {
    stub.failure = new Error("boom");
    const out = await render({ status: "active", page: "2" });
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).toMatch(/href="\/candidates\?status=active&amp;page=2">(<i [^>]*><\/i>)?Retry<\/a>/);
  });

  it("a 400 with a filter set is the refusal, and offers no Retry — it could only repeat it", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ status: "nonsense" });
    expect(out).toContain("The server rejected these filters");
    expect(out).not.toContain("Candidates are unavailable");
    expect(out).not.toContain(">Retry<");
  });

  it("a 400 offers Clear filters IN the refusal — once on the screen", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ status: "nonsense" });
    const state = out.slice(out.indexOf('class="state state--error"'));
    expect(state).toMatch(/href="\/candidates">(<i [^>]*><\/i>)?Clear filters(?:<span class="nav-pending" aria-hidden="true"><\/span>)?<\/a>/);
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });

  it("an outage with a filter is an outage, with Retry keeping the query", async () => {
    stub.failure = new stub.RequestError(500);
    const out = await render({ status: "active" });
    expect(out).toContain("Candidates are unavailable");
    expect(out).not.toContain("rejected");
    expect(out).toMatch(/href="\/candidates\?status=active">(<i [^>]*><\/i>)?Retry<\/a>/);
  });

  it("a filtered EMPTY result names the head's Clear filters instead of repeating it", async () => {
    stub.response = { ...EMPTY_RESPONSE, candidates: [] };
    const out = await render({ status: "active" });
    expect(out).toContain("No candidates match these filters");
    expect(out).toContain("clear them");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });
});

/** PAGE HEIGHT (final sweep AW-08): the filter panel folds behind a toggle on a phone. */
describe("the filter panel (AW-08)", () => {
  it("is closed with no filter; each filter counts as one", async () => {
    expect(await render()).toContain('data-open="false"');
    const out = await render({ status: "active", city: "Pune" });
    expect(out).toContain('data-open="true"');
    expect(out).toContain(">Filters (2)</button>");
  });
});
