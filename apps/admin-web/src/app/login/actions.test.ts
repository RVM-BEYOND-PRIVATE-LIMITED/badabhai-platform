import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Login Server Actions.
 *
 * Two properties carry real security weight and both are asserted directly:
 *
 *  1. **Step 2 never establishes a session.** `verifyCodeAction` must not write a cookie
 *     under any response. If it did, a stolen mailbox would be a full login and MFA would
 *     be decoration.
 *  2. **No enumeration oracle.** Every failure of a step returns that step's ONE neutral
 *     message, so a caller cannot tell "unknown admin" from "wrong code" from "rate
 *     limited".
 */

const writeAdminToken = vi.fn();
const adminFetch = vi.fn();

vi.mock("../../lib/auth/session-cookie", () => ({
  writeAdminToken: (...a: unknown[]) => writeAdminToken(...a),
}));

class FakeRequestError extends Error {
  status: number;
  constructor(status: number) {
    super("boom");
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
}));

const { requestCodeAction, verifyCodeAction, verifyMfaAction } = await import("./actions");
const { NEUTRAL_CODE_ERROR, NEUTRAL_MFA_ERROR, NEUTRAL_REQUEST_ERROR, SERVICE_UNAVAILABLE_ERROR } =
  await import("./messages");

beforeEach(() => {
  writeAdminToken.mockReset();
  adminFetch.mockReset();
});

describe("requestCodeAction", () => {
  it("returns the resend window on success and NEVER a code", async () => {
    adminFetch.mockResolvedValueOnce({ status: "code_sent", resend_in_seconds: 30 });
    const res = await requestCodeAction({ email: "ops@example.com" });
    expect(res).toEqual({ ok: true, resendInSeconds: 30 });
    // The whole response object is inspected: nothing code-shaped may ride along.
    expect(JSON.stringify(res)).not.toMatch(/\d{4,8}/);
  });

  it("a malformed address fails with the SAME copy as a send failure (no oracle)", async () => {
    const bad = await requestCodeAction({ email: "not-an-email" });
    adminFetch.mockRejectedValueOnce(new Error("upstream refused"));
    const failed = await requestCodeAction({ email: "ops@example.com" });
    expect(bad).toEqual({ ok: false, error: NEUTRAL_REQUEST_ERROR });
    expect(failed).toEqual({ ok: false, error: NEUTRAL_REQUEST_ERROR });
  });

  it("does not even call the API for an invalid address", async () => {
    await requestCodeAction({ email: "@@@" });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("distinguishes ONLY 'service down' — a 5xx says so instead of blaming the operator", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(503));
    const res = await requestCodeAction({ email: "ops@example.com" });
    expect(res).toEqual({ ok: false, error: SERVICE_UNAVAILABLE_ERROR });
  });

  it("a 4xx stays neutral — it must not become an enumeration signal", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404));
    const res = await requestCodeAction({ email: "ops@example.com" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_REQUEST_ERROR });
  });
});

describe("verifyCodeAction — the step that must NOT mint a session", () => {
  it("returns MFA state and writes NO cookie", async () => {
    adminFetch.mockResolvedValueOnce({ status: "mfa_required", needs_enrollment: false });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: true, needsEnrollment: false, enrollment: undefined });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("passes enrolment material through on a first login — and still writes no cookie", async () => {
    adminFetch.mockResolvedValueOnce({
      status: "mfa_required",
      needs_enrollment: true,
      enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/x" },
    });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toMatchObject({
      ok: true,
      needsEnrollment: true,
      enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" },
    });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("even if the API wrongly returned a token, no session is written", async () => {
    // Models a backend regression. The schema drops the extra field and the action has no
    // code path to a cookie, so the client cannot be logged in ahead of MFA.
    adminFetch.mockResolvedValueOnce({
      status: "mfa_required",
      needs_enrollment: false,
      access_token: "should-never-be-used",
    });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res.ok).toBe(true);
    expect(writeAdminToken).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("should-never-be-used");
  });

  it("a bad code and a rejected code read identically", async () => {
    const malformed = await verifyCodeAction({ email: "ops@example.com", code: "abc" });
    adminFetch.mockRejectedValueOnce(new Error("401"));
    const rejected = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(malformed).toEqual({ ok: false, error: NEUTRAL_CODE_ERROR });
    expect(rejected).toEqual({ ok: false, error: NEUTRAL_CODE_ERROR });
  });
});

describe("verifyMfaAction — the ONLY place a session is written", () => {
  it("stores the token with the token's OWN lifetime and returns nothing sensitive", async () => {
    adminFetch.mockResolvedValueOnce({
      access_token: "admin-jwt",
      token_type: "Bearer",
      expires_in_seconds: 2592000,
      admin_id: "a-1",
      role: "super_admin",
    });
    const res = await verifyMfaAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: true });
    expect(writeAdminToken).toHaveBeenCalledWith("admin-jwt", 2592000);
    // The token must not travel back to the caller — it lives only in the httpOnly cookie.
    expect(JSON.stringify(res)).not.toContain("admin-jwt");
  });

  it("rejects a non-6-digit code without calling the API", async () => {
    const res = await verifyMfaAction({ email: "ops@example.com", code: "12345" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_MFA_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("writes NO cookie when the API rejects the second factor", async () => {
    adminFetch.mockRejectedValueOnce(new Error("401"));
    const res = await verifyMfaAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_MFA_ERROR });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });
});
