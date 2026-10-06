import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Postings list RENDERS (route `/jobs`): its names (owner ruling 2026-10-01 — the job
 * entity is "Posting", headcount is "Openings"), its one "Clear filters", its recoveries, and
 * the empty state's link into the events log, offered only to a session that may open it.
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
    capabilities: ["read_entities", "read_events"] as string[],
    page: null as { items: unknown[]; nextCursor: string | null } | null,
    failure: null as unknown,
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
  listJobPostings: async () => {
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

// `useRouter` needs an app-router context this renderer does not provide.
vi.mock("./filter-bar", () => ({ JobFilterBar: () => null }));

const { default: JobsPage } = await import("./page");

const POSTING = {
  id: "b0b0b0b0-0001-4a00-8000-000000000001",
  payer_id: "6155050c-c91b-4c6e-96a7-8da023f1d2d2",
  org_label: "Acme Works Pune",
  role_title: "CNC Turner",
  location_label: "Chakan MIDC",
  city: "Pune",
  status: "open",
  verification_status: "unverified",
  vacancy_band: "2-5",
  pay_min: 18000,
  pay_max: 24000,
  published_at: "2026-09-20T09:00:00.000Z",
  closed_at: null,
  created_at: "2026-09-20T09:00:00.000Z",
};
const PAYER = POSTING.payer_id;

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_events"];
  stub.page = { items: [POSTING], nextCursor: null };
  stub.failure = null;
  stub.gates.length = 0;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await JobsPage({ searchParams: Promise.resolve(searchParams) }));

describe("the gate", () => {
  it("is read_entities, unchanged by the rename", async () => {
    await render();
    expect(stub.gates).toEqual(["read_entities"]);
  });
});

describe("the names (owner ruling 2026-10-01)", () => {
  it("calls the page Postings and the headcount Openings", async () => {
    const out = await render();
    expect(out).toContain('<h1 class="page__title">Postings</h1>');
    expect(out).toContain("2-5 openings");
    expect(out).not.toContain("vacancies");
    expect(out).not.toContain(">Jobs<");
  });

  it("names the columns for what they hold", async () => {
    const out = await render();
    expect(out).toContain('<th scope="col">Role title</th>');
    expect(out).toContain('<th scope="col">Trust review</th>');
    // The customer who published it: "Customer", never "Owner account" (owner ruling
    // 2026-10-01 — "Account" is the payer's own settings page).
    expect(out).toContain('<th scope="col">Customer</th>');
    expect(out).not.toContain("Owner account");
    expect(out).not.toContain('<th scope="col">Role</th>');
  });
});

describe("the empty list", () => {
  it("unfiltered: points at the events log for a session holding read_events", async () => {
    stub.page = { items: [], nextCursor: null };
    const out = await render();
    expect(out).toContain("No postings created yet");
    expect(out).toMatch(/href="\/events">(<i [^>]*><\/i>)?View events<\/a>/);
  });

  it("unfiltered, without read_events: no link into a log the session cannot open", async () => {
    stub.capabilities = ["read_entities"];
    stub.page = { items: [], nextCursor: null };
    const out = await render();
    expect(out).toContain("No postings created yet");
    expect(out).not.toContain('href="/events"');
  });

  it("filtered: ONE Clear filters, in the results head, not again in the state", async () => {
    stub.page = { items: [], nextCursor: null };
    const out = await render({ status: "closed" });
    expect(out).toContain("No postings match these filters");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).toMatch(/href="\/jobs">(<i [^>]*><\/i>)?Clear filters<\/a>/);
  });
});

describe("a failed read: Retry repeats the query, Back to the first page drops the cursor", () => {
  it("keeps the cursor on Retry, and offers the first page as its own action", async () => {
    stub.failure = new Error("boom");
    const out = await render({ cursor: "Y3Vyc29y" });
    expect(out).toMatch(/href="\/jobs\?cursor=Y3Vyc29y">(<i [^>]*><\/i>)?Retry<\/a>/);
    expect(out).toMatch(/href="\/jobs">(<i [^>]*><\/i>)?Back to the first page<\/a>/);
  });

  it("with a filter set, Retry KEEPS it, and Clear filters stays in the results head — once", async () => {
    stub.failure = new Error("boom");
    const out = await render({ status: "open" });
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).toMatch(/href="\/jobs\?status=open">(<i [^>]*><\/i>)?Retry<\/a>/);
    expect(out).not.toContain("Back to the first page");
  });

  it("filtered AND past page one: both recoveries, both keeping every filter (sweep AW-06)", async () => {
    // The only exit used to be the head's Clear filters, which drops the filters it was paging.
    stub.failure = new Error("boom");
    const out = await render({ status: "open", payerId: PAYER, cursor: "Y3Vyc29y" });
    expect(out).toContain(
      `href="/jobs?status=open&amp;payerId=${PAYER}&amp;cursor=Y3Vyc29y"><i class="ph-fill ph-arrow-clockwise" aria-hidden="true"></i>Retry</a>`,
    );
    expect(out).toContain(`href="/jobs?status=open&amp;payerId=${PAYER}"><i`);
    expect(out).toContain("Back to the first page</a>");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });
});

/**
 * A REFUSED read and an UNAVAILABLE one are different screens (sweep AW-05). A 500 with no
 * filter in the address used to read "The server rejected these filters".
 */
describe("a failed read is told apart by its cause", () => {
  it("an outage says the postings are unavailable — never that a filter was rejected", async () => {
    stub.failure = new TypeError("fetch failed");
    const out = await render();
    expect(out).toContain("Postings are unavailable");
    expect(out).toContain("a fault on our side");
    expect(out).toContain("Nothing was fetched.");
    expect(out).not.toContain("rejected");
  });

  it("a 500 from the API is an outage too, not a refusal", async () => {
    stub.failure = new stub.RequestError(500);
    const out = await render({ status: "open" });
    expect(out).toContain("Postings are unavailable");
    expect(out).not.toContain("rejected");
  });

  it("a 400 with a filter set is the refusal — and offers no Retry, which could only repeat it", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ payerId: "6155050c" });
    expect(out).toContain("The server rejected these filters");
    expect(out).toContain("That filter combination was rejected.");
    expect(out).toContain("A customer id must be a full UUID");
    expect(out).not.toContain("Postings are unavailable");
    expect(out).not.toContain(">Retry<");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    // …and that one Clear filters is IN the refusal, where the way out belongs.
    const state = out.slice(out.indexOf('class="state state--error"'));
    expect(state).toMatch(/href="\/jobs">(<i [^>]*><\/i>)?Clear filters<\/a>/);
  });

  it("a 400 with filters past page one: Clear filters — not a first page that keeps the refused filters", async () => {
    // The API refuses a page cursor only when it is longer than any it issues, so with filters
    // set the FILTERS were refused, and their first page would be refused again.
    stub.failure = new stub.RequestError(400);
    const out = await render({ status: "open", cursor: "c2" });
    expect(out).not.toContain("Back to the first page");
    expect(out).not.toContain(">Retry<");
    expect(out.split(">Clear filters<").length - 1).toBe(1);
  });

  it("a 400 with NOTHING in the address cannot be the operator's: it is an outage, with Retry", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render();
    expect(out).toContain("Postings are unavailable");
    expect(out).not.toContain("The server rejected");
    expect(out).toMatch(/href="\/jobs">(<i [^>]*><\/i>)?Retry<\/a>/);
  });

  it("a 400 on a cursor ALONE names the cursor — there are no filters to blame", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ cursor: "stale" });
    expect(out).toContain("The server rejected this page");
    expect(out).toContain("not one this list ever issued");
    expect(out).not.toContain("rejected these filters");
    expect(out).not.toContain("filter combination");
    expect(out).toMatch(/href="\/jobs">(<i [^>]*><\/i>)?Back to the first page<\/a>/);
  });
});

/** PAGE HEIGHT (final sweep AW-08): the 333px filter panel folds behind a toggle on a phone. */
describe("the filter panel (AW-08)", () => {
  it("is closed with no filter, open with the count when one is set", async () => {
    expect(await render()).toContain('data-open="false"');
    const out = await render({ status: "open", verificationStatus: "verified" });
    expect(out).toContain('data-open="true"');
    expect(out).toContain(">Filters (2)</button>");
  });
});
