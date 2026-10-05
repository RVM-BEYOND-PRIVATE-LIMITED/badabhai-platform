import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * posting-routes — an agency's "Postings" / "New posting" lead to the AGENCY surface (`jobs`),
 * a company's to the company surface (`job_postings`); with the agency-portal flag off an agency
 * has no posting surface at all, so nothing may link it to a page that 404s.
 */

const flags = { agencyPortalEnabled: true };
vi.mock("./config", () => ({ agencyFlags: () => flags }));

const { agentPostingRedirect, postingRoutes } = await import("./posting-routes");

afterEach(() => {
  flags.agencyPortalEnabled = true;
});

describe("postingRoutes", () => {
  it("a company posts on the company surface", () => {
    expect(postingRoutes(false)).toEqual({ list: "/postings", create: "/postings/new" });
  });

  it("an agency posts AGENCY jobs only — never on /postings", () => {
    const r = postingRoutes(true)!;
    expect(r).toEqual({ list: "/agency/jobs", create: "/agency/jobs/new" });
    expect(Object.values(r).some((href) => href.startsWith("/postings"))).toBe(false);
  });

  it("an agency with the portal flag off has no posting surface (no door that 404s)", () => {
    flags.agencyPortalEnabled = false;
    expect(postingRoutes(true)).toBeNull();
    // …which never affects a company.
    expect(postingRoutes(false)).toEqual({ list: "/postings", create: "/postings/new" });
  });
});

describe("agentPostingRedirect", () => {
  it("sends an agent to their own list / create form", () => {
    expect(agentPostingRedirect("list")).toBe("/agency/jobs");
    expect(agentPostingRedirect("create")).toBe("/agency/jobs/new");
  });

  it("falls back to the dashboard when the agency surface is off", () => {
    flags.agencyPortalEnabled = false;
    expect(agentPostingRedirect("list")).toBe("/dashboard");
    expect(agentPostingRedirect("create")).toBe("/dashboard");
  });
});
