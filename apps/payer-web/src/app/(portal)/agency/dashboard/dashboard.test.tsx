import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * LEGACY AGENCY DASHBOARD ROUTE (MERGE-1) — now a server redirect to the single role-aware
 * /dashboard. The agency demand modules moved INLINE onto /dashboard's agent branch (their
 * render/faceless/k-anon/CARDS-1 behaviour is now proven in ../../dashboard/agent-sections.test.tsx
 * and the funnel's own referral-funnel.test.tsx).
 *
 * This route keeps ONLY a redirect so old links/bookmarks still resolve. It must:
 *  - call next/navigation `redirect("/dashboard")`, and
 *  - read/render NO agency data of its own (no role gate / no agency fetch here — the gate +
 *    faceless reads live on the destination's AgentSections).
 */

const redirect = vi.fn((url: string) => {
  // next's real redirect throws a control-flow signal; mimic it so callers can't continue.
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

const { default: AgencyDashboardRedirect } = await import("./page");

beforeEach(() => {
  redirect.mockClear();
});

describe("legacy /agency/dashboard — redirects to the unified /dashboard", () => {
  it("calls redirect('/dashboard') (old links + hrefs still resolve)", () => {
    expect(() => AgencyDashboardRedirect()).toThrow("NEXT_REDIRECT:/dashboard");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });
});
