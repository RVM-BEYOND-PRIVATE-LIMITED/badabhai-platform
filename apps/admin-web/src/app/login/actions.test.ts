import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import type * as SessionCookieModule from "../../lib/auth/session-cookie";

/**
 * Sign-in Server Actions (ADR-0025 / ADR-0060).
 *
 * The properties that carry real security weight, each asserted directly:
 *
 *  1. **A cookie is written only for a SESSION.** Either first factor may end in a session (the
 *     default, two-step verification starting off) or in "MFA required"; only the session member
 *     writes `bb_admin_token`. A response that says `mfa_required` and also carries a stray token
 *     writes nothing — MFA is never skipped because a field leaked.
 *  2. **No enumeration oracle.** Every failure of a step returns that step's ONE neutral message,
 *     so a caller cannot tell "unknown admin" from "wrong password" from "locked" from "rate
 *     limited".
 *  3. **No secret travels back to the client.** Neither the session token nor the trusted-device
 *     token is ever in an action's return value; the device token goes to its httpOnly cookie
 *     only when the operator asked to trust the device.
 *
 * `adminFetch` is stubbed, but each stubbed response is run through the SCHEMA the action
 * passed — exactly what the real transport does — so the response unions are tested, not
 * bypassed.
 */

const writeAdminToken = vi.fn();
const writeAdminDeviceToken = vi.fn();
const readAdminDeviceToken = vi.fn<() => Promise<string | null>>();
const adminFetch = vi.fn();

vi.mock("../../lib/auth/session-cookie", async (importOriginal) => {
  const real = await importOriginal<typeof SessionCookieModule>();
  return {
    isDeviceTokenShape: real.isDeviceTokenShape,
    writeAdminToken: (...a: unknown[]) => writeAdminToken(...a),
    writeAdminDeviceToken: (...a: unknown[]) => writeAdminDeviceToken(...a),
    readAdminDeviceToken: () => readAdminDeviceToken(),
  };
});

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

/** Answer the next `adminFetch` with `raw`, parsed through the schema the action supplied. */
function respond(raw: unknown) {
  adminFetch.mockImplementationOnce(async (_path: string, opts: { schema?: z.ZodType }) => {
    if (!opts.schema) return undefined;
    const parsed = opts.schema.safeParse(raw);
    // The real transport's behaviour on a shape mismatch.
    if (!parsed.success) throw new FakeRequestError(200);
    return parsed.data;
  });
}

const { passwordLoginAction, requestCodeAction, verifyCodeAction, verifyMfaAction } =
  await import("./actions");
const {
  NEUTRAL_CODE_ERROR,
  NEUTRAL_MFA_ERROR,
  NEUTRAL_PASSWORD_ERROR,
  NEUTRAL_REQUEST_ERROR,
  NEW_PASSWORD_REJECTED_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
} = await import("./messages");
const { PASSWORD_POLICY_ERROR } = await import("../../lib/password-policy");

const SESSION = {
  access_token: "admin-jwt",
  token_type: "Bearer",
  expires_in_seconds: 2592000,
  admin_id: "a-1",
  role: "super_admin",
};
const DEVICE = "d".repeat(43); // 32 bytes, base64url
const ENROLLMENT = { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/x" };

beforeEach(() => {
  writeAdminToken.mockReset();
  writeAdminDeviceToken.mockReset();
  readAdminDeviceToken.mockReset();
  readAdminDeviceToken.mockResolvedValue(null);
  adminFetch.mockReset();
});

const bodyOf = (call = 0) => (adminFetch.mock.calls[call]![1] as { body: Record<string, unknown> }).body;

// ── email + password ────────────────────────────────────────────────────────────────────────

describe("passwordLoginAction — the three outcomes", () => {
  it("a session (2FA off, or a trusted device): writes the cookie and returns no token", async () => {
    respond(SESSION);
    const res = await passwordLoginAction({ email: "Ops@Example.com", password: "hunter22" });
    expect(res).toEqual({ ok: true, next: "signed_in" });
    expect(writeAdminToken).toHaveBeenCalledWith("admin-jwt", 2592000);
    expect(JSON.stringify(res)).not.toContain("admin-jwt");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/login/password",
      expect.objectContaining({ method: "POST", public: true }),
    );
    // The email is normalised; no device token is sent when the browser has none.
    expect(bodyOf()).toEqual({ email: "ops@example.com", password: "hunter22" });
  });

  it("password_change_required: asks for a new password and writes NO cookie", async () => {
    respond({ status: "password_change_required" });
    const res = await passwordLoginAction({ email: "ops@example.com", password: "Temp1234" });
    expect(res).toEqual({ ok: true, next: "change_password" });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("mfa_required: hands over the enrolment material and writes NO cookie", async () => {
    respond({ status: "mfa_required", needs_enrollment: true, enrollment: ENROLLMENT });
    const res = await passwordLoginAction({ email: "ops@example.com", password: "hunter22" });
    expect(res).toEqual({
      ok: true,
      next: "mfa",
      needsEnrollment: true,
      enrollment: { secret: ENROLLMENT.secret, otpauthUri: ENROLLMENT.otpauth_uri },
    });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("mfa_required that ALSO carries a whole session (a backend regression) writes nothing", async () => {
    // Every session field is present, so this would parse as a session too: only the union's
    // ORDER (status-tagged members first) keeps MFA from being skipped.
    respond({ ...SESSION, access_token: "leaked", status: "mfa_required", needs_enrollment: false });
    const res = await passwordLoginAction({ email: "ops@example.com", password: "hunter22" });
    expect(res).toMatchObject({ ok: true, next: "mfa" });
    expect(writeAdminToken).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("leaked");
  });

  it("an unexpected shape is a neutral failure, not a half sign-in", async () => {
    respond({ status: "something_new" });
    const res = await passwordLoginAction({ email: "ops@example.com", password: "hunter22" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_PASSWORD_ERROR });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });
});

describe("passwordLoginAction — the trusted-device token", () => {
  it("sends this browser's device token so a trusted device can skip the code", async () => {
    readAdminDeviceToken.mockResolvedValueOnce(DEVICE);
    respond(SESSION);
    await passwordLoginAction({ email: "ops@example.com", password: "hunter22" });
    expect(bodyOf().device_token).toBe(DEVICE);
  });

  it("sends nothing when there is none — the server simply asks for the code", async () => {
    respond({ status: "mfa_required", needs_enrollment: false });
    await passwordLoginAction({ email: "ops@example.com", password: "hunter22" });
    expect(bodyOf()).not.toHaveProperty("device_token");
  });
});

describe("passwordLoginAction — setting a new password at sign-in", () => {
  it("sends new_password and follows the MFA gate in the same request", async () => {
    respond(SESSION);
    const res = await passwordLoginAction({
      email: "ops@example.com",
      password: "Temp1234",
      newPassword: "MyOwnPass9",
    });
    expect(bodyOf()).toEqual({
      email: "ops@example.com",
      password: "Temp1234",
      new_password: "MyOwnPass9",
    });
    expect(res).toEqual({ ok: true, next: "signed_in" });
  });

  it("a new password that fails the policy is refused WITHOUT calling the API", async () => {
    for (const weak of ["short1", "lettersonly", "1234567890"]) {
      const res = await passwordLoginAction({
        email: "ops@example.com",
        password: "Temp1234",
        newPassword: weak,
      });
      expect(res, weak).toEqual({ ok: false, error: PASSWORD_POLICY_ERROR });
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("a 400 on the change step (re-using the temporary password) says so", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(400));
    const res = await passwordLoginAction({
      email: "ops@example.com",
      password: "Temp1234",
      newPassword: "Temp1234",
    });
    expect(res).toEqual({ ok: false, error: NEW_PASSWORD_REJECTED_ERROR });
  });

  it("being asked AGAIN after supplying one is an error, never a loop", async () => {
    respond({ status: "password_change_required" });
    const res = await passwordLoginAction({
      email: "ops@example.com",
      password: "Temp1234",
      newPassword: "MyOwnPass9",
    });
    expect(res).toEqual({ ok: false, error: NEW_PASSWORD_REJECTED_ERROR });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });
});

describe("passwordLoginAction — no oracle", () => {
  it("malformed input, a 401, a 400 and a 429 all read the same", async () => {
    const malformed = await passwordLoginAction({ email: "not-an-email", password: "x" });
    const empty = await passwordLoginAction({ email: "ops@example.com", password: "" });
    const outcomes = [malformed, empty];
    for (const status of [401, 400, 429]) {
      adminFetch.mockRejectedValueOnce(new FakeRequestError(status));
      outcomes.push(await passwordLoginAction({ email: "ops@example.com", password: "hunter22" }));
    }
    for (const o of outcomes) expect(o).toEqual({ ok: false, error: NEUTRAL_PASSWORD_ERROR });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("only a 5xx or an unreachable API says so", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(503));
    expect(await passwordLoginAction({ email: "ops@example.com", password: "hunter22" })).toEqual({
      ok: false,
      error: SERVICE_UNAVAILABLE_ERROR,
    });
    adminFetch.mockRejectedValueOnce(new FakeRequestError(0));
    expect(await passwordLoginAction({ email: "ops@example.com", password: "hunter22" })).toEqual({
      ok: false,
      error: SERVICE_UNAVAILABLE_ERROR,
    });
  });

  it("a password over 128 characters is not sent", async () => {
    const res = await passwordLoginAction({ email: "ops@example.com", password: "a1".repeat(65) });
    expect(res).toEqual({ ok: false, error: NEUTRAL_PASSWORD_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

// ── email + emailed code ────────────────────────────────────────────────────────────────────

describe("requestCodeAction", () => {
  it("returns the resend window on success and NEVER a code", async () => {
    respond({ status: "code_sent", resend_in_seconds: 30 });
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

describe("verifyCodeAction — mfa_required OR a session (ADR-0060)", () => {
  it("mfa_required: returns MFA state and writes NO cookie", async () => {
    respond({ status: "mfa_required", needs_enrollment: false });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: true, next: "mfa", needsEnrollment: false, enrollment: undefined });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("passes enrolment material through on a first MFA sign-in — and still writes no cookie", async () => {
    respond({ status: "mfa_required", needs_enrollment: true, enrollment: ENROLLMENT });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toMatchObject({
      ok: true,
      next: "mfa",
      needsEnrollment: true,
      enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" },
    });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("a session (2FA off): writes the cookie with the token's own lifetime, returns no token", async () => {
    respond(SESSION);
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: true, next: "signed_in" });
    expect(writeAdminToken).toHaveBeenCalledWith("admin-jwt", 2592000);
    expect(JSON.stringify(res)).not.toContain("admin-jwt");
  });

  it("mfa_required that ALSO carries a whole session (a backend regression) writes none", async () => {
    respond({
      ...SESSION,
      access_token: "should-never-be-used",
      status: "mfa_required",
      needs_enrollment: false,
    });
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res.ok).toBe(true);
    expect(writeAdminToken).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("should-never-be-used");
  });

  it("sends the device token when this browser has one", async () => {
    readAdminDeviceToken.mockResolvedValueOnce(DEVICE);
    respond(SESSION);
    await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(bodyOf()).toEqual({ email: "ops@example.com", code: "123456", device_token: DEVICE });
  });

  it("409 (still on a temporary password) shows the server's own copy, not the neutral one", async () => {
    const conflict = new FakeRequestError(409);
    conflict.message = "Sign in with your password to replace the temporary one first";
    adminFetch.mockRejectedValueOnce(conflict);
    const res = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: false, error: conflict.message });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("a bad code and a rejected code read identically", async () => {
    const malformed = await verifyCodeAction({ email: "ops@example.com", code: "abc" });
    adminFetch.mockRejectedValueOnce(new Error("401"));
    const rejected = await verifyCodeAction({ email: "ops@example.com", code: "123456" });
    expect(malformed).toEqual({ ok: false, error: NEUTRAL_CODE_ERROR });
    expect(rejected).toEqual({ ok: false, error: NEUTRAL_CODE_ERROR });
  });
});

// ── the authenticator code ──────────────────────────────────────────────────────────────────

describe("verifyMfaAction — the session, and the trusted-device cookie", () => {
  it("stores the token with the token's OWN lifetime and returns nothing sensitive", async () => {
    respond(SESSION);
    const res = await verifyMfaAction({ email: "ops@example.com", code: "123456" });
    expect(res).toEqual({ ok: true });
    expect(writeAdminToken).toHaveBeenCalledWith("admin-jwt", 2592000);
    // The token must not travel back to the caller — it lives only in the httpOnly cookie.
    expect(JSON.stringify(res)).not.toContain("admin-jwt");
    // Not trusting the device: the request is exactly the one it always was.
    expect(bodyOf()).toEqual({ email: "ops@example.com", code: "123456" });
    expect(writeAdminDeviceToken).not.toHaveBeenCalled();
  });

  it("trust ticked: asks for a device token and stores it for the server's lifetime — never returns it", async () => {
    respond({ ...SESSION, device_token: DEVICE, device_expires_in_seconds: 2592000 });
    const res = await verifyMfaAction({
      email: "ops@example.com",
      code: "123456",
      trustDevice: true,
    });
    expect(bodyOf()).toEqual({ email: "ops@example.com", code: "123456", trust_device: true });
    expect(writeAdminDeviceToken).toHaveBeenCalledWith(DEVICE, 2592000);
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(res)).not.toContain(DEVICE);
  });

  it("a device token nobody asked for is not kept", async () => {
    respond({ ...SESSION, device_token: DEVICE, device_expires_in_seconds: 2592000 });
    await verifyMfaAction({ email: "ops@example.com", code: "123456" });
    expect(writeAdminDeviceToken).not.toHaveBeenCalled();
  });

  it("trust ticked but the server issued none (feature off): signed in, no device cookie", async () => {
    respond(SESSION);
    const res = await verifyMfaAction({
      email: "ops@example.com",
      code: "123456",
      trustDevice: true,
    });
    expect(res).toEqual({ ok: true });
    expect(writeAdminToken).toHaveBeenCalledTimes(1);
    expect(writeAdminDeviceToken).not.toHaveBeenCalled();
  });

  it("a malformed device token is not stored (the API would refuse it back)", async () => {
    respond({ ...SESSION, device_token: "bad token!", device_expires_in_seconds: 60 });
    await verifyMfaAction({ email: "ops@example.com", code: "123456", trustDevice: true });
    expect(writeAdminDeviceToken).not.toHaveBeenCalled();
  });

  it("rejects a non-6-digit code without calling the API", async () => {
    const res = await verifyMfaAction({ email: "ops@example.com", code: "12345" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_MFA_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("writes NO cookie of either kind when the API rejects the code", async () => {
    adminFetch.mockRejectedValueOnce(new Error("401"));
    const res = await verifyMfaAction({ email: "ops@example.com", code: "123456", trustDevice: true });
    expect(res).toEqual({ ok: false, error: NEUTRAL_MFA_ERROR });
    expect(writeAdminToken).not.toHaveBeenCalled();
    expect(writeAdminDeviceToken).not.toHaveBeenCalled();
  });
});
