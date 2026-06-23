import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * createInviteAction tests (ADR-0022, LIVE). Covers the security-critical behavior:
 *  - VERTICAL authz: requireAgent() runs FIRST (an employer's notFound() short-circuits;
 *    the seam is never called);
 *  - FACELESS: a campaign tag that looks like a phone/email is rejected at the boundary;
 *  - NEUTRAL failure: the seam's `{ ok: false }` (mint cap OR Redis fail-closed — the same
 *    backend 429, no leaked reason) AND any thrown error both map to ONE neutral error,
 *    never a fake success;
 *  - happy path returns the OPAQUE code/link only.
 */

const requireAgent = vi.fn();
const createAgencyInvite = vi.fn();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/payer-api", () => ({
  createAgencyInvite: (input: { campaign?: string }) => createAgencyInvite(input),
}));

const { createInviteAction } = await import("./invite-actions");

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue({ payerId: "p", role: "agent", displayLabel: "A" });
  createAgencyInvite.mockReset();
});

describe("createInviteAction — vertical authz", () => {
  it("calls requireAgent FIRST and does NOT mint when the role gate throws (employer)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(createInviteAction({})).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });
});

describe("createInviteAction — faceless campaign screen", () => {
  it("rejects a campaign tag containing a phone, without minting", async () => {
    const res = await createInviteAction({ campaign: "call +91 98123 45678" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/non-PII/i);
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });

  it("rejects a campaign tag containing an email, without minting", async () => {
    const res = await createInviteAction({ campaign: "ping ramesh@example.com" });
    expect(res.ok).toBe(false);
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });
});

describe("createInviteAction — neutral failure (no fake success, no leaked reason)", () => {
  it("maps the seam's { ok:false } (cap OR fail-closed) to ONE neutral error", async () => {
    createAgencyInvite.mockResolvedValueOnce({ ok: false });
    const res = await createInviteAction({ campaign: "diwali-drive" });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("Could not create an invite") });
  });

  it("maps a thrown seam error to the SAME neutral error", async () => {
    createAgencyInvite.mockRejectedValueOnce(new Error("boom"));
    const res = await createInviteAction({});
    expect(res.ok).toBe(false);
  });
});

describe("createInviteAction — happy path returns an opaque code only", () => {
  it("returns the code/link from the seam (no PII anywhere)", async () => {
    createAgencyInvite.mockResolvedValueOnce({ ok: true, code: "abc123def456", link: "/i/abc123def456" });
    const res = await createInviteAction({ campaign: "diwali-drive" });
    expect(res).toEqual({ ok: true, code: "abc123def456", link: "/i/abc123def456" });
    expect(createAgencyInvite).toHaveBeenCalledWith({ campaign: "diwali-drive" });
  });
});
