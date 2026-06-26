import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * (b)/(d)/(e) Owner-only TEAM Server Actions — DEFENCE-IN-DEPTH gate + validation + stub wiring.
 *
 * Every action RE-ASSERTS requireOwner server-side (a forged Recruiter call gets a neutral 404 —
 * the action throws the not-found sentinel). Input is validated (a bad email never reaches the
 * stub). The data source is the STUB, so a valid call returns its neutral not-available result.
 */

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const requireOwner = vi.fn();
const inviteOrgMember = vi.fn();
const removeOrgMember = vi.fn();

vi.mock("../../../lib/auth/org-roles", () => ({ requireOwner: () => requireOwner() }));
vi.mock("../../../lib/org-members", () => ({
  inviteOrgMember: (i: unknown) => inviteOrgMember(i),
  removeOrgMember: (i: unknown) => removeOrgMember(i),
}));

const { inviteMemberAction, removeMemberAction } = await import("./actions");

beforeEach(() => {
  requireOwner.mockReset().mockResolvedValue({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: "employer",
  });
  inviteOrgMember.mockReset().mockResolvedValue({ ok: false, error: "not available yet" });
  removeOrgMember.mockReset().mockResolvedValue({ ok: false, error: "not available yet" });
});

describe("inviteMemberAction — re-gates Owner, validates, then hits the stub", () => {
  it("THROWS the neutral 404 sentinel when requireOwner rejects (forged Recruiter call)", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(inviteMemberAction({ email: "a@b.example", orgRole: "recruiter" })).rejects.toBe(
      NOT_FOUND,
    );
    // The gate runs BEFORE the stub — a denied caller never reaches the data source.
    expect(inviteOrgMember).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with a neutral message and does NOT call the stub", async () => {
    const res = await inviteMemberAction({ email: "not-an-email", orgRole: "recruiter" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/valid email/i);
    // No PII echo: the offending value is never returned.
    expect(res.message).not.toContain("not-an-email");
    expect(inviteOrgMember).not.toHaveBeenCalled();
  });

  it("rejects an invalid role and does NOT call the stub", async () => {
    const res = await inviteMemberAction({ email: "a@b.example", orgRole: "superadmin" });
    expect(res.ok).toBe(false);
    expect(inviteOrgMember).not.toHaveBeenCalled();
  });

  it("forwards a valid email+role to the stub and returns its neutral result", async () => {
    const res = await inviteMemberAction({ email: "a@b.example", orgRole: "owner" });
    expect(inviteOrgMember).toHaveBeenCalledWith({ email: "a@b.example", orgRole: "owner" });
    expect(res).toEqual({ ok: false, message: "not available yet" });
  });
});

describe("removeMemberAction — re-gates Owner, validates id, then hits the stub", () => {
  it("THROWS the neutral 404 sentinel when requireOwner rejects", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(removeMemberAction({ memberId: "m1" })).rejects.toBe(NOT_FOUND);
    expect(removeOrgMember).not.toHaveBeenCalled();
  });

  it("rejects an empty member id without calling the stub", async () => {
    const res = await removeMemberAction({ memberId: "" });
    expect(res.ok).toBe(false);
    expect(removeOrgMember).not.toHaveBeenCalled();
  });

  it("forwards a valid id to the stub and returns its neutral result", async () => {
    const res = await removeMemberAction({ memberId: "stub-1" });
    expect(removeOrgMember).toHaveBeenCalledWith({ memberId: "stub-1" });
    expect(res).toEqual({ ok: false, message: "not available yet" });
  });
});
