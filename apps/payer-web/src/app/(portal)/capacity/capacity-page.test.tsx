import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayerSession } from "../../../lib/auth/types";

/**
 * /capacity — a REDIRECT, rendered nowhere (2026-10-01).
 *
 * Hiring capacity lives in ONE place: the section of Plans & capacity this route sends a company
 * to (`/plans#hiring-capacity`). The route is kept so old links and bookmarks still land there.
 * Plans & capacity is company-only, so an agent goes to the dashboard instead. The session gate
 * runs first, and nothing is read here (the page's render cases moved with it — plans-page.test).
 */

const EMPLOYER: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Manufacturing",
  role: "employer",
  status: "active",
};

const requirePayer = vi.fn<() => Promise<PayerSession>>();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
// Any read would have to come through these seams; none may be called.
const getCapacity = vi.fn();
const getLiveCatalog = vi.fn();

vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("../../../lib/payer-api", () => ({ getCapacity: () => getCapacity() }));
vi.mock("../../../lib/live-catalog", () => ({ getLiveCatalog: () => getLiveCatalog() }));

const { default: CapacityPage, dynamic } = await import("./page");

beforeEach(() => {
  requirePayer.mockReset().mockResolvedValue(EMPLOYER);
  redirect.mockClear();
  getCapacity.mockReset();
  getLiveCatalog.mockReset();
});

describe("/capacity — a redirect to Plans & capacity's Hiring capacity section", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("a company lands on /plans#hiring-capacity", async () => {
    await expect(CapacityPage()).rejects.toThrow("NEXT_REDIRECT /plans#hiring-capacity");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/plans#hiring-capacity");
  });

  it("an agent lands on the dashboard (Plans & capacity is a company page)", async () => {
    requirePayer.mockResolvedValue({ ...EMPLOYER, role: "agent" });
    await expect(CapacityPage()).rejects.toThrow("NEXT_REDIRECT /dashboard");
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("the session gate runs first: no session → its own redirect, never this route's", async () => {
    requirePayer.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(CapacityPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("reads nothing, in any branch", async () => {
    for (const role of ["employer", "agent"] as const) {
      requirePayer.mockResolvedValue({ ...EMPLOYER, role });
      await expect(CapacityPage()).rejects.toThrow("NEXT_REDIRECT");
    }
    expect(getCapacity).not.toHaveBeenCalled();
    expect(getLiveCatalog).not.toHaveBeenCalled();
  });
});
