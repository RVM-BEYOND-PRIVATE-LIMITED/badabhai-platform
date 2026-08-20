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

const stub = vi.hoisted(() => ({
  capabilities: ["read_entities", "read_identity"] as string[],
  page: null as { items: unknown[]; nextCursor: string | null } | null,
  roles: [] as unknown[],
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/entities", () => ({
  listPayers: async (filters: { role?: string }) => {
    stub.roles.push(filters.role);
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
  stub.roles.length = 0;
});

const render = async (page: (typeof PAGES)[number][1]) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve({}) }));

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
