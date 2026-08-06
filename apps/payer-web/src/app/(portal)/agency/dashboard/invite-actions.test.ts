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

  // THE PARITY FIX (2026-07-31). The screen used to be a local PHONE_OR_EMAIL regex mirroring
  // `looksLikePii`, which catches ONLY email shapes and digit runs — so a worker's NAME passed
  // every screen and landed in `agency_invites.campaign` AND the `agency_invite.created`
  // payload, an invariant-#2 sink. The client now shares `looksLikeActionContextPii` with the
  // backend DTO. This test FAILS against the old regex.
  it("rejects a campaign tag that is a person's NAME, without minting (invariant #2 sink)", async () => {
    const res = await createInviteAction({ campaign: "Ramesh Kumar" });
    expect(res.ok).toBe(false);
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

describe("createInviteAction — W1 link metadata", () => {
  /**
   * The CLOSED ALLOWLIST of everything this action may forward. Widening it is the
   * reviewable moment: it is the assertion that fires if a per-worker field is ever added
   * to a faceless mint.
   */
  const ALLOWED_BODY_KEYS = ["campaign", "context", "medium"];

  it("forwards a valid medium and context, and nothing else", async () => {
    createAgencyInvite.mockResolvedValueOnce({ ok: true, code: "c", link: "/i/c" });
    await createInviteAction({
      campaign: "diwali-drive",
      medium: "paid",
      context: { role: "welder", city: "pune-west" },
    });
    const body = createAgencyInvite.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(ALLOWED_BODY_KEYS);
    expect(body.medium).toBe("paid");
    expect(body.context).toEqual({ role: "welder", city: "pune-west" });
    // The context object is the one place a per-person field could hide.
    expect(Object.keys(body.context as object).sort()).toEqual(["city", "role"]);
    for (const value of Object.values(body)) expect(Array.isArray(value)).toBe(false);
  });

  it("mints exactly as it did before W1 when no metadata is supplied", async () => {
    createAgencyInvite.mockResolvedValueOnce({ ok: true, code: "c", link: "/i/c" });
    await createInviteAction({ campaign: "diwali-drive" });
    const body = createAgencyInvite.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.medium).toBeUndefined();
    expect(body.context).toBeUndefined();
  });

  it("REFUSES a context key outside {role, city} — never a silent strip", async () => {
    const res = await createInviteAction({
      context: { name: "Ramesh Kumar", phone: "+919812345678" },
    } as unknown as { context: { role?: string } });
    expect(res.ok).toBe(false);
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });

  it("REFUSES a context value that is a person's name, without minting", async () => {
    const res = await createInviteAction({ context: { role: "Ramesh Kumar" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/slug/i);
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });

  it("REFUSES an unknown medium rather than letting the DB CHECK reject it", async () => {
    const res = await createInviteAction({ medium: "sms-blast" });
    expect(res.ok).toBe(false);
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });

  it("runs the role gate BEFORE any metadata is looked at", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(createInviteAction({ context: { role: "Ramesh Kumar" } })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(createAgencyInvite).not.toHaveBeenCalled();
  });
});
