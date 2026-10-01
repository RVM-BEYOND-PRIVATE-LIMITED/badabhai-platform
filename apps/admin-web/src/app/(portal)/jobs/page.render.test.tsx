import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Postings list RENDERS (route `/jobs`): its names (owner ruling 2026-10-01 — the job
 * entity is "Posting", headcount is "Openings"), its one "Clear filters", its recoveries, and
 * the empty state's link into the events log, offered only to a session that may open it.
 */
const stub = vi.hoisted(() => ({
  capabilities: ["read_entities", "read_events"] as string[],
  page: null as { items: unknown[]; nextCursor: string | null } | null,
  failure: null as unknown,
  gates: [] as string[],
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
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
    expect(out).toContain('<th scope="col">Owner account</th>');
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

  it("with a filter set, Clear filters in the results head is the way out — once", async () => {
    stub.failure = new Error("boom");
    const out = await render({ status: "open" });
    expect(out.split(">Clear filters<").length - 1).toBe(1);
    expect(out).not.toContain(">Retry<");
  });
});
