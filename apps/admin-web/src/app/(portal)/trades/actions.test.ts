import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3023 — the trade-release write action. A 4xx is the server refusing a change, so its own
 * message is shown to the signed-in operator; anything else goes through the safe copy. Nothing
 * invalid reaches the network.
 */
const setTradeRelease = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message = "boom") {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../../lib/trade-release", () => ({
  setTradeRelease: (...args: unknown[]) => setTradeRelease(...args),
}));
vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { updateTradeReleaseAction } = await import("./actions");

const ROW = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  department: "production",
  department_label: "Production",
  kind: "shop_floor",
  wave: 1,
  posting_enabled: true,
  form_enabled: false,
  posting_changed_at: "2026-11-23T09:00:00.000Z",
  form_changed_at: null,
  updated_by: "a-1",
  updated_at: "2026-11-23T09:00:00.000Z",
};

beforeEach(() => setTradeRelease.mockReset());

describe("updateTradeReleaseAction", () => {
  it("sends exactly the switch that changed and returns the new row", async () => {
    setTradeRelease.mockResolvedValueOnce(ROW);
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      postingEnabled: true,
    });
    expect(out).toEqual({ ok: true, row: ROW });
    expect(setTradeRelease).toHaveBeenCalledWith("cnc_turner", {
      postingEnabled: true,
    });
  });

  it("shows the server's refusal message and changes nothing", async () => {
    setTradeRelease.mockRejectedValueOnce(
      new FakeRequestError(409, "Wave 1 is frozen for review."),
    );
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      formEnabled: true,
    });
    expect(out).toEqual({ ok: false, error: "Wave 1 is frozen for review." });
  });

  it("does not treat a 5xx body as an operator refusal", async () => {
    setTradeRelease.mockRejectedValueOnce(new FakeRequestError(500, "SQLSTATE 42P01"));
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      formEnabled: true,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).not.toContain("SQLSTATE");
  });

  it("refuses an empty change before it reaches the network", async () => {
    expect(await updateTradeReleaseAction({ roleKind: "cnc_turner" })).toEqual({
      ok: false,
      error: "Choose what to change.",
    });
    expect(await updateTradeReleaseAction({ roleKind: "" , postingEnabled: true })).toMatchObject({
      ok: false,
    });
    expect(setTradeRelease).not.toHaveBeenCalled();
  });
});
