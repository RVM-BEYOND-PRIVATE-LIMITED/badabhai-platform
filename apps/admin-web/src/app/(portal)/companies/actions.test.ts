import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Company record writes (A9, #2579; API #2564).
 *
 * Every write must carry the operator's closed reason code and written reason, a PATCH must send
 * only the changed fields, and create must return the first login's temporary password exactly
 * once (never inside the human message).
 */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
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

const {
  archiveCompanyAction,
  createCompanyAction,
  restoreCompanyAction,
  updateCompanyAction,
} = await import("./actions");

const ID = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";
const REASON = "The client called support to correct their company record.";

beforeEach(() => {
  adminFetch.mockReset();
});

describe("createCompanyAction", () => {
  it("creates the company and its first login with the reason and profile", async () => {
    adminFetch.mockResolvedValueOnce({
      company_id: ID,
      login: {
        payer_id: ID,
        login_id: "owner@example.com",
        temporary_password: "Temp1234x",
        must_change_password: true,
      },
    });
    const res = await createCompanyAction({
      kind: "employer",
      orgName: "Acme Works",
      email: "Owner@Example.com",
      reasonCode: "client_request",
      reasonText: REASON,
      profile: { gst_number: "27aapfu0939f1zv", company_size: "11-50" },
    });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/companies",
      expect.objectContaining({
        method: "POST",
        body: {
          kind: "employer",
          org_name: "Acme Works",
          email: "owner@example.com",
          reason_code: "client_request",
          reason_text: REASON,
          profile: { gst_number: "27AAPFU0939F1ZV", company_size: "11-50" },
        },
      }),
    );
    expect(res).toMatchObject({
      ok: true,
      changed: true,
      companyId: ID,
      loginId: "owner@example.com",
      temporaryPassword: "Temp1234x",
    });
    if (!res.ok) throw new Error("expected success");
    expect(JSON.stringify({ ...res, temporaryPassword: undefined })).not.toContain("Temp1234x");
  });

  it("refuses a missing login or a short reason before calling the API", async () => {
    for (const input of [
      {
        kind: "employer" as const,
        orgName: "Acme",
        reasonCode: "client_request" as const,
        reasonText: REASON,
      },
      {
        kind: "employer" as const,
        orgName: "",
        email: "a@b.co",
        reasonCode: "client_request" as const,
        reasonText: REASON,
      },
      {
        kind: "employer" as const,
        orgName: "Acme",
        email: "a@b.co",
        reasonCode: "client_request" as const,
        reasonText: "short",
      },
    ]) {
      const res = await createCompanyAction(input);
      expect(res.ok).toBe(false);
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("updateCompanyAction", () => {
  it("PATCHes only the changed fields with the reason", async () => {
    adminFetch.mockResolvedValueOnce({ company_id: ID, changed: true });
    const res = await updateCompanyAction(
      ID,
      {
        org_name: "Acme Works Pvt Ltd",
        gst_number: null,
        hiring_locations: ["Pune", "Nashik"],
      },
      { reasonCode: "details_corrected", reasonText: REASON },
    );
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/companies/${ID}`,
      expect.objectContaining({
        method: "PATCH",
        body: {
          reason_code: "details_corrected",
          reason_text: REASON,
          changes: {
            org_name: "Acme Works Pvt Ltd",
            gst_number: null,
            hiring_locations: ["Pune", "Nashik"],
          },
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, changed: true, companyId: ID });
  });

  it("refuses an empty change set and a short reason without a request", async () => {
    expect(
      (await updateCompanyAction(ID, {}, { reasonCode: "other", reasonText: REASON })).ok,
    ).toBe(false);
    expect(
      (
        await updateCompanyAction(
          ID,
          { org_name: "Acme" },
          { reasonCode: "other", reasonText: "short" },
        )
      ).ok,
    ).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe("archive / restore", () => {
  it("POSTs the archive reason and reports the cascade", async () => {
    adminFetch.mockResolvedValueOnce({ company_id: ID, changed: true });
    const res = await archiveCompanyAction(ID, {
      reasonCode: "policy_violation",
      reasonText: REASON,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/companies/${ID}/archive`,
      expect.objectContaining({
        method: "POST",
        body: { reason_code: "policy_violation", reason_text: REASON },
      }),
    );
    expect(res).toMatchObject({ ok: true, changed: true });
    if (res.ok) expect(res.message).toContain("archived");
  });

  it("POSTs the restore reason and reports the idempotent no-op honestly", async () => {
    adminFetch.mockResolvedValueOnce({ company_id: ID, changed: false });
    const res = await restoreCompanyAction(ID, {
      reasonCode: "archived_in_error",
      reasonText: REASON,
    });
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/companies/${ID}/restore`,
      expect.objectContaining({
        body: { reason_code: "archived_in_error", reason_text: REASON },
      }),
    );
    expect(res).toMatchObject({ ok: true, changed: false });
    if (res.ok) expect(res.message).toContain("Not archived");
  });
});
