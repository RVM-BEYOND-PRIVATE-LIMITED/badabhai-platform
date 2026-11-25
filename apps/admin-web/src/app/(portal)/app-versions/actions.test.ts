import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3058 — the App versions save. The PUT body carries EVERY field with the row's message_key
 * unchanged; nothing invalid reaches the network; a 503 is the pending migration; another 4xx is
 * the server's own refusal; a 5xx or a transport failure is the safe copy.
 */
const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message = "boom", body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { saveAppReleasePolicyAction } = await import("./actions");
const { SERVICE_UNAVAILABLE } = await import("../../../lib/admin-action-messages");

const BODY = {
  app: "worker",
  platform: "android",
  min_supported_build: 50,
  latest_build: 52,
  store_url: "https://play.google.com/store/apps/details?id=x",
  message_key: "update_default",
} as const;

const ROW = {
  ...BODY,
  updated_by: "a-1",
  updated_at: "2026-11-25T05:00:00.000Z",
};

beforeEach(() => adminFetch.mockReset());

describe("saveAppReleasePolicyAction", () => {
  it("PUTs every field, message_key unchanged, and returns the new row", async () => {
    adminFetch.mockResolvedValueOnce({ changed: true, policy: ROW });
    const result = await saveAppReleasePolicyAction({ ...BODY, message_key: "update_soon" });

    const [path, opts] = adminFetch.mock.calls[0]! as [
      string,
      { method: string; body: Record<string, unknown> },
    ];
    expect(path).toBe("/admin/app-release-policy");
    expect(opts.method).toBe("PUT");
    expect(opts.body).toEqual({ ...BODY, message_key: "update_soon" });
    expect(Object.keys(opts.body).sort()).toEqual([
      "app",
      "latest_build",
      "message_key",
      "min_supported_build",
      "platform",
      "store_url",
    ]);
    expect(result).toEqual({ ok: true, changed: true, policy: ROW });
  });

  it("sends an empty link as null, not as a missing key", async () => {
    adminFetch.mockResolvedValueOnce({ changed: false, policy: { ...ROW, store_url: null } });
    const result = await saveAppReleasePolicyAction({ ...BODY, store_url: null });
    const [, opts] = adminFetch.mock.calls[0]! as [string, { body: Record<string, unknown> }];
    expect(opts.body).toHaveProperty("store_url", null);
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it("refuses an invalid body before it reaches the network", async () => {
    for (const over of [
      { latest_build: 49 },
      { min_supported_build: -1 },
      { latest_build: 1.5 },
      { store_url: "http://example.com" },
      { store_url: "" },
      { admin_id: "x" },
    ]) {
      const result = await saveAppReleasePolicyAction({ ...BODY, ...over });
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.kind).toBe("validation");
    }
    const { message_key: _dropped, ...missing } = BODY;
    expect((await saveAppReleasePolicyAction(missing)).ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("places a latest-below-minimum refusal on the latest field", async () => {
    const result = await saveAppReleasePolicyAction({ ...BODY, latest_build: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.latest_build).toBe(
        "The latest build must be at least the minimum build.",
      );
    }
  });

  it("a 503 says the database step is pending", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(503, "Service Unavailable"));
    expect(await saveAppReleasePolicyAction(BODY)).toEqual({
      ok: false,
      kind: "not_ready",
      error: "Not available yet: the database step is pending.",
    });
  });

  it("another 4xx is the server's own message", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "app_release_policy row missing"));
    expect(await saveAppReleasePolicyAction(BODY)).toEqual({
      ok: false,
      kind: "refused",
      error: "app_release_policy row missing",
    });
  });

  it("a 400's issues land on their fields, beside the server's message", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(400, "Validation failed", {
        issues: [{ path: "store_url", message: "Invalid string: must match pattern" }],
      }),
    );
    const result = await saveAppReleasePolicyAction(BODY);
    expect(result).toEqual({
      ok: false,
      kind: "refused",
      error: "Validation failed",
      fieldErrors: { store_url: "Enter a full link that starts with https:// and has no spaces." },
    });
  });

  it("a 5xx or an unreachable API gets the safe copy, never the wire text", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "SQLSTATE 42P01"));
    expect(await saveAppReleasePolicyAction(BODY)).toEqual({
      ok: false,
      kind: "error",
      error: SERVICE_UNAVAILABLE,
    });
    adminFetch.mockRejectedValueOnce(new FakeRequestError(0, "The admin API is unreachable."));
    const unreachable = await saveAppReleasePolicyAction(BODY);
    expect(unreachable).toMatchObject({ ok: false, kind: "error" });
    expect(!unreachable.ok && unreachable.error).not.toContain("SQLSTATE");
  });
});
