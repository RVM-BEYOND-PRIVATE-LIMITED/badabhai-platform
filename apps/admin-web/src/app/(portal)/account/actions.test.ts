import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

/**
 * Account Server Actions (ADR-0060 A2/A5) — the signed-in admin's own password and two-step
 * verification switch.
 *
 *  1. **The password change keeps you signed in.** It invalidates every older session, so the
 *     FRESH session the API returns is written into the cookie — and only on success, and never
 *     returned to the caller.
 *  2. **A 401 is resolved by asking, not guessing.** On these routes a wrong current password /
 *     code is a 401, like a dead session. The action asks `GET /admin/me` (via `currentSession`)
 *     which it was, so a typo is never reported as "your session ended" or vice versa.
 *  3. **No id is ever sent** — every body is the operator's input and nothing else.
 */

const adminFetch = vi.fn();
const writeAdminToken = vi.fn();
const currentSession = vi.fn();

class FakeUnauthorized extends Error {}
class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message = "boom") {
    super(message);
    this.status = status;
  }
}

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminUnauthorized: (e: unknown) => e instanceof FakeUnauthorized,
  isAdminForbidden: () => false,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
}));
vi.mock("../../../lib/auth/session-cookie", () => ({
  writeAdminToken: (...a: unknown[]) => writeAdminToken(...a),
}));
vi.mock("../../../lib/auth/session", () => ({
  currentSession: () => currentSession(),
}));

function respond(raw: unknown) {
  adminFetch.mockImplementationOnce(async (_path: string, opts: { schema?: z.ZodType }) => {
    if (!opts.schema) return undefined;
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) throw new FakeRequestError(200, "The admin API returned an unexpected shape.");
    return parsed.data;
  });
}

const { setOwnPasswordAction, enableMfaAction, confirmMfaAction, disableMfaAction } = await import(
  "./actions"
);
const { WRONG_AUTHENTICATOR_CODE, WRONG_CURRENT_PASSWORD, CODE_SHAPE_ERROR } = await import(
  "./messages"
);
const { PASSWORD_POLICY_ERROR } = await import("../../../lib/password-policy");

const SESSION_ENDED = "Your session has ended. Reload the page and sign in again.";
const FRESH = {
  access_token: "fresh-jwt",
  token_type: "Bearer",
  expires_in_seconds: 2592000,
  admin_id: "a-1",
  role: "ops_admin",
};

beforeEach(() => {
  adminFetch.mockReset();
  writeAdminToken.mockReset();
  currentSession.mockReset();
  currentSession.mockResolvedValue({ adminId: "a-1", role: "ops_admin", capabilities: [] });
});

const bodyOf = () => (adminFetch.mock.calls[0]![1] as { body: unknown }).body;

describe("setOwnPasswordAction", () => {
  it("first password: sends only new_password and writes the FRESH session", async () => {
    respond(FRESH);
    const res = await setOwnPasswordAction({ newPassword: "MyOwnPass9" });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/me/password",
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf()).toEqual({ new_password: "MyOwnPass9" });
    expect(writeAdminToken).toHaveBeenCalledWith("fresh-jwt", 2592000);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(JSON.stringify(res)).not.toContain("fresh-jwt");
    expect(JSON.stringify(res)).not.toContain("MyOwnPass9");
  });

  it("change: sends the current password too", async () => {
    respond(FRESH);
    await setOwnPasswordAction({ currentPassword: "OldPass123", newPassword: "MyOwnPass9" });
    expect(bodyOf()).toEqual({ current_password: "OldPass123", new_password: "MyOwnPass9" });
  });

  it("an empty current password is omitted, never sent as an empty string", async () => {
    respond(FRESH);
    await setOwnPasswordAction({ currentPassword: "", newPassword: "MyOwnPass9" });
    expect(bodyOf()).toEqual({ new_password: "MyOwnPass9" });
  });

  it("a weak new password is refused before the request", async () => {
    const res = await setOwnPasswordAction({ newPassword: "abcdefgh" });
    expect(res).toEqual({ ok: false, error: PASSWORD_POLICY_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("a response that is not a session writes no cookie (and the old one stays)", async () => {
    respond({ ok: true });
    const res = await setOwnPasswordAction({ newPassword: "MyOwnPass9" });
    expect(res.ok).toBe(false);
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("401 with the session still alive ⇒ the CURRENT PASSWORD was wrong", async () => {
    adminFetch.mockRejectedValueOnce(new FakeUnauthorized());
    const res = await setOwnPasswordAction({ currentPassword: "nope", newPassword: "MyOwnPass9" });
    expect(currentSession).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, error: WRONG_CURRENT_PASSWORD });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("401 with the session gone ⇒ the session ended, not a wrong password", async () => {
    currentSession.mockResolvedValueOnce(null);
    adminFetch.mockRejectedValueOnce(new FakeUnauthorized());
    const res = await setOwnPasswordAction({ currentPassword: "OldPass123", newPassword: "MyOwnPass9" });
    expect(res).toEqual({ ok: false, error: SESSION_ENDED });
  });

  it("a 400 shows the server's own reason (a policy it holds and this build does not)", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(400, "Password is too common"));
    const res = await setOwnPasswordAction({ newPassword: "MyOwnPass9" });
    expect(res).toEqual({ ok: false, error: "Password is too common" });
    expect(currentSession).not.toHaveBeenCalled();
  });
});

describe("enableMfaAction", () => {
  it("returns the fresh enrolment material, camel-cased", async () => {
    respond({ enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/x" } });
    const res = await enableMfaAction();
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/me/mfa/enable",
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(res).toEqual({
      ok: true,
      enrollment: { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" },
    });
  });

  it("409 (already on) carries the server's reason", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "Two-step verification is already on"),
    );
    expect(await enableMfaAction()).toEqual({
      ok: false,
      error: "Two-step verification is already on",
    });
  });

  it("an enrolment without a secret is refused rather than drawing an empty QR code", async () => {
    respond({ enrollment: { otpauth_uri: "otpauth://totp/x" } });
    expect((await enableMfaAction()).ok).toBe(false);
  });
});

describe("confirmMfaAction / disableMfaAction", () => {
  it("confirm: sends the 6-digit code and succeeds only on mfa_enabled: true", async () => {
    respond({ mfa_enabled: true });
    const res = await confirmMfaAction({ code: "123456" });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/me/mfa/confirm",
      expect.objectContaining({ method: "POST", body: { code: "123456" } }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
  });

  it("confirm: a server that answers mfa_enabled: false is NOT reported as on", async () => {
    respond({ mfa_enabled: false });
    expect((await confirmMfaAction({ code: "123456" })).ok).toBe(false);
  });

  it("disable: sends the code and succeeds only on mfa_enabled: false", async () => {
    respond({ mfa_enabled: false });
    const res = await disableMfaAction({ code: "654321" });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/me/mfa/disable",
      expect.objectContaining({ method: "POST", body: { code: "654321" } }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
  });

  it("a code that is not 6 digits is refused before the request", async () => {
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      expect(await confirmMfaAction({ code })).toEqual({ ok: false, error: CODE_SHAPE_ERROR });
      expect(await disableMfaAction({ code })).toEqual({ ok: false, error: CODE_SHAPE_ERROR });
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("401 with a live session ⇒ wrong code; with a dead one ⇒ session ended", async () => {
    adminFetch.mockRejectedValueOnce(new FakeUnauthorized());
    expect(await confirmMfaAction({ code: "123456" })).toEqual({
      ok: false,
      error: WRONG_AUTHENTICATOR_CODE,
    });
    currentSession.mockResolvedValueOnce(null);
    adminFetch.mockRejectedValueOnce(new FakeUnauthorized());
    expect(await disableMfaAction({ code: "123456" })).toEqual({ ok: false, error: SESSION_ENDED });
  });

  it("409 (already off) carries the server's reason", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(409, "Two-step verification is already off"));
    expect(await disableMfaAction({ code: "123456" })).toEqual({
      ok: false,
      error: "Two-step verification is already off",
    });
  });
});
