import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CREDIT TOP-UP Server Action — AUTHORIZATION regression tests (#463 / TD79).
 *
 * The bug these lock down: `topUpAction` shipped with NO gate. The Credits PAGE is
 * `requireOwner()`-gated and the nav hides /credits from a Recruiter, but a Next.js Server
 * Action is an independently invocable POST endpoint — so a Recruiter in the org could replay
 * the panel's request and grant themselves credits while the UI claimed billing was Owner-only.
 *
 * What is asserted:
 *  - GATE FIRST: requireOwner() runs BEFORE the pack check and BEFORE the `topUp` seam — proven
 *    by a call-ORDER recorder, not just by "topUp was not called" (a gate that grants first and
 *    refuses after is not a gate);
 *  - NEUTRAL refusal (no-oracle): the refusal is the bare not-found sentinel requireOwner()
 *    throws — it names no role, no deny cause, and is IDENTICAL for a valid and an unknown pack,
 *    so a refused caller cannot use the action as a pack/org/role oracle;
 *  - the Owner path is unchanged (pack CODE only forwarded — XT5/XB-A: never a payer_id/price);
 *  - every failure copy stays generic and PII-free.
 *
 * The gate's own logic (dev-only Owner override, fail-closed to `recruiter`) is tested in
 * lib/auth/org-roles.test.ts; here it is mocked so the ACTION's ordering is the thing under test.
 */

// The sentinel Next throws from notFound(): a NEUTRAL 404, the same answer a caller gets for a
// route that does not exist. Not a "forbidden" — that is the point (org-roles.ts).
const NOT_FOUND = new Error("NEXT_NOT_FOUND");

/** Call-order log — the only way to prove the gate precedes the grant. */
const calls: string[] = [];

const requireOwner = vi.fn();
const topUp = vi.fn();

vi.mock("../../../lib/auth/org-roles", () => ({
  requireOwner: () => {
    calls.push("requireOwner");
    return requireOwner();
  },
}));
vi.mock("../../../lib/payer-api", () => ({
  topUp: (i: { packCode: string }) => {
    calls.push("topUp");
    return topUp(i);
  },
}));

const { topUpAction } = await import("./actions");

const OWNER = { payerId: "p1", role: "employer" as const, displayLabel: "Acme" };

beforeEach(() => {
  calls.length = 0;
  requireOwner.mockReset().mockResolvedValue(OWNER);
  topUp.mockReset().mockResolvedValue({
    payerId: "p1",
    balance: 60,
    creditsAdded: 50,
    packCode: "pack_50",
    realCall: false,
  });
});

describe("topUpAction — gate FIRST (#463: no credit may be granted before authorization)", () => {
  it("calls requireOwner() BEFORE the seam on the happy path (order, not just presence)", async () => {
    await topUpAction({ packCode: "pack_50" });
    expect(calls).toEqual(["requireOwner", "topUp"]);
  });

  it("a non-Owner is refused and the seam is NEVER reached — no credit is granted", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(topUpAction({ packCode: "pack_50" })).rejects.toBe(NOT_FOUND);
    expect(topUp).not.toHaveBeenCalled();
    // The gate is the FIRST thing that ran, and nothing ran after it.
    expect(calls).toEqual(["requireOwner"]);
  });

  it("an unauthenticated caller (login redirect out of requireOwner→requirePayer) grants nothing", async () => {
    const REDIRECT = new Error("NEXT_REDIRECT");
    requireOwner.mockRejectedValueOnce(REDIRECT);
    await expect(topUpAction({ packCode: "pack_50" })).rejects.toBe(REDIRECT);
    expect(topUp).not.toHaveBeenCalled();
  });

  it("runs the gate even for an INVALID pack code (authz is never skipped by a cheap guard)", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    await expect(topUpAction({ packCode: "" })).rejects.toBe(NOT_FOUND);
    expect(topUp).not.toHaveBeenCalled();
  });
});

describe("topUpAction — no-oracle refusal (the refused caller learns nothing)", () => {
  it("refuses a known and an unknown pack IDENTICALLY (no pack-existence oracle)", async () => {
    requireOwner.mockRejectedValue(NOT_FOUND);
    const known = await topUpAction({ packCode: "pack_50" }).catch((e: unknown) => e);
    const unknown = await topUpAction({ packCode: "pack_ghost" }).catch((e: unknown) => e);
    expect(known).toBe(NOT_FOUND);
    expect(unknown).toBe(known); // byte-identical refusal — the pack code changes nothing
    expect(topUp).not.toHaveBeenCalled();
  });

  it("the refusal carries no role name / deny cause / PII", async () => {
    requireOwner.mockRejectedValueOnce(NOT_FOUND);
    const err = await topUpAction({ packCode: "pack_50" }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(
      /forbidden|denied|owner|recruiter|role|billing|payer_id|phone|email/i,
    );
  });
});

describe("topUpAction — Owner path unchanged (XT5/XB-A: pack CODE only)", () => {
  it("forwards ONLY the pack code and returns the new balance + credits added", async () => {
    const res = await topUpAction({ packCode: "pack_50" });
    expect(topUp).toHaveBeenCalledWith({ packCode: "pack_50" }); // no payer_id, no price
    expect(res).toEqual({ ok: true, balance: 60, creditsAdded: 50 });
  });

  it("rejects a blank / oversized pack code neutrally, without touching the seam", async () => {
    const blank = await topUpAction({ packCode: "" });
    const huge = await topUpAction({ packCode: "x".repeat(65) });
    expect(blank).toEqual({ ok: false, error: "Choose a pack to top up." });
    expect(huge).toEqual({ ok: false, error: "Choose a pack to top up." });
    expect(topUp).not.toHaveBeenCalled();
    // …but the gate still ran first for both (authorization precedes validation).
    expect(calls).toEqual(["requireOwner", "requireOwner"]);
  });

  it("an unknown pack (seam → null) is a neutral not-available, never a fake success", async () => {
    topUp.mockResolvedValueOnce(null);
    const res = await topUpAction({ packCode: "pack_ghost" });
    expect(res).toEqual({ ok: false, error: "That pack is no longer available." });
  });

  it("a seam throw collapses to ONE retryable line that leaks no reason or PII", async () => {
    topUp.mockRejectedValueOnce(new Error("payer_id 1234 unauthorized at 98765 43210"));
    const res = await topUpAction({ packCode: "pack_50" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Top-up failed (service unavailable). Please retry.");
      expect(res.error).not.toMatch(/payer_id|forbidden|owner|recruiter|\d{4}/i);
    }
  });
});
