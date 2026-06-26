import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * DEV-ONLY quick-login action tests. The feature is additive + isolated; these lock the
 * security-relevant behavior:
 *  - GATE FIRST (defense-in-depth): with DEV_QUICK_LOGIN off the action throws BEFORE any
 *    backend call — never signs up, never verifies, never redirects (inert in staging/prod);
 *  - HAPPY PATH: drives /payer/signup (public, with the fixed synthetic dev identity — no
 *    real PII), reads the echoed dev_otp, reuses the REAL verifyCode (which sets the real
 *    cookie), then redirects to /dashboard;
 *  - NO CONSOLE OTP: an absent dev_otp throws an actionable error and NEVER verifies/redirects.
 *
 * The signup body asserts the action forwards ONLY {role, email, org_name, phone} for a
 * synthetic dev account and that the call is `public` (no Authorization) — it can never
 * smuggle a payer_id or a secret.
 */

const devQuickLoginEnabled = vi.fn();
const payerFetch = vi.fn();
const verifyCode = vi.fn();
const redirect = vi.fn();

vi.mock("./dev-quick-login-flag", () => ({ devQuickLoginEnabled: () => devQuickLoginEnabled() }));
vi.mock("../../lib/payer-http", () => ({
  payerFetch: (path: string, opts: unknown) => payerFetch(path, opts),
}));
vi.mock("../../lib/auth/http-provider", () => ({
  httpPayerAuthProvider: { verifyCode: (i: unknown) => verifyCode(i) },
}));
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirect(p) }));

const { devQuickLogin } = await import("./dev-quick-login-action");

beforeEach(() => {
  devQuickLoginEnabled.mockReset().mockReturnValue(true);
  payerFetch.mockReset().mockResolvedValue({
    status: "code_sent",
    resend_in_seconds: 30,
    dev_otp: "123456",
  });
  verifyCode.mockReset().mockResolvedValue({
    ok: true,
    session: { payerId: "p", role: "employer", displayLabel: "Dev Co" },
  });
  redirect.mockReset();
});

describe("devQuickLogin — gate FIRST (inert when DEV_QUICK_LOGIN is off)", () => {
  it("throws BEFORE any backend call when the flag is off; no signup / verify / redirect", async () => {
    devQuickLoginEnabled.mockReturnValueOnce(false);
    await expect(devQuickLogin("employer")).rejects.toThrow(/not enabled/i);
    expect(payerFetch).not.toHaveBeenCalled();
    expect(verifyCode).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("devQuickLogin — happy path (real session via the backend dev OTP)", () => {
  it("signs up the fixed synthetic dev identity on a PUBLIC call (no PII, no payer_id)", async () => {
    await devQuickLogin("employer");
    expect(payerFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = payerFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/payer/signup");
    expect(opts.method).toBe("POST");
    expect(opts.public).toBe(true);
    expect(opts.body).toEqual({
      role: "employer",
      email: "dev-employer@badabhai.local",
      org_name: "Dev Co (quick-login)",
      phone: "+919000000001",
    });
  });

  it("reuses the REAL verifyCode with the echoed dev_otp, then redirects to /dashboard", async () => {
    await devQuickLogin("agent");
    expect(verifyCode).toHaveBeenCalledWith({
      email: "dev-agency@badabhai.local",
      code: "123456",
    });
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("uses the agency identity for the agent role", async () => {
    await devQuickLogin("agent");
    const [, opts] = payerFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.body).toEqual({
      role: "agent",
      email: "dev-agency@badabhai.local",
      org_name: "Dev Agency (quick-login)",
      phone: "+919000000002",
    });
  });
});

describe("devQuickLogin — failure modes (never a fake success)", () => {
  it("throws an actionable error and never verifies/redirects when dev_otp is absent", async () => {
    payerFetch.mockResolvedValueOnce({ status: "code_sent", resend_in_seconds: 30 });
    await expect(devQuickLogin("employer")).rejects.toThrow(/console OTP/i);
    expect(verifyCode).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("throws and never redirects when the real verify fails", async () => {
    verifyCode.mockResolvedValueOnce({ ok: false, error: "Invalid or expired code." });
    await expect(devQuickLogin("employer")).rejects.toThrow(/could not establish a session/i);
    expect(redirect).not.toHaveBeenCalled();
  });
});
