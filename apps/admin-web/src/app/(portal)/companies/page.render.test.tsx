import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The two payer roster ROUTES — what they compute and hand to the shared list.
 *
 * `payer-list.render.test.tsx` proves the table obeys the posture it is given. This file proves
 * the pages work the posture out correctly, which is a different failure: they read the name off
 * `org_name`, and a page that asked `identityPosture` about `full_name` (the worker key, one
 * copy-paste away) would compute `capped` for every entitled admin and quietly hide a column
 * that was fully disclosed — a bug no type would catch, since the field is a string argument.
 *
 * Companies and Agencies are tested TOGETHER because they are meant to behave identically and
 * are two files: the one thing worth pinning is that they do not drift apart.
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
    capabilities: ["read_entities", "read_identity"] as string[],
    page: null as { items: unknown[]; nextCursor: string | null } | null,
    failure: null as unknown,
    roles: [] as unknown[],
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

vi.mock("../../../lib/entities", () => ({
  listPayers: async (filters: { role?: string }) => {
    stub.roles.push(filters.role);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

vi.mock("../../../components/payer-filter-bar", () => ({ PayerFilterBar: () => null }));

const { default: CompaniesPage } = await import("./page");
const { default: AgenciesPage } = await import("../agencies/page");

const PAYER_ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

const FACELESS = {
  id: PAYER_ID,
  role: "employer",
  status: "active",
  previous_status: null,
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
};

const NAMED = { ...FACELESS, org_name: "Acme Fabrication Pvt Ltd" };

const PAGES = [
  ["companies", CompaniesPage],
  ["agencies", AgenciesPage],
] as const;

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_identity"];
  stub.page = { items: [NAMED], nextCursor: null };
  stub.failure = null;
  stub.roles.length = 0;
});

const render = async (
  page: (typeof PAGES)[number][1],
  searchParams: Record<string, string | undefined> = {},
) => renderToStaticMarkup(await page({ searchParams: Promise.resolve(searchParams) }));

describe("both roster pages read the posture off org_name", () => {
  it.each(PAGES)("%s renders the Organisation column when names arrived", async (_n, page) => {
    // The copy-paste bug this exists for: asking about `full_name` here yields `capped` for a
    // fully disclosed page, and the column silently vanishes.
    const out = await render(page);
    expect(out).toContain('<th scope="col">Organisation</th>');
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out).not.toContain("Names are withheld on this page");
  });

  it.each(PAGES)("%s hides the column and explains, when entitled but capped", async (_n, page) => {
    stub.page = { items: [FACELESS], nextCursor: null };
    const out = await render(page);
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).not.toContain('<th scope="col">Organisation</th>');
    expect(out).not.toContain("No name on record");
  });

  it.each(PAGES)(
    "%s, capped, does not describe the accounts as named above the withheld notice",
    async (_n, page) => {
      // Two-valued descriptions said "named by the organisation they registered as" directly
      // over "Names are withheld on this page" (sweep AW-21). Three-valued, like the detail panel.
      stub.page = { items: [FACELESS], nextCursor: null };
      const out = await render(page);
      expect(out).not.toContain("named by the organisation they registered as");
      expect(out).toContain("identified by id while names are withheld (see below)");
    },
  );

  it.each(PAGES)("%s gives an analyst the pre-ruling table and an honest reason", async (_n, page) => {
    stub.capabilities = ["read_entities"];
    stub.page = { items: [FACELESS], nextCursor: null };
    const out = await render(page);
    expect(out).toContain("your role does not include name access");
    expect(out).not.toContain('<th scope="col">Organisation</th>');
    expect(out).not.toContain("Names are withheld on this page");
    expect(out).toContain(`title="${PAYER_ID}"`);
  });

  it.each(PAGES)("%s posts no banner over an EMPTY page", async (_n, page) => {
    stub.page = { items: [], nextCursor: null };
    const out = await render(page);
    expect(out).not.toContain("Names are withheld on this page");
  });
});

describe("each page still asks for its own half of the table", () => {
  it("companies asks for employers, agencies for agents", async () => {
    // Anti-vacuity for the `it.each` above: both pages really did run, against different
    // queries, rather than one of them silently rendering the other's data.
    await render(CompaniesPage);
    await render(AgenciesPage);
    expect(stub.roles).toEqual(["employer", "agent"]);
  });

  it("each keeps the caveat that a registered name is self-declared, not verified", async () => {
    // A name column beside a suspend button should not read as a verified legal identity.
    for (const [, page] of PAGES) {
      expect(await render(page)).toContain("not a verified legal name");
    }
  });

  it("agencies still says the KYC name is not what is on screen", async () => {
    // `agency_kyc.account_holder_name_enc` is behind the ADR-0022 money/legal gate and is NOT
    // this ruling's to disclose; the page says so where an operator will read it.
    expect(await render(AgenciesPage)).toContain("KYC details stay encrypted");
  });
});

/**
 * A REFUSED read and an UNAVAILABLE one are different screens (sweep AW-05), and a failure past
 * page one keeps the filter on both recoveries (AW-06) — on both rosters, identically.
 */
describe("a failed read is told apart by its cause, on both rosters", () => {
  it.each(PAGES)("%s: an outage with no filter is ours — never 'that filter was rejected'", async (name, page) => {
    stub.failure = new TypeError("fetch failed");
    const out = await render(page);
    expect(out).toContain(`${name === "companies" ? "Companies" : "Agencies"} are unavailable`);
    expect(out).toContain("Nothing was fetched.");
    expect(out).not.toContain("rejected");
    expect(out).toContain(`href="/${name}"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`);
  });

  it.each(PAGES)("%s: an outage past page one keeps the filter on both recoveries", async (name, page) => {
    stub.failure = new stub.RequestError(503);
    const out = await render(page, { status: "suspended", cursor: "c2" });
    expect(out).toContain(`href="/${name}?status=suspended&amp;cursor=c2"><i`);
    expect(out).toContain(`href="/${name}?status=suspended"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`);
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });

  it.each(PAGES)("%s: a 400 on the filter is the refusal, with no Retry", async (_name, page) => {
    stub.failure = new stub.RequestError(400);
    const out = await render(page, { status: "nonsense" });
    expect(out).toContain("The server rejected that filter");
    expect(out).toContain("That filter was rejected.");
    expect(out).not.toContain(">Retry<");
  });

  it.each(PAGES)("%s: a 400 on a cursor alone names the cursor, and offers the first page", async (name, page) => {
    stub.failure = new stub.RequestError(400);
    const out = await render(page, { cursor: "stale" });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("rejected that filter");
    expect(out).toContain(`href="/${name}"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`);
    expect(out).not.toContain(">Retry<");
  });
});

/**
 * Review of #2031. A 400 with the status filter set is the FILTER's (the API refuses a page
 * cursor only when it is longer than any it issues), so the refusal carries Clear filters — the
 * screen's one — and never a first page that keeps the refused filter. A 400 with nothing in the
 * address cannot be the operator's at all: it is an outage, with Retry.
 */
describe("a refused filter is cleared from the refusal itself, on both rosters", () => {
  const stateOf = (out: string) => out.slice(out.indexOf('class="state state--error"'));

  it.each(PAGES)("%s: the 400's way out is Clear filters, in the state, once", async (name, page) => {
    stub.failure = new stub.RequestError(400);
    const out = await render(page, { status: "nonsense", cursor: "c2" });
    expect(stateOf(out)).toContain(`href="/${name}"><i class="ph-fill ph-funnel-x" aria-hidden="true"></i>Clear filters</a>`);
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).not.toContain("Back to the first page");
  });

  it.each(PAGES)("%s: a 400 with nothing in the address is an outage, with Retry", async (name, page) => {
    stub.failure = new stub.RequestError(400);
    const out = await render(page);
    expect(out).toContain(`${name === "companies" ? "Companies" : "Agencies"} are unavailable`);
    expect(out).not.toContain("The server rejected");
    expect(out).toContain(`href="/${name}"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`);
  });
});

/** "Account" is the payer's own settings page; a customer is a company or an agency here. */
describe("the rosters call a customer a company or an agency — never an account", () => {
  it.each(PAGES)("%s: in every posture's description and in the empty state", async (_name, page) => {
    for (const capabilities of [["read_entities"], ["read_entities", "read_identity"]]) {
      stub.capabilities = capabilities;
      for (const items of [[NAMED], [FACELESS], []]) {
        stub.page = { items, nextCursor: null };
        const out = await render(page);
        const header = out.slice(0, out.indexOf("</header>"));
        expect(header, JSON.stringify({ capabilities, n: items.length })).not.toMatch(/\baccounts?\b/i);
        const state = out.indexOf('class="state"');
        if (state >= 0) expect(out.slice(state)).not.toMatch(/\baccounts?\b/i);
      }
    }
  });

  it.each(PAGES)("%s: a refused status is not 'an account status'", async (_name, page) => {
    stub.failure = new stub.RequestError(400);
    const out = await render(page, { status: "nonsense" });
    expect(out).toContain("That is not a customer status this portal recognises");
  });
});
