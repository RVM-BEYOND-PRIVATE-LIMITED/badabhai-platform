import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

/**
 * Forgot-password Server Actions (ADR-0060 A4).
 *
 *  1. **A reset never signs anyone in.** No response — not even one that wrongly carried a
 *     token — writes a session cookie; the module has no path to one.
 *  2. **No enumeration oracle.** Each step has ONE neutral failure message: an unknown address,
 *     a wrong code and an expired code read the same.
 *  3. **The policy is checked before the request**, and its message is about the typed value.
 */

const adminFetch = vi.fn();
const writeAdminToken = vi.fn();

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
// Not imported by the module under test — mocked so a regression that starts writing a session
// from here would be SEEN rather than silently hitting `next/headers`.
vi.mock("../../lib/auth/session-cookie", () => ({
  writeAdminToken: (...a: unknown[]) => writeAdminToken(...a),
}));

function respond(raw: unknown) {
  adminFetch.mockImplementationOnce(async (_path: string, opts: { schema?: z.ZodType }) => {
    if (!opts.schema) return undefined;
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) throw new FakeRequestError(200);
    return parsed.data;
  });
}

const { requestResetCodeAction, resetPasswordAction } = await import("./actions");
const { NEUTRAL_RESET_ERROR, NEUTRAL_RESET_REQUEST_ERROR } = await import("./messages");
const { SERVICE_UNAVAILABLE_ERROR } = await import("../login/messages");
const { PASSWORD_POLICY_ERROR } = await import("../../lib/password-policy");

beforeEach(() => {
  adminFetch.mockReset();
  writeAdminToken.mockReset();
});

describe("requestResetCodeAction", () => {
  it("POSTs the normalised email to the public forgot route and returns only the resend window", async () => {
    respond({ status: "code_sent", resend_in_seconds: 45 });
    const res = await requestResetCodeAction({ email: " Ops@Example.com " });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/password/forgot",
      expect.objectContaining({ method: "POST", body: { email: "ops@example.com" }, public: true }),
    );
    expect(res).toEqual({ ok: true, resendInSeconds: 45 });
  });

  it("a malformed address, a 4xx and a 429 all read the same — and the first is never sent", async () => {
    const malformed = await requestResetCodeAction({ email: "nope" });
    expect(adminFetch).not.toHaveBeenCalled();
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404));
    const notFound = await requestResetCodeAction({ email: "ops@example.com" });
    adminFetch.mockRejectedValueOnce(new FakeRequestError(429));
    const limited = await requestResetCodeAction({ email: "ops@example.com" });
    for (const r of [malformed, notFound, limited])
      expect(r).toEqual({ ok: false, error: NEUTRAL_RESET_REQUEST_ERROR });
  });

  it("only an outage says so", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(502));
    expect(await requestResetCodeAction({ email: "ops@example.com" })).toEqual({
      ok: false,
      error: SERVICE_UNAVAILABLE_ERROR,
    });
  });
});

describe("resetPasswordAction", () => {
  const input = { email: "ops@example.com", code: "123456", newPassword: "MyOwnPass9" };

  it("POSTs code + new password, succeeds on password_reset, and signs NOBODY in", async () => {
    respond({ status: "password_reset", next: "sign_in" });
    const res = await resetPasswordAction(input);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/password/reset",
      expect.objectContaining({
        method: "POST",
        public: true,
        body: { email: "ops@example.com", code: "123456", new_password: "MyOwnPass9" },
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(writeAdminToken).not.toHaveBeenCalled();
  });

  it("a response that wrongly carried a token still signs nobody in", async () => {
    respond({ status: "password_reset", next: "sign_in", access_token: "leaked" });
    const res = await resetPasswordAction(input);
    expect(res).toEqual({ ok: true });
    expect(writeAdminToken).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("leaked");
  });

  it("an unexpected success shape is a neutral failure, not a claimed reset", async () => {
    respond({ status: "ok" });
    expect(await resetPasswordAction(input)).toEqual({ ok: false, error: NEUTRAL_RESET_ERROR });
  });

  it("a wrong, expired or unknown code (401) and a malformed one read the same", async () => {
    const malformed = await resetPasswordAction({ ...input, code: "12" });
    const badEmail = await resetPasswordAction({ ...input, email: "x" });
    adminFetch.mockRejectedValueOnce(new FakeRequestError(401));
    const refused = await resetPasswordAction(input);
    for (const r of [malformed, badEmail, refused])
      expect(r).toEqual({ ok: false, error: NEUTRAL_RESET_ERROR });
  });

  it("a weak new password is refused before the request, with the policy in words", async () => {
    const res = await resetPasswordAction({ ...input, newPassword: "password" });
    expect(res).toEqual({ ok: false, error: PASSWORD_POLICY_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("a server-side 400 (policy drift) says the password, not the account, is the problem", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(400));
    expect(await resetPasswordAction(input)).toEqual({ ok: false, error: PASSWORD_POLICY_ERROR });
  });

  it("an outage says so", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(0));
    expect(await resetPasswordAction(input)).toEqual({
      ok: false,
      error: SERVICE_UNAVAILABLE_ERROR,
    });
  });
});
