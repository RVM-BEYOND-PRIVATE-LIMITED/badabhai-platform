import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { candidateRecord } from "../../../../test/candidate-record";

/**
 * A7 (#2577) — the Candidates data-bank list opens the candidate drawer: for a session holding
 * `read_candidates` each row's link is THIS list with `?c=<id>` added (every filter and the page
 * kept) and opens the drawer in place; the page reads the open record on the server BESIDE the
 * search; the drawer is handed the rows it moves through, titled as the list names them.
 * Without the capability nothing changes: rows open the worker's page and `?c=` is ignored.
 */
const stub = vi.hoisted(() => ({
  capabilities: [] as string[],
  candidates: [] as unknown[],
  order: [] as string[],
  read: vi.fn(),
  drawer: null as null | Record<string, unknown>,
}));

const SEARCH_RESPONSE = () => ({
  candidates: stub.candidates,
  page: 1,
  page_size: 50,
  total: stub.candidates.length,
  total_pages: 1,
  counts: { by_status: [], by_trade: [], by_city: [], by_profile_status: [] },
  q_type: null,
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({ adminId: "a-1", role: "support", capabilities: stub.capabilities }),
}));
vi.mock("../../../lib/admin-http", () => ({ isAdminRequestError: () => false }));
vi.mock("../../../lib/candidate-search-server", () => ({
  searchCandidates: async () => {
    stub.order.push("search");
    return SEARCH_RESPONSE();
  },
}));
vi.mock("../../../lib/candidate-detail", () => ({
  readCandidateRecord: (id: string) => {
    stub.order.push(`record ${id}`);
    return stub.read(id);
  },
}));
vi.mock("./filter-bar", () => ({ CandidateFilterBar: () => null }));
vi.mock("./candidate-search-box", () => ({ CandidateSearchBox: () => null }));
vi.mock("./saved-views", () => ({ CandidateSavedViews: () => null }));
vi.mock("./candidate-drawer", () => ({
  CandidateDrawer: (p: Record<string, unknown>) => {
    stub.drawer = p;
    return <div data-candidate-drawer="" />;
  },
}));

const { default: CandidatesPage } = await import("./page");

const W1 = "5eeded00-0001-4a00-8000-000000000001";
const W2 = "5eeded00-0002-4a00-8000-000000000002";
const row = (id: string, name?: string | null) => ({
  worker_id: id,
  ...(name === undefined ? {} : { name }),
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
  languages: ["hi"],
  education_level: "10th pass",
  resume_count: 2,
  latest_resume_status: "rendered",
  profile_status: "confirmed",
  last_active_at: "2026-11-01T09:00:00.000Z",
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
});

beforeEach(() => {
  stub.capabilities = ["read_candidates", "read_identity"];
  stub.candidates = [row(W1, "Ramesh Kumar"), row(W2, null)];
  stub.order = [];
  stub.read = vi.fn(async () => ({ status: "ok", detail: candidateRecord() }));
  stub.drawer = null;
});

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await CandidatesPage({ searchParams: Promise.resolve(sp) }));

/** Each row link's href, in row order — whatever order the attributes are written in. */
const rowHrefs = (html: string) =>
  (html.match(/<a [^>]*class="grid__link"[^>]*>/g) ?? []).map(
    (tag) => /href="([^"]+)"/.exec(tag)![1]!.replace(/&amp;/g, "&"),
  );

describe("a session holding read_candidates", () => {
  it("each row opens the drawer: this list's address with ?c=<id> — filters and page kept", async () => {
    const out = await render({ status: "active", page: "2" });
    expect(rowHrefs(out)).toEqual([
      `/candidates?status=active&page=2&c=${W1}`,
      `/candidates?status=active&page=2&c=${W2}`,
    ]);
  });

  it("renders the drawer, handed the page's rows in order — each titled as the list names it", async () => {
    await render();
    expect(out(stub.drawer).rows).toEqual([
      { id: W1, title: "Ramesh Kumar" },
      // Disclosed, none on record: the short id, never an empty title.
      { id: W2, title: "Candidate 5eed…0002" },
    ]);
    expect(out(stub.drawer).entitled).toBe(true);
  });

  it("with no ?c= the page reads no record", async () => {
    await render({ status: "active" });
    expect(stub.read).not.toHaveBeenCalled();
    expect(out(stub.drawer).initial).toBeNull();
  });

  it("with ?c= it reads that record on the server — BESIDE the search, not after it", async () => {
    await render({ c: W2 });
    expect(stub.read).toHaveBeenCalledWith(W2);
    expect(stub.order).toEqual([`record ${W2}`, "search"]);
    expect(out(stub.drawer).initial).toEqual({
      id: W2,
      result: { status: "ok", detail: candidateRecord() },
    });
  });

  it("a failed record read is the drawer's to show — the list still renders", async () => {
    stub.read = vi.fn(async () => ({ status: "error" }));
    const html = await render({ c: W2 });
    expect(out(stub.drawer).initial).toEqual({ id: W2, result: { status: "error" } });
    expect(rowHrefs(html)).toHaveLength(2);
  });

  it("an analyst's rows are titled by id (no names), and the drawer knows the role sees none", async () => {
    stub.capabilities = ["read_candidates"];
    stub.candidates = [row(W1), row(W2)];
    await render();
    expect(out(stub.drawer).rows).toEqual([
      { id: W1, title: "Candidate 5eed…0001" },
      { id: W2, title: "Candidate 5eed…0002" },
    ]);
    expect(out(stub.drawer).entitled).toBe(false);
  });

  it("the reveal is offered only to a session holding reveal_pii", async () => {
    await render();
    expect(out(stub.drawer).canReveal).toBe(false);
    stub.capabilities = [...stub.capabilities, "reveal_pii"];
    await render();
    expect(out(stub.drawer).canReveal).toBe(true);
  });
});

describe("a session WITHOUT read_candidates — the drawer entry is hidden", () => {
  beforeEach(() => {
    stub.capabilities = ["read_identity"];
  });

  it("rows open the worker's page, exactly as before", async () => {
    const html = await render({ status: "active" });
    expect(rowHrefs(html)).toEqual([`/candidates/${W1}`, `/candidates/${W2}`]);
    expect(html).not.toContain("data-candidate-drawer");
    expect(stub.drawer).toBeNull();
  });

  it("a ?c= in the address is ignored: no record is read", async () => {
    await render({ c: W1 });
    expect(stub.read).not.toHaveBeenCalled();
    expect(stub.drawer).toBeNull();
  });
});

function out(p: Record<string, unknown> | null) {
  expect(p, "the drawer was rendered").not.toBeNull();
  return p as { rows: unknown; initial: unknown; entitled: boolean; canReveal: boolean };
}
