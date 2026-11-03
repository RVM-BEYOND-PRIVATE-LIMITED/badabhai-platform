import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin-user lifecycle Server Actions (`manage_admins`).
 *
 * The property that carries the most weight here is the SELF-GUARD one: `changeAdminRoleAction`
 * / `resetAdminMfaAction` / `suspendAdminAction` never decide anything about "is this me" —
 * that is the UI's job (hiding the control on `is_self`), enforced server-side by
 * `AdminActionsService`'s own L1 guards. What THESE tests assert is narrower and just as
 * important: when a 409 from one of those guards is somehow still hit, the operator sees the
 * server's exact rejection text, not a made-up client-side guess.
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

const {
  inviteAdminAction,
  createAdminAction,
  changeAdminRoleAction,
  resetAdminMfaAction,
  suspendAdminAction,
} = await import("./actions");
const { PASSWORD_POLICY_ERROR } = await import("../../../lib/password-policy");

beforeEach(() => {
  adminFetch.mockReset();
});

describe("inviteAdminAction", () => {
  it("POSTs the lower-cased email and role, and reports the new id", async () => {
    adminFetch.mockResolvedValueOnce({ admin_id: "22222222-2222-4222-8222-222222222222" });
    const res = await inviteAdminAction({ email: "Ops@Example.com", role: "analyst" });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/admins",
      expect.objectContaining({
        method: "POST",
        body: { email: "ops@example.com", role: "analyst" },
      }),
    );
    expect(res).toEqual({
      ok: true,
      changed: true,
      message: "Invited 22222222… as Analyst.",
    });
  });

  it("rejects a malformed email WITHOUT calling the API", async () => {
    const res = await inviteAdminAction({ email: "not-an-email", role: "analyst" });
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("surfaces the duplicate-email conflict verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "An admin with that email already exists"),
    );
    const res = await inviteAdminAction({ email: "ops@example.com", role: "support" });
    expect(res).toEqual({ ok: false, error: "An admin with that email already exists" });
  });
});

describe("createAdminAction (ADR-0060 A6)", () => {
  const input = {
    email: "New.Admin@Example.com",
    name: "  Asha Rao  ",
    role: "support" as const,
    temporaryPassword: "Temp1234x",
  };

  it("POSTs email, trimmed name, role and temporary password to /admin/admins/direct", async () => {
    adminFetch.mockResolvedValueOnce({ admin_id: "33333333-3333-4333-8333-333333333333" });
    await createAdminAction(input);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/admins/direct",
      expect.objectContaining({
        method: "POST",
        body: {
          email: "new.admin@example.com",
          name: "Asha Rao",
          role: "support",
          temporary_password: "Temp1234x",
        },
      }),
    );
  });

  it("the result names the new admin and the hand-over — and NEVER echoes the password", async () => {
    adminFetch.mockResolvedValueOnce({ admin_id: "33333333-3333-4333-8333-333333333333" });
    const res = await createAdminAction(input);
    expect(res).toMatchObject({ ok: true, changed: true });
    if (!res.ok) throw new Error("expected success");
    expect(res.message).toContain("Created 33333333… as Support.");
    expect(res.message).toContain("privately");
    expect(res.message).toContain("first sign-in");
    expect(JSON.stringify(res)).not.toContain("Temp1234x");
  });

  it("a weak temporary password is refused before the request, with the policy in words", async () => {
    const res = await createAdminAction({ ...input, temporaryPassword: "password" });
    expect(res).toEqual({ ok: false, error: PASSWORD_POLICY_ERROR });
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("a blank name, a bad email or an unknown role is refused before the request", async () => {
    for (const bad of [
      { ...input, name: "   " },
      { ...input, name: "x".repeat(101) },
      { ...input, email: "nope" },
      { ...input, role: "root" as unknown as "support" },
    ]) {
      const res = await createAdminAction(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).not.toBe(PASSWORD_POLICY_ERROR);
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("surfaces the duplicate-email conflict verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "An admin with that email already exists"),
    );
    const res = await createAdminAction(input);
    expect(res).toEqual({ ok: false, error: "An admin with that email already exists" });
    expect(JSON.stringify(res)).not.toContain("Temp1234x");
  });
});

describe("changeAdminRoleAction", () => {
  it("PATCHes the role and reports a real change", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: true });
    const res = await changeAdminRoleAction("a-2", "ops_admin");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/admins/a-2/role",
      expect.objectContaining({ method: "PATCH", body: { role: "ops_admin" } }),
    );
    expect(res).toEqual({ ok: true, changed: true, message: "Role changed to Ops admin." });
  });

  it("a same-role PATCH is a SUCCESSFUL no-op, not an error", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: false });
    const res = await changeAdminRoleAction("a-2", "analyst");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });

  it("surfaces the self-role-change 409 verbatim (the L1 self-guard)", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "An admin cannot change their own role"),
    );
    const res = await changeAdminRoleAction("a-self", "support");
    expect(res).toEqual({ ok: false, error: "An admin cannot change their own role" });
  });

  it("surfaces the last-active-super_admin 409 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "Cannot demote the last active super_admin"),
    );
    const res = await changeAdminRoleAction("a-3", "analyst");
    expect(res).toEqual({ ok: false, error: "Cannot demote the last active super_admin" });
  });
});

describe("resetAdminMfaAction", () => {
  it("POSTs to the reset route and reports a real reset", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: true });
    const res = await resetAdminMfaAction("a-2");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/admins/a-2/mfa/reset",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: true });
    // "MFA", the word the button, the column and the stat use — not "second factor".
    expect(res).toMatchObject({
      message: "MFA reset. They will enrol a new authenticator at their next sign-in.",
    });
  });

  it("no enrolled factor to clear is a SUCCESSFUL no-op", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: false });
    const res = await resetAdminMfaAction("a-2");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false, message: "No MFA was enrolled — nothing to reset." });
  });

  it("surfaces the self-reset refusal verbatim (refused even for a super_admin)", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(
        409,
        "An admin cannot reset their own second factor; ask another super_admin, or use the break-glass CLI",
      ),
    );
    const res = await resetAdminMfaAction("a-self");
    expect(res).toEqual({
      ok: false,
      error:
        "An admin cannot reset their own second factor; ask another super_admin, or use the break-glass CLI",
    });
  });
});

describe("suspendAdminAction", () => {
  it("POSTs to the suspend route", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: true });
    await suspendAdminAction("a-2");
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/admins/a-2/suspend",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("an already-suspended admin is a SUCCESSFUL no-op", async () => {
    adminFetch.mockResolvedValueOnce({ target_id: "a-2", changed: false });
    const res = await suspendAdminAction("a-2");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ changed: false });
  });

  it("surfaces the self-suspend 409 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "An admin cannot suspend themselves"),
    );
    const res = await suspendAdminAction("a-self");
    expect(res).toEqual({ ok: false, error: "An admin cannot suspend themselves" });
  });

  it("surfaces the last-active-super_admin suspend 409 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "Cannot suspend the last active super_admin"),
    );
    const res = await suspendAdminAction("a-3");
    expect(res).toEqual({ ok: false, error: "Cannot suspend the last active super_admin" });
  });
});
