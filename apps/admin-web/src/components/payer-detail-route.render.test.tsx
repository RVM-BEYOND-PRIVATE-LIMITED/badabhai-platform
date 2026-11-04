import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CUSTOMERS_HREF } from "../lib/customer";

/**
 * The customer detail route (`/companies/[id]`) serves a Company and an Agency alike since A6
 * (#2576): it names the kind from the account's own `role`, links back to the one Companies list,
 * and no longer redirects an id between two sections. The topbar crumb leaves that section
 * unlinked on these pages because the back link is the one link to it (sweep AW-16), and
 * `page-header.render.test.tsx` resolves the route's back link through `CUSTOMERS_HREF` — this
 * file proves the route really uses it.
 */
const stub = vi.hoisted(() => ({
  role: "employer" as "employer" | "agent",
  viewProps: null as null | { backHref: string; kind: string },
}));

vi.mock("../lib/auth", () => ({
  requireCapability: async () => ({ adminId: "a-1", role: "ops_admin", capabilities: [] }),
}));
vi.mock("../lib/admin-http", () => ({ isAdminRequestError: () => false }));
vi.mock("../lib/entities", () => ({
  getPayer: async (id: string) => ({ id, role: stub.role }),
  listJobPostings: async () => ({ items: [], nextCursor: null }),
}));
// The view is a tree of client components; what this file is about is the props it is handed.
vi.mock("./payer-detail", () => ({
  PayerDetailView: (props: { backHref: string; kind: string }) => {
    stub.viewProps = props;
    return null;
  },
}));

const { PayerDetailRoute } = await import("./payer-detail-route");

beforeEach(() => {
  stub.viewProps = null;
});

const ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";
const render = async () => renderToStaticMarkup(await PayerDetailRoute({ id: ID }));

describe("PayerDetailRoute — one section, the kind read off the account", () => {
  it("a company is named Company and links back to /companies", async () => {
    stub.role = "employer";
    await render();
    expect(stub.viewProps?.kind).toBe("Company");
    expect(stub.viewProps?.backHref).toBe("/companies");
    expect(stub.viewProps?.backHref).toBe(CUSTOMERS_HREF);
  });

  it("an agency is named Agency, on the same page — no redirect to a second section", async () => {
    stub.role = "agent";
    // A redirect would THROW (Next's NEXT_REDIRECT); the page renders instead.
    await expect(render()).resolves.toBe("");
    expect(stub.viewProps?.kind).toBe("Agency");
    expect(stub.viewProps?.backHref).toBe("/companies");
  });
});
