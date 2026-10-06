import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CUSTOMER_SECTION_HREF } from "../lib/customer";

/**
 * The shared Companies / Agencies detail route hands its view the BACK LINK to the persona's own
 * list. The topbar crumb leaves that section unlinked on these pages because the back link is the
 * one link to it (sweep AW-16), and `page-header.render.test.tsx` resolves the two delegating
 * pages' back links through `CUSTOMER_SECTION_HREF` — this file proves the route really uses it.
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

const render = async (kind: "Company" | "Agency") =>
  renderToStaticMarkup(
    await PayerDetailRoute({ id: "6155050c-c91b-4c6e-96a7-8da023f1d2d2", kind }),
  );

describe("PayerDetailRoute — the back link goes to the persona's list", () => {
  it("a company links back to /companies", async () => {
    stub.role = "employer";
    await render("Company");
    expect(stub.viewProps?.backHref).toBe("/companies");
    expect(stub.viewProps?.backHref).toBe(CUSTOMER_SECTION_HREF.Company);
  });

  it("an agency links back to /agencies", async () => {
    stub.role = "agent";
    await render("Agency");
    expect(stub.viewProps?.backHref).toBe("/agencies");
    expect(stub.viewProps?.backHref).toBe(CUSTOMER_SECTION_HREF.Agency);
  });
});
