import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRADE_CATALOGUE } from "@badabhai/taxonomy";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";

/**
 * #3023 / #3067 — the trade-release routes against the REAL API contract (#3002, #3014): the
 * list unwraps `releases` and joins each row to the trade catalogue by `role_kind`; a change is
 * ONE `PUT /admin/trade-release` carrying `role_kind` and BOTH flags; the held roles keep their
 * own route.
 */
const adminFetch = vi.fn();
vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const { UNCATALOGUED_DEPARTMENT, getHeldCampusRoles, getTradeCatalogue, getTradeRelease, setTradeRelease } =
  await import("./trade-release");

const RELEASE = {
  role_kind: "cnc_turner",
  posting_enabled: true,
  form_enabled: false,
  updated_by: "a-1",
  updated_at: "2026-11-23T09:00:00.000Z",
};

const off = (roleKind: string) => ({
  role_kind: roleKind,
  posting_enabled: false,
  form_enabled: false,
  updated_by: null,
  updated_at: null,
});

beforeEach(() => adminFetch.mockReset());

describe("the trade-release list", () => {
  it("reads `releases` and takes name, department, kind and wave from the catalogue", async () => {
    adminFetch.mockResolvedValueOnce({ releases: [RELEASE] });
    await expect(getTradeRelease()).resolves.toEqual([
      {
        role_kind: "cnc_turner",
        role_label: "CNC Turner",
        department: "Machining",
        kind: "shop_floor",
        wave: 0,
        release: RELEASE,
      },
    ]);
    expect(adminFetch).toHaveBeenCalledWith("/admin/trade-release", expect.any(Object));
  });

  it("lists every declared kind in catalogue order, with the uncatalogued ones last", async () => {
    adminFetch.mockResolvedValueOnce({ releases: TRADE_FORM_KINDS_ALL.map(off) });
    const rows = await getTradeRelease();
    expect(rows).toHaveLength(TRADE_FORM_KINDS_ALL.length);
    const catalogued = rows.filter((r) => r.department !== UNCATALOGUED_DEPARTMENT);
    expect(catalogued.map((r) => r.role_kind)).toEqual(
      TRADE_CATALOGUE.map((e) => e.roleKind).filter((k) =>
        (TRADE_FORM_KINDS_ALL as readonly string[]).includes(k),
      ),
    );
    const rest = rows.slice(catalogued.length);
    expect(rest.every((r) => r.department === UNCATALOGUED_DEPARTMENT && r.kind === null)).toBe(true);
    expect(rows.every((r) => r.role_label && r.role_label !== r.role_kind)).toBe(true);
  });

  it("the catalogue alone carries no switches and makes no request", () => {
    const rows = getTradeCatalogue();
    expect(rows).toHaveLength(TRADE_FORM_KINDS_ALL.length);
    expect(rows.every((r) => r.release === null)).toBe(true);
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("a change", () => {
  it("PUTs /admin/trade-release with role_kind and both flags, and returns `release`", async () => {
    adminFetch.mockResolvedValueOnce({ changed: true, release: RELEASE });
    await expect(
      setTradeRelease("cnc_turner", { postingEnabled: true, formEnabled: false }),
    ).resolves.toEqual(RELEASE);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/trade-release",
      expect.objectContaining({
        method: "PUT",
        body: { role_kind: "cnc_turner", posting_enabled: true, form_enabled: false },
        schema: expect.anything(),
      }),
    );
  });
});

describe("the held roles", () => {
  it("reads them from their own route, unwrapping `roles`", async () => {
    adminFetch.mockResolvedValueOnce({ roles: [{ role_label: "CNC Operator", count: 4 }] });
    await expect(getHeldCampusRoles()).resolves.toEqual([
      { role_label: "CNC Operator", count: 4 },
    ]);
    expect(adminFetch).toHaveBeenCalledWith("/admin/campus-roles/held", expect.any(Object));
  });
});
