import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3023 / #3067 — the trade-release write action. It passes BOTH flags on (the API's PUT is
 * strict and needs both). A 4xx is the server refusing a change, so its own message is shown to
 * the signed-in operator; anything else goes through the safe copy. Nothing invalid reaches the
 * network.
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

const RELEASE = {
  role_kind: "cnc_turner",
  posting_enabled: true,
  form_enabled: false,
  updated_by: "a-1",
  updated_at: "2026-11-23T09:00:00.000Z",
};

beforeEach(() => setTradeRelease.mockReset());

describe("updateTradeReleaseAction", () => {
  it("sends both flags and returns the trade's release after the call", async () => {
    setTradeRelease.mockResolvedValueOnce(RELEASE);
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      postingEnabled: true,
      formEnabled: false,
    });
    expect(out).toEqual({ ok: true, release: RELEASE });
    expect(setTradeRelease).toHaveBeenCalledWith("cnc_turner", {
      postingEnabled: true,
      formEnabled: false,
    });
  });

  it("shows the server's refusal message and changes nothing", async () => {
    setTradeRelease.mockRejectedValueOnce(
      new FakeRequestError(409, "Wave 1 is frozen for review."),
    );
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      postingEnabled: false,
      formEnabled: true,
    });
    expect(out).toEqual({ ok: false, error: "Wave 1 is frozen for review." });
  });

  it("does not treat a 5xx body as an operator refusal", async () => {
    setTradeRelease.mockRejectedValueOnce(new FakeRequestError(500, "SQLSTATE 42P01"));
    const out = await updateTradeReleaseAction({
      roleKind: "cnc_turner",
      postingEnabled: false,
      formEnabled: true,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).not.toContain("SQLSTATE");
  });

  it("refuses a change missing a flag before it reaches the network", async () => {
    expect(await updateTradeReleaseAction({ roleKind: "cnc_turner" })).toEqual({
      ok: false,
      error: "Choose what to change.",
    });
    expect(
      await updateTradeReleaseAction({ roleKind: "cnc_turner", postingEnabled: true }),
    ).toEqual({ ok: false, error: "Choose what to change." });
    expect(
      await updateTradeReleaseAction({ roleKind: "", postingEnabled: true, formEnabled: false }),
    ).toMatchObject({ ok: false });
    expect(setTradeRelease).not.toHaveBeenCalled();
  });
});
