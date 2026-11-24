import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3023 — every route string lives in lib/trade-release.ts, against the assumed contract in its
 * doc comment. This pins the paths (including the URL-encoded role kind) and the bodies, so the
 * one-file adaptation when #3002 / #3014 merge is a deliberate edit, not a scavenger hunt.
 */
const adminFetch = vi.fn();
vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const { getHeldCampusRoles, getTradeRelease, setTradeRelease } = await import(
  "./trade-release"
);

const ROW = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  department: "production",
  department_label: "Production",
  kind: "shop_floor" as const,
  wave: 1,
  posting_enabled: true,
  form_enabled: false,
  posting_changed_at: "2026-11-23T09:00:00.000Z",
  form_changed_at: null,
  updated_by: "a-1",
  updated_at: "2026-11-23T09:00:00.000Z",
};

beforeEach(() => adminFetch.mockReset());

describe("the trade-release routes", () => {
  it("reads the catalogue, unwrapping `trades`", async () => {
    adminFetch.mockResolvedValueOnce({ trades: [ROW] });
    await expect(getTradeRelease()).resolves.toEqual([ROW]);
    expect(adminFetch).toHaveBeenCalledWith("/admin/trade-release", expect.any(Object));
  });

  it("PUTs one row and URL-encodes the role kind", async () => {
    adminFetch.mockResolvedValueOnce(ROW);
    await expect(
      setTradeRelease("cnc turner/y", { formEnabled: true }),
    ).resolves.toEqual(ROW);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/trade-release/cnc%20turner%2Fy",
      expect.objectContaining({
        method: "PUT",
        body: { form_enabled: true },
        schema: expect.anything(),
      }),
    );
  });

  it("sends only the flag it was given", async () => {
    adminFetch.mockResolvedValueOnce(ROW);
    await setTradeRelease("cnc_turner", { postingEnabled: false });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/trade-release/cnc_turner",
      expect.objectContaining({ body: { posting_enabled: false } }),
    );
  });

  it("reads the held roles from their own route, unwrapping `roles`", async () => {
    adminFetch.mockResolvedValueOnce({ roles: [{ role_label: "CNC Operator", count: 4 }] });
    await expect(getHeldCampusRoles()).resolves.toEqual([
      { role_label: "CNC Operator", count: 4 },
    ]);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/campus-roles/held",
      expect.any(Object),
    );
  });
});
