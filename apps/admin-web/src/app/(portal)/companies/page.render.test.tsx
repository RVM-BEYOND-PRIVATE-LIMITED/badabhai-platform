import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { columnHeaders } from "../../../../test/grid-markup";

/**
 * The customers roster — Directory › Companies (`/companies`) — and what it computes and hands to
 * the shared list.
 *
 * ONE LIST, A KIND FILTER (A6, #2576). Companies and Agencies were two pages over the same table
 * and the same API; they are one page now, whose Kind chips (All · Companies · Agencies,
 * `?kind=company|agency`) set the `role` `GET /admin/payers` takes. Every behaviour the two pages
 * shared is pinned here on all three views, so the views cannot drift apart.
 *
 * `payer-list.render.test.tsx` proves the table obeys the posture it is given. This file proves
 * the page works the posture out correctly, which is a different failure: it reads the name off
 * `org_name`, and a page that asked `identityPosture` about `full_name` (the worker key, one
 * copy-paste away) would compute `capped` for every entitled admin and quietly hide a column
 * that was fully disclosed — a bug no type would catch, since the field is a string argument.
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
    gates: [] as string[],
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
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

/**
 * The three Kind views: the address that opens each, its `kind`, the role it asks for, the base
 * every recovery links to (HTML-escaped as rendered), and what the view calls its rows.
 */
const VIEWS = [
  ["all", undefined, undefined, "/companies", "Customers"],
  ["company", "company", "employer", "/companies?kind=company", "Companies"],
  ["agency", "agency", "agent", "/companies?kind=agency", "Agencies"],
] as const;

/** `base` plus more query, joined the way the page escapes it in an href. */
const withQuery = (base: string, query: string) =>
  `${base}${base.includes("?") ? "&amp;" : "?"}${query}`;

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_identity"];
  stub.page = { items: [NAMED], nextCursor: null };
  stub.failure = null;
  stub.roles.length = 0;
  stub.gates.length = 0;
});

const render = async (searchParams: Record<string, string | undefined> = {}) =>
  renderToStaticMarkup(await CompaniesPage({ searchParams: Promise.resolve(searchParams) }));

describe("the gate", () => {
  it("is read_entities, whatever the kind", async () => {
    for (const [, kind] of VIEWS) await render({ kind });
    expect(stub.gates).toEqual(["read_entities", "read_entities", "read_entities"]);
  });
});

describe("the Kind filter (A6)", () => {
  it.each(VIEWS)("%s asks the API for its role", async (_n, kind, role) => {
    await render({ kind });
    expect(stub.roles).toEqual([role]);
  });

  it("an unknown kind is never sent to the API: every customer, under the All chip", async () => {
    const out = await render({ kind: "reseller" });
    expect(stub.roles).toEqual([undefined]);
    expect(out).toContain('<span aria-current="true" class="btn btn--sm btn--selected">All</span>');
    expect(out).not.toContain("reseller");
  });

  it("is one chip group in the header's filter row, above the status filter", async () => {
    const out = await render();
    const group = out.indexOf('<div class="segmented" role="group" aria-label="Kind">');
    expect(group).toBeGreaterThan(out.indexOf("</header>"));
    expect(group).toBeLessThan(out.indexOf("Filter customers"));
  });

  it.each(VIEWS)("on %s the current chip is text, the others link their kind", async (_n, kind) => {
    const out = await render({ kind });
    const chips = out.slice(out.indexOf('aria-label="Kind"'), out.indexOf("Filter customers"));
    const current = { undefined: "All", company: "Companies", agency: "Agencies" }[String(kind)];
    expect(chips).toContain(
      `<span aria-current="true" class="btn btn--sm btn--selected">${current}</span>`,
    );
    for (const [label, href] of [
      ["All", "/companies"],
      ["Companies", "/companies?kind=company"],
      ["Agencies", "/companies?kind=agency"],
    ] as const) {
      if (label !== current) expect(chips).toContain(`href="${href}">${label}<`);
    }
  });

  it("is not one of the folding panel's filters — it stays in view on a phone", async () => {
    // The panel counts what it holds ("Filters (n)"); the kind is outside it, so a kind alone
    // leaves the panel closed and uncounted while its chip row stays on screen.
    stub.page = { items: [NAMED], nextCursor: null };
    const out = await render({ kind: "agency" });
    expect(out).not.toContain(">Filters (1)</button>");
    expect(out).toContain('aria-label="Kind"');
  });

  it("a chip keeps the status and drops the page cursor", async () => {
    const out = await render({ kind: "agency", status: "suspended", cursor: "c2" });
    const chips = out.slice(out.indexOf('aria-label="Kind"'), out.indexOf("Filter customers"));
    expect(chips).toContain('href="/companies?status=suspended">All<');
    expect(chips).toContain('href="/companies?kind=company&amp;status=suspended">Companies<');
    // Past page one the current chip is a link to ITS first page (the Pager only goes forward).
    expect(chips).toContain(
      'aria-current="true" class="btn btn--sm btn--selected" href="/companies?kind=agency&amp;status=suspended">Agencies<',
    );
    expect(chips).not.toContain("cursor");
  });

  it("the next page keeps the kind and the status", async () => {
    stub.page = { items: [NAMED], nextCursor: "c3" };
    const out = await render({ kind: "agency", status: "active" });
    expect(out).toContain('href="/companies?kind=agency&amp;status=active&amp;cursor=c3"');
  });

  it("a kind alone is a filter Clear filters clears; the bare list has none", async () => {
    expect(await render()).not.toContain(">Clear filters<");
    const out = await render({ kind: "agency" });
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).toContain(
      '<a class="btn btn--ghost" href="/companies"><i class="ph-fill ph-funnel-x" aria-hidden="true"></i>Clear filters<span class="nav-pending" aria-hidden="true"></span></a>',
    );
  });

  it.each(VIEWS)(
    "%s names its rows in the count, the empty state and the description",
    async (_n, kind, _r, _b, title) => {
      stub.page = { items: [NAMED, { ...NAMED, id: "x" }], nextCursor: null };
      const out = await render({ kind });
      const many = title.toLowerCase();
      expect(out).toContain(`2 ${many} on this page.`);
      expect(out).toContain(`${title}, named by the organisation they registered as.`);
      stub.page = { items: [], nextCursor: null };
      expect(await render({ kind })).toContain(`No ${many} registered yet.`);
      expect(await render({ kind, status: "active" })).toContain(`No ${many} match this filter.`);
    },
  );

  // The source fence (components/page-description.test.ts) measures an interpolated word as one
  // letter; this measures the rendered words, every view and posture, against the same 90.
  it("every description it can render still fits one line", async () => {
    for (const [, kind] of VIEWS) {
      for (const capabilities of [["read_entities"], ["read_entities", "read_identity"]]) {
        for (const items of [[NAMED], [FACELESS]]) {
          stub.capabilities = capabilities;
          stub.page = { items, nextCursor: null };
          const out = await render({ kind });
          const sub = /<p class="page__sub">([^<]*)<\/p>/.exec(out)![1]!;
          expect(sub.length, sub).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  it("is titled Companies — the section — in every view", async () => {
    for (const [, kind] of VIEWS) {
      expect(await render({ kind })).toContain('<h1 class="page__title">Companies</h1>');
    }
  });

  it.each(VIEWS)("%s: only the All view names each row's kind, in a Kind column", async (n, kind) => {
    // A filtered view has one kind, which its header already says; All mixes the two.
    stub.page = { items: [NAMED, { ...NAMED, id: "x", role: "agent" }], nextCursor: null };
    expect(columnHeaders(await render({ kind })).includes("Kind")).toBe(n === "all");
  });

  it.each(VIEWS)("%s: a row opens /companies/<id>, an agency's too", async (_n, kind) => {
    stub.page = { items: [{ ...NAMED, role: "agent" }], nextCursor: null };
    const out = await render({ kind });
    expect(out).toContain(`href="/companies/${PAYER_ID}"`);
    expect(out).not.toContain("/agencies");
  });
});

describe("the roster reads the posture off org_name, in every view", () => {
  it.each(VIEWS)("%s renders the Organisation column when names arrived", async (_n, kind) => {
    // The copy-paste bug this exists for: asking about `full_name` here yields `capped` for a
    // fully disclosed page, and the column silently vanishes.
    const out = await render({ kind });
    expect(columnHeaders(out)).toContain("Organisation");
    expect(out).toContain("Acme Fabrication Pvt Ltd");
    expect(out).not.toContain("Names are withheld on this page");
  });

  it.each(VIEWS)("%s hides the column and explains, when entitled but capped", async (_n, kind) => {
    stub.page = { items: [FACELESS], nextCursor: null };
    const out = await render({ kind });
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(columnHeaders(out)).not.toContain("Organisation");
    expect(out).not.toContain("No name on record");
  });

  it.each(VIEWS)(
    "%s, capped, does not describe the customers as named above the withheld notice",
    async (_n, kind) => {
      // Two-valued descriptions said "named by the organisation they registered as" directly
      // over "Names are withheld on this page" (sweep AW-21). Three-valued, like the detail panel.
      stub.page = { items: [FACELESS], nextCursor: null };
      const out = await render({ kind });
      expect(out).not.toContain("named by the organisation they registered as");
      expect(out).toContain("identified by id while names are withheld (see below)");
    },
  );

  it.each(VIEWS)(
    "%s gives an analyst the pre-ruling table and an honest reason",
    async (_n, kind) => {
      stub.capabilities = ["read_entities"];
      stub.page = { items: [FACELESS], nextCursor: null };
      const out = await render({ kind });
      expect(out).toContain("your role does not include name access");
      expect(columnHeaders(out)).not.toContain("Organisation");
      expect(out).not.toContain("Names are withheld on this page");
      expect(out).toContain(`title="${PAYER_ID}"`);
    },
  );

  it.each(VIEWS)("%s posts no banner over an EMPTY page", async (_n, kind) => {
    stub.page = { items: [], nextCursor: null };
    const out = await render({ kind });
    expect(out).not.toContain("Names are withheld on this page");
  });

  it.each(VIEWS)(
    "%s keeps the caveat that a registered name is self-declared",
    async (_n, kind) => {
      // A name column beside a suspend button should not read as a verified legal identity.
      expect(await render({ kind })).toContain("not a verified legal name");
    },
  );

  it("wherever agencies are listed it says their KYC details are not what is on screen", async () => {
    // `agency_kyc.account_holder_name_enc` is behind the ADR-0022 money/legal gate and is NOT
    // this ruling's to disclose; the page says so where an operator will read it.
    expect(await render({ kind: "agency" })).toContain("KYC details stay encrypted");
    expect(await render()).toContain("KYC details stay encrypted");
    expect(await render({ kind: "company" })).not.toContain("KYC");
  });
});

/**
 * A REFUSED read and an UNAVAILABLE one are different screens (sweep AW-05), and a failure past
 * page one keeps the filters on both recoveries (AW-06) — in every view, the kind included.
 */
describe("a failed read is told apart by its cause, in every view", () => {
  it.each(VIEWS)(
    "%s: an outage with no status is ours — never 'that filter was rejected'",
    async (_n, kind, _r, base, title) => {
      stub.failure = new TypeError("fetch failed");
      const out = await render({ kind });
      expect(out).toContain(`${title} are unavailable`);
      expect(out).toContain("Nothing was fetched.");
      expect(out).not.toContain("rejected");
      expect(out).toContain(
        `href="${base}"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`,
      );
    },
  );

  it.each(VIEWS)(
    "%s: an outage past page one keeps the filters on both recoveries",
    async (_n, kind, _r, base) => {
      stub.failure = new stub.RequestError(503);
      const out = await render({ kind, status: "suspended", cursor: "c2" });
      expect(out).toContain(`href="${withQuery(base, "status=suspended&amp;cursor=c2")}"><i`);
      expect(out).toContain(
        `href="${withQuery(base, "status=suspended")}"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`,
      );
      expect(out.split(">Clear filters<").length - 1).toBe(1);
    },
  );

  it.each(VIEWS)("%s: a 400 on the status is the refusal, with no Retry", async (_n, kind) => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ kind, status: "nonsense" });
    expect(out).toContain("The server rejected that filter");
    expect(out).toContain("That filter was rejected.");
    expect(out).not.toContain(">Retry<");
  });

  it.each(VIEWS)(
    "%s: a 400 on a cursor alone names the cursor, and offers the first page",
    async (_n, kind, _r, base) => {
      stub.failure = new stub.RequestError(400);
      const out = await render({ kind, cursor: "stale" });
      expect(out).toContain("The server rejected this page");
      expect(out).not.toContain("rejected that filter");
      expect(out).toContain(
        `href="${base}"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`,
      );
      expect(out).not.toContain(">Retry<");
    },
  );
});

/**
 * Review of #2031. A 400 with the status filter set is the FILTER's (the API refuses a page
 * cursor only when it is longer than any it issues), so the refusal carries Clear filters — the
 * screen's one — and never a first page that keeps the refused filter. A 400 with nothing the
 * API could refuse in the address cannot be the operator's at all: it is an outage, with Retry.
 */
describe("a refused filter is cleared from the refusal itself, in every view", () => {
  const stateOf = (out: string) => out.slice(out.indexOf('class="state state--error"'));

  it.each(VIEWS)("%s: the 400's way out is Clear filters, in the state, once", async (_n, kind) => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ kind, status: "nonsense", cursor: "c2" });
    expect(stateOf(out)).toContain(
      `href="/companies"><i class="ph-fill ph-funnel-x" aria-hidden="true"></i>Clear filters<span class="nav-pending" aria-hidden="true"></span></a>`,
    );
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).not.toContain("Back to the first page");
  });

  it.each(VIEWS)(
    "%s: a 400 with no status or cursor is an outage, with Retry",
    async (_n, kind, _r, base, title) => {
      // The kind never reaches the API as written (it is translated to a role), so it is nothing
      // the server could have refused.
      stub.failure = new stub.RequestError(400);
      const out = await render({ kind });
      expect(out).toContain(`${title} are unavailable`);
      expect(out).not.toContain("The server rejected");
      expect(out).toContain(
        `href="${base}"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`,
      );
    },
  );
});

/** "Account" is the payer's own settings page; a customer is a company or an agency here. */
describe("the roster calls a customer a customer, company or agency — never an account", () => {
  it.each(VIEWS)("%s: in every posture's description and in the empty state", async (_n, kind) => {
    for (const capabilities of [["read_entities"], ["read_entities", "read_identity"]]) {
      stub.capabilities = capabilities;
      for (const items of [[NAMED], [FACELESS], []]) {
        stub.page = { items, nextCursor: null };
        const out = await render({ kind });
        const header = out.slice(0, out.indexOf("</header>"));
        expect(header, JSON.stringify({ capabilities, n: items.length })).not.toMatch(
          /\baccounts?\b/i,
        );
        const state = out.indexOf('class="state"');
        if (state >= 0) expect(out.slice(state)).not.toMatch(/\baccounts?\b/i);
      }
    }
  });

  it.each(VIEWS)("%s: a refused status is not 'an account status'", async (_n, kind) => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ kind, status: "nonsense" });
    expect(out).toContain("That is not a customer status this portal recognises");
  });
});

/**
 * A status the filter offers is never the refused part (delta review of #2095): beside an
 * over-long cursor (the API's bound is 256), the 400 is the cursor's — first page, filters kept.
 */
describe("a valid status with a refused cursor gets the cursor's copy, in every view", () => {
  it.each(VIEWS)("%s: the page was refused, not the status", async (_n, kind, _r, base) => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ kind, status: "active", cursor: "x".repeat(300) });
    expect(out).toContain("The server rejected this page");
    expect(out).not.toContain("The server rejected that filter");
    const state = out.slice(out.indexOf('class="state state--error"'));
    expect(state).toContain(
      `href="${withQuery(base, "status=active")}"><i class="ph-fill ph-arrow-line-left" aria-hidden="true"></i>Back to the first page</a>`,
    );
    expect(state).not.toContain(">Clear filters<");
  });
});
