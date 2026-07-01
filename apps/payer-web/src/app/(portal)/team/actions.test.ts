import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TEAM Server Actions — DEFENCE-IN-DEPTH gate + validation + LIVE seam wiring (ADR-0027 / B5.5).
 *
 * The write actions RE-ASSERT requireOwner server-side (a forged Recruiter call gets a neutral 404
 * — the action throws the not-found sentinel); the accept action gates on requirePayer (any
 * logged-in member). Input is validated (a bad email/token never reaches the seam), and no PII is
 * echoed in a result message.
 */

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const requireOwner = vi.fn();
const requirePayer = vi.fn();
const inviteOrgMember = vi.fn();
const removeOrgMember = vi.fn();
const acceptOrgInvite = vi.fn();

vi.mock("../../../lib/auth/org-roles", () => ({ requireOwner: () => requireOwner() }));
vi.mock("../../../lib/auth", () => ({ requirePayer: () => requirePayer() }));
vi.mock("../../../lib/org-members", () => ({
  inviteOrgMember: (i: unknown) => inviteOrgMember(i),
  removeOrgMember: (i: unknown) => removeOrgMember(i),
  acceptOrgInvite: (i: unknown) => acceptOrgInvite(i),
}));

const { inviteMemberAction, removeMemberAction, acceptInviteAction } = await import("./actions");

beforeEach(() => {
  requireOwner.mockReset().mockResolvedValue({ payerId: "p1", displayLabel: "Acme", role: "employer" });
  requirePayer.mockReset().mockResolvedValue({ payerId: "p1", displayLabel: "Acme", role: "employer" });
  inviteOrgMember.mockReset().mockResolvedValue({ ok: true, message: "Invite sent." });
  removeOrgMember.mockReset().mockResolvedValue({ ok: true, message: "Member removed." });
  acceptOrgInvite.mockReset().mockResolvedValue({ ok: true, message: "You've joined the team." });
});

describe("inviteMemberAction — re-gates Owner, validates, then hits the live seam", () => {
  it("THROWS the neutral 404 sentinel when requireOwner rejects (forged Recruiter call)", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(inviteMemberAction({ email: "a@b.example" })).rejects.toBe(NOT_FOUND);
    expect(inviteOrgMember).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with a neutral message and does NOT call the seam", async () => {
    const res = await inviteMemberAction({ email: "not-an-email" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/valid email/i);
    expect(res.message).not.toContain("not-an-email"); // no PII echo
    expect(inviteOrgMember).not.toHaveBeenCalled();
  });

  it("forwards a valid email to the seam and returns its result", async () => {
    const res = await inviteMemberAction({ email: "a@b.example" });
    expect(inviteOrgMember).toHaveBeenCalledWith({ email: "a@b.example" });
    expect(res).toEqual({ ok: true, message: "Invite sent." });
  });
});

describe("removeMemberAction — re-gates Owner, validates id, then hits the seam", () => {
  it("THROWS the neutral 404 sentinel when requireOwner rejects", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(removeMemberAction({ memberId: "m1" })).rejects.toBe(NOT_FOUND);
    expect(removeOrgMember).not.toHaveBeenCalled();
  });

  it("rejects an empty member id without calling the seam", async () => {
    const res = await removeMemberAction({ memberId: "" });
    expect(res.ok).toBe(false);
    expect(removeOrgMember).not.toHaveBeenCalled();
  });

  it("forwards a valid id to the seam and returns its result", async () => {
    const res = await removeMemberAction({ memberId: "mem-1" });
    expect(removeOrgMember).toHaveBeenCalledWith({ memberId: "mem-1" });
    expect(res).toEqual({ ok: true, message: "Member removed." });
  });
});

describe("acceptInviteAction — gates on a logged-in payer, validates the token", () => {
  it("propagates the redirect/throw when requirePayer rejects (no session)", async () => {
    requirePayer.mockRejectedValueOnce(NOT_FOUND);
    await expect(acceptInviteAction({ token: "tok-raw-0123456789abcdef" })).rejects.toBe(NOT_FOUND);
    expect(acceptOrgInvite).not.toHaveBeenCalled();
  });

  it("rejects a too-short token without calling the seam", async () => {
    const res = await acceptInviteAction({ token: "short" });
    expect(res.ok).toBe(false);
    expect(acceptOrgInvite).not.toHaveBeenCalled();
  });

  it("forwards a valid token to the seam and returns its result", async () => {
    const res = await acceptInviteAction({ token: "tok-raw-0123456789abcdef" });
    expect(acceptOrgInvite).toHaveBeenCalledWith({ token: "tok-raw-0123456789abcdef" });
    expect(res).toEqual({ ok: true, message: "You've joined the team." });
  });
});
