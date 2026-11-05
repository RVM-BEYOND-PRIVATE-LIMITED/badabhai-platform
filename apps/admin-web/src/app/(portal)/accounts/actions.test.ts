import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Payer login-management Server Actions (#2578, built on #2563).
 *
 * What matters here: every write carries a closed `reason_code` + the operator's 15+ character
 * reason, an owner login gets its role/org_name while a team member gets member_of_org_id, and
 * the temporary password is returned to the caller ONCE (never in the human message).
 */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
  }
}

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { createPayerLoginAction, issueTemporaryPasswordAction, revokePayerPasswordAction } =
  await import("./actions");

const PAYER_ID = "44444444-4444-4444-8444-444444444444";
const REASON = "Caller asked us to create their login on the phone.";

beforeEach(() => {
  adminFetch.mockReset();
});

describe("createPayerLoginAction", () => {
  it("creates a company owner with role employer, the org name and the reason", async () => {
    adminFetch.mockResolvedValueOnce({
      payer_id: PAYER_ID,
      login_id: "Owner@Example.com",
      temporary_password: "Temp1234x",
      must_change_password: true,
    });
    const res = await createPayerLoginAction({
      loginId: "Owner@Example.com",
      type: "company_owner",
      orgName: "Acme Works",
      reason: REASON,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers",
      expect.objectContaining({
        method: "POST",
        body: {
          email: "owner@example.com",
          role: "employer",
          org_name: "Acme Works",
          reason_code: "login_created",
          reason_text: REASON,
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, changed: true, temporaryPassword: "Temp1234x" });
    if (!res.ok) throw new Error("expected success");
    expect(JSON.stringify({ ...res, temporaryPassword: undefined })).not.toContain("Temp1234x");
  });

  it("creates an agency owner with role agent", async () => {
    adminFetch.mockResolvedValueOnce({
      payer_id: PAYER_ID,
      login_id: "+919876543210",
      temporary_password: "Temp1234x",
      must_change_password: true,
    });
    await createPayerLoginAction({
      loginId: "+919876543210",
      type: "agency_owner",
      orgName: "Acme Agency",
      reason: REASON,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers",
      expect.objectContaining({
        body: expect.objectContaining({ phone: "+919876543210", role: "agent" }),
      }),
    );
  });

  it("creates a team member under an existing org", async () => {
    adminFetch.mockResolvedValueOnce({
      payer_id: PAYER_ID,
      login_id: "member@example.com",
      temporary_password: "Temp1234x",
      must_change_password: true,
    });
    await createPayerLoginAction({
      loginId: "member@example.com",
      type: "team_member",
      orgId: "aaaaaaaa-0000-4000-8000-000000000001",
      reason: REASON,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/payers",
      expect.objectContaining({
        body: expect.objectContaining({
          member_of_org_id: "aaaaaaaa-0000-4000-8000-000000000001",
          org_role: "recruiter",
        }),
      }),
    );
  });

  it("refuses a bad login, a missing org or a short reason BEFORE calling the API", async () => {
    for (const bad of [
      { loginId: "not-an-email", type: "company_owner" as const, orgName: "Acme", reason: REASON },
      { loginId: "a@b.co", type: "company_owner" as const, reason: REASON },
      {
        loginId: "a@b.co",
        type: "team_member" as const,
        orgId: "not-a-uuid",
        reason: REASON,
      },
      { loginId: "a@b.co", type: "company_owner" as const, orgName: "Acme", reason: "too short" },
    ]) {
      const res = await createPayerLoginAction(bad);
      expect(res.ok).toBe(false);
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("issueTemporaryPasswordAction", () => {
  it("POSTs the issued reason and returns the password once", async () => {
    adminFetch.mockResolvedValueOnce({
      payer_id: PAYER_ID,
      temporary_password: "Fresh1234",
      must_change_password: true,
    });
    const res = await issueTemporaryPasswordAction(PAYER_ID, REASON);
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/payers/${PAYER_ID}/password/temporary`,
      expect.objectContaining({
        method: "POST",
        body: { reason_code: "password_issued", reason_text: REASON },
      }),
    );
    expect(res).toMatchObject({ ok: true, temporaryPassword: "Fresh1234" });
  });

  it("surfaces the server's refusal verbatim", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "That record no longer exists. Refresh the page and try again."));
    const res = await issueTemporaryPasswordAction(PAYER_ID, REASON);
    expect(res).toEqual({ ok: false, error: "That record no longer exists. Refresh the page and try again." });
  });

  it("refuses a short reason without calling the API", async () => {
    const res = await issueTemporaryPasswordAction(PAYER_ID, "short");
    expect(res).toEqual({ ok: false, error: "Explain the reason in at least 15 characters." });
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("revokePayerPasswordAction", () => {
  it("POSTs the revoked reason and reports the change", async () => {
    adminFetch.mockResolvedValueOnce({ payer_id: PAYER_ID, changed: true });
    const res = await revokePayerPasswordAction(PAYER_ID, REASON);
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/payers/${PAYER_ID}/password/revoke`,
      expect.objectContaining({
        method: "POST",
        body: { reason_code: "password_revoked", reason_text: REASON },
      }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
  });

  it("reports a no-op as a successful no-change", async () => {
    adminFetch.mockResolvedValueOnce({ payer_id: PAYER_ID, changed: false });
    const res = await revokePayerPasswordAction(PAYER_ID, REASON);
    expect(res).toMatchObject({ ok: true, changed: false });
  });
});
