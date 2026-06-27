import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * LOGIN SERVER ACTIONS (OTP-4 / XB-H) — no-oracle, no-leak mapping.
 *
 * These lock the security-relevant UI contract of step 1 + step 2:
 *  - the code is NEVER returned to the client (login is real-OTP only — the result
 *    carries no code field at all);
 *  - the send step collapses invalid-email, send-failure, rate-limit/cap, and the
 *    unknown-account path to ONE neutral constant — so the UI is never an enumeration
 *    oracle and never reveals which limit was hit;
 *  - verify keeps its single neutral "invalid or expired code" message for every failure.
 */

const requestCode = vi.fn();
const verifyCode = vi.fn();
const signup = vi.fn();

vi.mock("../../lib/auth", () => ({
  payerAuth: () => ({
    requestCode: (i: unknown) => requestCode(i),
    verifyCode: (i: unknown) => verifyCode(i),
    signup: (i: unknown) => signup(i),
  }),
}));

const { requestCodeAction, verifyCodeAction, signupAction } = await import("./actions");
const { NEUTRAL_SEND_ERROR, NEUTRAL_VERIFY_ERROR } = await import("./messages");

beforeEach(() => {
  requestCode.mockReset();
  verifyCode.mockReset();
  signup.mockReset();
});

describe("requestCodeAction — the code never reaches the client (real-OTP only)", () => {
  it("a successful send returns ONLY { ok, resendInSeconds } — no code field", async () => {
    requestCode.mockResolvedValue({ ok: true, resendInSeconds: 45 });
    const res = await requestCodeAction({ email: "a@b.co" });
    // toEqual is exact-shape: any code-bearing field would fail this assertion.
    expect(res).toEqual({ ok: true, resendInSeconds: 45 });
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

describe("signupAction — funnels into the SAME OTP step, no enumeration, no code echo", () => {
  it("a valid signup forwards role/org_name/email to the seam and returns ONLY { ok, resendInSeconds }", async () => {
    signup.mockResolvedValue({ ok: true, resendInSeconds: 60 });
    const res = await signupAction({ role: "agent", orgName: "  Acme Staffing  ", email: "A@B.CO" });
    // No code field of any kind reaches the client.
    expect(res).toEqual({ ok: true, resendInSeconds: 60 });
    // org_name is trimmed and email lowercased to match the backend; phone omitted (not supplied).
    expect(signup).toHaveBeenCalledWith({ role: "agent", orgName: "Acme Staffing", email: "a@b.co" });
  });

  it("includes a valid E.164 phone when supplied", async () => {
    signup.mockResolvedValue({ ok: true, resendInSeconds: 30 });
    await signupAction({ role: "employer", orgName: "Acme Tools", email: "a@b.co", phone: "+919876543210" });
    expect(signup).toHaveBeenCalledWith({
      role: "employer",
      orgName: "Acme Tools",
      email: "a@b.co",
      phone: "+919876543210",
    });
  });

  it("an ALREADY-REGISTERED email returns the IDENTICAL neutral result (no 'already exists' oracle)", async () => {
    // The seam is account-state-independent: signup of a known email returns the same
    // success shape as a brand-new one. The action threads it through unchanged.
    signup.mockResolvedValue({ ok: true, resendInSeconds: 60 });
    const fresh = await signupAction({ role: "employer", orgName: "New Co", email: "new@b.co" });
    const known = await signupAction({ role: "employer", orgName: "Known Co", email: "known@b.co" });
    expect(known).toEqual(fresh);
    expect(known).toEqual({ ok: true, resendInSeconds: 60 });
  });

  it("an invalid org_name / email / phone collapses to the SAME neutral send error (no oracle)", async () => {
    const badOrg = await signupAction({ role: "employer", orgName: "   ", email: "a@b.co" });
    expect(badOrg).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
    const badEmail = await signupAction({ role: "employer", orgName: "Co", email: "not-an-email" });
    expect(badEmail).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
    const badPhone = await signupAction({ role: "agent", orgName: "Co", email: "a@b.co", phone: "12345" });
    expect(badPhone).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
    // None reached the seam (and none revealed which field failed).
    expect(signup).not.toHaveBeenCalled();
  });

  it("a seam failure (create/send/limit) yields the SAME neutral send error", async () => {
    signup.mockResolvedValue({ ok: false, error: "rate_limited" });
    const res = await signupAction({ role: "employer", orgName: "Co", email: "a@b.co" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
  });

  it("rejects an unknown role without hitting the seam", async () => {
    // @ts-expect-error — deliberately invalid role to assert the enum gate.
    const res = await signupAction({ role: "admin", orgName: "Co", email: "a@b.co" });
    expect(res).toEqual({ ok: false, error: NEUTRAL_SEND_ERROR });
    expect(signup).not.toHaveBeenCalled();
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
