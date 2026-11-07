import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A7 (#2577) — the Candidates page as the SERVER renders it: the capability gate, the header,
 * the universal search and filter panel, the first-load skeleton, the name posture, and the
 * drawer's initial record when the address carries `?c=`.
 *
 * The list itself is read in the browser (the search term is body-only), so its ROWS are covered
 * by `candidates-bank.columns.test.ts` (the column set and posture) and the model tests; this
 * file holds the page's server contract.
 */
const stub = vi.hoisted(() => ({
  capabilities: [] as string[],
  search: "",
  read: vi.fn(),
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));
vi.mock("../../../lib/candidate-detail", async () => {
  const { candidateRecord } = await import("../../../../test/candidate-record");
  return {
    readCandidateRecord: (id: string) => {
      stub.read(id);
      return Promise.resolve({ status: "ok", detail: candidateRecord() });
    },
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/candidates",
  useSearchParams: () => new URLSearchParams(stub.search),
}));
// The phone field is its own test; here it is a marker for the reveal capability.
vi.mock("./phone-reveal", () => ({
  PhoneField: ({ canReveal }: { canReveal: boolean }) => (
    <span data-phone-field={canReveal ? "can-reveal" : "cannot"} />
  ),
}));

const { default: CandidatesPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await CandidatesPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  stub.capabilities = ["read_candidates", "read_identity"];
  stub.search = "";
  stub.read = vi.fn();
});

describe("the server shell", () => {
  it("is the data bank: a header, the universal search, the filters, saved views and a skeleton", async () => {
    const out = await render();
    expect(out).toContain('<h1 class="page__title">Candidates</h1>');
    expect(out).toContain("Search candidates");
    expect(out).toContain("Apply filters");
    expect(out).toContain("Saved views");
    expect(out).toContain("bank__skeleton");
    expect(out).toContain("Loading candidates");
    // The first load has no rows yet, so there is no data grid in the server HTML.
    expect(out).not.toContain('class="grid grid');
    expect(out).not.toContain('id="candidates"');
  });

  it("keeps the contact caveat one click away behind the subtitle's ⓘ", async () => {
    const out = await render();
    expect(out).toContain('<details class="infopop">');
    expect(out).toContain("reason-gated action");
    expect(out).toContain("The search term is sent only in the request body");
  });

  it("carries the URL's filters into the filter panel and counts them", async () => {
    const out = await render({ status: "active", city: "Pune" });
    expect(out).toContain(">Filters (2)</button>");
    expect(out).toContain('data-open="true"');
  });

  it("does not put a search term in the URL in any way (it is body-only)", async () => {
    const out = await render({ q: "Ramesh" });
    // `q` is not one of the known filters; it is ignored, never rendered into the panel.
    expect(out).toContain(">Filters</button>");
    expect(out).not.toContain("Ramesh");
  });
});

describe("the name posture", () => {
  it("tells an entitled admin names are shown and audited", async () => {
    const out = await render();
    expect(out).toContain(
      "Names are shown to your role, and each name read is capped and audited.",
    );
    expect(out).not.toContain("your role does not include name access");
  });

  it("tells an analyst the ROLE has no name access, without a Name column or a withheld banner", async () => {
    stub.capabilities = ["read_candidates"];
    const out = await render();
    expect(out).toContain("your role does not include name access");
    expect(out).not.toContain("Names are shown to your role");
    expect(out).not.toContain("Withheld");
    // The skeleton has no Name heading either: the posture is known before any row lands.
    expect(out).not.toContain(">Name</span>");
  });
});

describe("the drawer's server read", () => {
  beforeEach(() => {
    stub.search = `c=${WORKER_ID}`;
  });

  it("reads the open record BESIDE the page render, and shows it in the drawer", async () => {
    const out = await render({ c: WORKER_ID });
    expect(stub.read).toHaveBeenCalledWith(WORKER_ID);
    expect(out).toContain("Ramesh Kumar");
    expect(out).toContain("Candidate record");
    expect(out).toContain("Profile");
  });

  it("does not read a record without ?c=", async () => {
    stub.search = "";
    await render();
    expect(stub.read).not.toHaveBeenCalled();
  });

  it("passes the edit capability through to the record's section controls", async () => {
    stub.capabilities = ["read_candidates", "read_identity", "edit_candidates"];
    const withEdit = await render({ c: WORKER_ID });
    expect(withEdit).toContain("Edit location");
    expect(withEdit).toContain("Edit trade");

    stub.capabilities = ["read_candidates", "read_identity"];
    const without = await render({ c: WORKER_ID });
    expect(without).not.toContain("Edit location");
  });

  it("passes reveal_pii through to the phone field", async () => {
    stub.capabilities = ["read_candidates", "read_identity", "reveal_pii"];
    expect(await render({ c: WORKER_ID })).toContain('data-phone-field="can-reveal"');
    stub.capabilities = ["read_candidates", "read_identity"];
    expect(await render({ c: WORKER_ID })).toContain('data-phone-field="cannot"');
  });

  it("offers the account actions only to manage_worker_account (#2562)", async () => {
    stub.capabilities = ["read_candidates", "read_identity", "manage_worker_account"];
    const withActions = await render({ c: WORKER_ID });
    expect(withActions).toContain("Sign out everywhere");
    expect(withActions).toContain("Reset PIN");
    expect(withActions).toContain(">Suspend</button>");

    stub.capabilities = ["read_candidates", "read_identity"];
    const without = await render({ c: WORKER_ID });
    expect(without).not.toContain("Sign out everywhere");
    expect(without).not.toContain("Reset PIN");
  });
});
