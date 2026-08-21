import { describe, it, expect, vi, beforeEach } from "vitest";

/** Force-close (`force_close_posting`). Mocking shape mirrors `login/actions.test.ts`. */

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

const { forceClosePostingAction } = await import("./actions");

beforeEach(() => {
  adminFetch.mockReset();
});

describe("forceClosePostingAction", () => {
  it("POSTs to the close route", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "j-1", changed: true });
    await forceClosePostingAction("j-1");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/job-postings/j-1/close",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a real close reports changed: true with an out-of-feed message", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "j-1", changed: true });
    const res = await forceClosePostingAction("j-1");
    expect(res).toEqual({
      ok: true,
      changed: true,
      message: "Posting force-closed. It is out of the worker feed.",
    });
  });

  it("an already-closed posting is a SUCCESSFUL no-op, never an error", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "j-1", changed: false });
    const res = await forceClosePostingAction("j-1");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });

  it("a 404 surfaces the server's own text", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "Job posting not found"));
    const res = await forceClosePostingAction("missing");
    expect(res).toEqual({ ok: false, error: "Job posting not found" });
  });

  it("a 5xx collapses to the generic message, not whatever the server said", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "stack trace leaked"));
    const res = await forceClosePostingAction("j-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain("stack trace");
  });
});
