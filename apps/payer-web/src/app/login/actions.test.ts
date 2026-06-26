import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * LOGIN SERVER ACTIONS (OTP-4 / XB-H) — no-oracle, no-leak mapping.
 *
 * These lock the security-relevant UI contract of step 1 + step 2:
 *  - the code is NEVER returned to the client (no `devOtp` on the result, even if the
 *    seam carries one);
 *  - the send step collapses invalid-email, send-failure, rate-limit/cap, and the
 *    unknown-account path to ONE neutral constant — so the UI is never an enumeration
 *    oracle and never reveals which limit was hit;
 *  - verify keeps its single neutral "invalid or expired code" message for every failure.
 */

const requestCode = vi.fn();
const verifyCode = vi.fn();

vi.mock("../../lib/auth", () => ({
  payerAuth: () => ({ requestCode: (i: unknown) => requestCode(i), verifyCode: (i: unknown) => verifyCode(i) }),
}));

const { requestCodeAction, verifyCodeAction } = await import("./actions");
const { NEUTRAL_SEND_ERROR, NEUTRAL_VERIFY_ERROR } = await import("./messages");

beforeEach(() => {
  requestCode.mockReset();
  verifyCode.mockReset();
});

describe("requestCodeAction — dev code surfacing is gated (mock channel + non-prod only)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("with a REAL provider (no devOtp) the code never reaches the client", async () => {
    requestCode.mockResolvedValue({ ok: true, resendInSeconds: 45 }); // real provider: no devOtp
    const res = await requestCodeAction({ email: "a@b.co" });
    expect(res).toEqual({ ok: true, resendInSeconds: 45 });
    expect("devCode" in res).toBe(false);
  });

  it("in PRODUCTION a leaked devOtp is still NOT surfaced (defense-in-depth)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    requestCode.mockResolvedValue({ ok: true, resendInSeconds: 45, devOtp: "000000" });
    const res = await requestCodeAction({ email: "a@b.co" });
    expect(res).toEqual({ ok: true, resendInSeconds: 45 });
    expect(JSON.stringify(res)).not.toContain("000000");
  });

  it("in DEV, surfaces the mock/console devOtp as devCode so local login is testable", async () => {
    vi.stubEnv("NODE_ENV", "development");
    requestCode.mockResolvedValue({ ok: true, resendInSeconds: 45, devOtp: "000000" });
    const res = await requestCodeAction({ email: "a@b.co" });
    expect(res).toEqual({ ok: true, resendInSeconds: 45, devCode: "000000" });
  });

  it("threads the SERVER resendInSeconds through unchanged (drives the resend cooldown)", async () => {
    requestCode.mockResolvedValue({ ok: true, resendInSeconds: 30 });
    const res = await requestCodeAction({ email: "a@b.co" });
    expect(res.ok && res.resendInSeconds).toBe(30);
  });
});

describe("requestCodeAction — ONE neutral message for every non-success (no oracle)", () => {
  it("an invalid email yields the neutral send error (not a validation oracle)", async () => {
    const res = await requestCodeAction({ email: "not-an-email" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
    // Never reached the seam — and never reveals it was a format problem.
    expect(requestCode).not.toHaveBeenCalled();
  });

  it("a seam failure (send error / rate-limit / cap) yields the SAME neutral error", async () => {
    requestCode.mockResolvedValue({ ok: false, error: "rate_limited: too many requests" });
    const res = await requestCodeAction({ email: "a@b.co" });
    // The raw provider reason is discarded for the single neutral constant.
    expect(res).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
  });

  it("the neutral send error reveals neither account existence nor which limit was hit", () => {
    expect(NEUTRAL_SEND_ERROR).not.toMatch(/unknown|not found|no account|registered|limit|rate|cap|exists/i);
  });
});

describe("verifyCodeAction — single neutral 'invalid or expired code' for every failure", () => {
  it("a malformed code returns the neutral verify message without hitting the seam", async () => {
    const res = await verifyCodeAction({ email: "a@b.co", code: "abc" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    expect(verifyCode).not.toHaveBeenCalled();
  });

  it("a wrong/expired code surfaces the seam's neutral error verbatim (no enumeration)", async () => {
    verifyCode.mockResolvedValue({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    const res = await verifyCodeAction({ email: "a@b.co", code: "123456" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_VERIFY_ERROR });
  });

  it("a correct code succeeds (no token or code echoed back)", async () => {
    verifyCode.mockResolvedValue({ ok: true, session: { payerId: "p", role: "employer", displayLabel: "Co" } });
    const res = await verifyCodeAction({ email: "a@b.co", code: "123456" });
    expect(res).toEqual({ ok: true });
  });
});
