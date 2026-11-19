import { describe, it, expect, vi, beforeEach } from "vitest";

/** Flag / unflag worker (`flag_worker`). Mocking shape mirrors `login/actions.test.ts`. */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { flagWorkerAction, unflagWorkerAction } = await import("./actions");

beforeEach(() => {
  adminFetch.mockReset();
});

describe("flagWorkerAction", () => {
  it("sends the chosen reason code as the closed CODE, not free text", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "w-1", changed: true });
    await flagWorkerAction("w-1", "abuse_report");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/workers/w-1/flag",
      expect.objectContaining({ method: "POST", body: { reason_code: "abuse_report" } }),
    );
  });

  it("an already-open flag is a SUCCESSFUL no-op", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "w-1", changed: false });
    const res = await flagWorkerAction("w-1", "duplicate");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });

  it("rejects an unrecognised reason code WITHOUT calling the API", async () => {
    // Models a stale client offering a code the server no longer accepts.
    const res = await flagWorkerAction("w-1", "not_a_real_reason" as never);
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("surfaces a 404 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "That record no longer exists. Refresh the page and try again."));
    const res = await flagWorkerAction("missing", "other");
    expect(res).toEqual({ ok: false, error: "That record no longer exists. Refresh the page and try again." });
  });
});

describe("unflagWorkerAction", () => {
  it("POSTs the fixed reason code and the written reason", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "w-1", changed: true });
    await unflagWorkerAction("w-1", "Flag was raised on a mistaken identity, now cleared.");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/workers/w-1/unflag",
      expect.objectContaining({
        method: "POST",
        body: {
          reason_code: "worker_unflag",
          reason_text: "Flag was raised on a mistaken identity, now cleared.",
        },
      }),
    );
  });

  it("refuses a missing or short reason without calling the API", async () => {
    const res = await unflagWorkerAction("w-1", "too short");
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("no open flag to clear is a SUCCESSFUL no-op", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "w-1", changed: false });
    const res = await unflagWorkerAction("w-1", "Flag was raised on a mistaken identity, now cleared.");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });
});
