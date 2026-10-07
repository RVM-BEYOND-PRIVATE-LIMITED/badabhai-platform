import { beforeEach, describe, expect, it, vi } from "vitest";
import { PriceMismatchError } from "../../../lib/payer-errors";
import { PRICE_UNREADABLE_MESSAGE } from "../../../lib/price-confirmation";

/**
 * CREDIT purchase Server Actions — AUTHORIZATION regression tests (#463 / TD79, #2079).
 *
 * The bug these first locked down: `topUpAction` shipped with NO gate. A Next.js Server Action is
 * an independently invocable POST endpoint, so a page gate is not an action gate — each action
 * must assert its own gate before it touches the seam.
 *
 * WHO MAY BUY (owner ruling 2026-10-07): ANY signed-in payer member — Owner or Recruiter. The gate
 * is therefore `requirePayer()` (no session ⇒ /login), and the org-role gate is NOT consulted: it
 * is mocked here to refuse the way it would for a Recruiter, so an action that still called it
 * fails every happy path below.
 *
 * What is asserted:
 *  - GATE FIRST: requirePayer() runs BEFORE the pack check and BEFORE the seam — proven by a
 *    call-ORDER recorder, not just by "topUp was not called" (a gate that grants first and
 *    refuses after is not a gate);
 *  - a RECRUITER is admitted and reaches the seam; an unauthenticated caller reaches nothing;
 *  - NEUTRAL refusal (no-oracle): the refusal is the bare redirect sentinel requirePayer()
 *    throws — it names no role, no deny cause, and is IDENTICAL for a valid and an unknown pack;
 *  - pack CODE only forwarded (XT5/XB-A: never a payer_id/price);
 *  - every failure copy stays generic and PII-free, and the API's 403 is one neutral line.
 */

// The sentinel Next throws from redirect("/login") — the unauthenticated refusal. It names no
// role and no deny cause.
const REDIRECT = new Error("NEXT_REDIRECT");
// What the org-role gate throws for a Recruiter. The actions must never consult it now.
const NOT_FOUND = new Error("NEXT_NOT_FOUND");

/** Call-order log — the only way to prove the gate precedes the grant. */
const calls: string[] = [];

const requirePayer = vi.fn();
const requireOwner = vi.fn();
const topUp = vi.fn();
const createCreditOrder = vi.fn();
const verifyCreditPayment = vi.fn();
const getCredits = vi.fn();

/**
 * The REAL typed 409 the seam throws (#1165). The action does `e instanceof PurchaseConflictError`,
 * so the mock MUST export the same class the action imports — defining it here and exporting it
 * from the mock keeps `instanceof` honest across the module boundary.
 */
class PurchaseConflictError extends Error {
  constructor() {
    super("duplicate purchase in flight");
    this.name = "PurchaseConflictError";
  }
}

/** The REAL typed 403 the seam throws (#2079) — exported from the mock for the same reason. */
class PurchaseForbiddenError extends Error {
  constructor() {
    super("purchase refused for this account");
    this.name = "PurchaseForbiddenError";
  }
}

vi.mock("../../../lib/auth", () => ({
  requirePayer: () => {
    calls.push("requirePayer");
    return requirePayer();
  },
}));
vi.mock("../../../lib/auth/org-roles", () => ({
  requireOwner: () => {
    calls.push("requireOwner");
    return requireOwner();
  },
}));
vi.mock("../../../lib/payer-api", () => ({
  topUp: (i: { packCode: string; idempotencyKey?: string }) => {
    calls.push("topUp");
    return topUp(i);
  },
  createCreditOrder: (i: { packCode: string }) => {
    calls.push("createCreditOrder");
    return createCreditOrder(i);
  },
  verifyCreditPayment: (i: unknown) => {
    calls.push("verifyCreditPayment");
    return verifyCreditPayment(i);
  },
  getCredits: () => {
    calls.push("getCredits");
    return getCredits();
  },
  PurchaseConflictError,
  PurchaseForbiddenError,
}));

const { topUpAction, createOrderAction, verifyPaymentAction } = await import("./actions");

/** The least-privileged member is the DEFAULT caller, so every happy path proves Recruiter access. */
const RECRUITER = {
  payerId: "p1",
  role: "employer" as const,
  displayLabel: "Acme",
  status: "active" as const,
  orgRole: "recruiter" as const,
};

beforeEach(() => {
  calls.length = 0;
  requirePayer.mockReset().mockResolvedValue(RECRUITER);
  requireOwner.mockReset().mockRejectedValue(NOT_FOUND);
  topUp.mockReset().mockResolvedValue({
    payerId: "p1",
    balance: 60,
    creditsAdded: 50,
    packCode: "pack_50",
    realCall: false,
  });
  getCredits.mockReset().mockResolvedValue({ payerId: "p1", balance: 60 });
  createCreditOrder.mockReset().mockResolvedValue({
    order_id: "order_1",
    key_id: "rzp_test_keyid",
    amount: 200000,
    amount_inr: 2000,
    currency: "INR",
    pack_code: "pack_50",
    credits: 50,
  });
  verifyCreditPayment.mockReset().mockResolvedValue({
    payer_id: "p1",
    balance: 60,
    credits: 50,
    pack_code: "pack_50",
  });
});

describe("topUpAction — gate FIRST (#463: no credit may be granted before authorization)", () => {
  it("calls requirePayer() BEFORE the seam on the happy path (order, not just presence)", async () => {
    await topUpAction({ packCode: "pack_50" });
    expect(calls).toEqual(["requirePayer", "topUp"]);
  });

  it("a RECRUITER is admitted — the purchase reaches the seam (owner ruling 2026-10-07)", async () => {
    const res = await topUpAction({ packCode: "pack_50" });
    expect(res).toEqual({ ok: true, balance: 60, creditsAdded: 50 });
    // The org-role gate was never consulted — it would have 404'd this caller.
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is refused and the seam is NEVER reached — no credit is granted", async () => {
    requirePayer.mockRejectedValueOnce(REDIRECT);
    await expect(topUpAction({ packCode: "pack_50" })).rejects.toBe(REDIRECT);
    expect(topUp).not.toHaveBeenCalled();
    // The gate is the FIRST thing that ran, and nothing ran after it.
    expect(calls).toEqual(["requirePayer"]);
  });

  it("runs the gate even for an INVALID pack code (authz is never skipped by a cheap guard)", async () => {
    requirePayer.mockRejectedValueOnce(REDIRECT);
    await expect(topUpAction({ packCode: "" })).rejects.toBe(REDIRECT);
    expect(topUp).not.toHaveBeenCalled();
  });
});

describe("topUpAction — no-oracle refusal (the refused caller learns nothing)", () => {
  it("refuses a known and an unknown pack IDENTICALLY (no pack-existence oracle)", async () => {
    requirePayer.mockRejectedValue(REDIRECT);
    const known = await topUpAction({ packCode: "pack_50" }).catch((e: unknown) => e);
    const unknown = await topUpAction({ packCode: "pack_ghost" }).catch((e: unknown) => e);
    expect(known).toBe(REDIRECT);
    expect(unknown).toBe(known); // byte-identical refusal — the pack code changes nothing
    expect(topUp).not.toHaveBeenCalled();
  });

  it("the refusal carries no role name / deny cause / PII", async () => {
    requirePayer.mockRejectedValueOnce(REDIRECT);
    const err = await topUpAction({ packCode: "pack_50" }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(
      /forbidden|denied|owner|recruiter|role|billing|payer_id|phone|email/i,
    );
  });
});

describe("topUpAction — purchase path (XT5/XB-A: pack CODE only)", () => {
  it("forwards ONLY the pack code and returns the new balance + credits added", async () => {
    const res = await topUpAction({ packCode: "pack_50" });
    expect(topUp).toHaveBeenCalledWith({ packCode: "pack_50" }); // no payer_id, no price
    expect(res).toEqual({ ok: true, balance: 60, creditsAdded: 50 });
  });

  it("rejects a blank / oversized pack code neutrally, without touching the seam", async () => {
    const blank = await topUpAction({ packCode: "" });
    const huge = await topUpAction({ packCode: "x".repeat(65) });
    expect(blank).toEqual({ ok: false, error: "Choose a pack to buy." });
    expect(huge).toEqual({ ok: false, error: "Choose a pack to buy." });
    expect(topUp).not.toHaveBeenCalled();
    // …but the gate still ran first for both (authorization precedes validation).
    expect(calls).toEqual(["requirePayer", "requirePayer"]);
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
    if (!res.ok && "error" in res) {
      expect(res.error).toBe("Purchase failed (service unavailable). Please retry.");
      expect(res.error).not.toMatch(/payer_id|forbidden|owner|recruiter|\d{4}/i);
    }
  });
});

/**
 * REAL-CHECKOUT Server Actions. Both start (or confirm) real money moving, so both carry
 * the SAME gate-first discipline as the mock action — a Server Action is an independently
 * invocable POST endpoint, not a child of the page that renders the button.
 */
describe("createOrderAction — gate FIRST, pack CODE only, no secret in the result", () => {
  it("calls requirePayer() BEFORE the seam (order, not just presence)", async () => {
    await createOrderAction({ packCode: "pack_50" });
    expect(calls).toEqual(["requirePayer", "createCreditOrder"]);
  });

  it("a RECRUITER can start checkout — the org-role gate is not consulted", async () => {
    expect(await createOrderAction({ packCode: "pack_50" })).toMatchObject({ ok: true });
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is refused and NO order is created (no money starts moving)", async () => {
    requirePayer.mockRejectedValueOnce(REDIRECT);
    await expect(createOrderAction({ packCode: "pack_50" })).rejects.toBe(REDIRECT);
    expect(createCreditOrder).not.toHaveBeenCalled();
    expect(calls).toEqual(["requirePayer"]);
  });

  it("forwards ONLY the pack code — never a payer_id, price, or currency (XB-A/XT5)", async () => {
    await createOrderAction({ packCode: "pack_50" });
    expect(createCreditOrder).toHaveBeenCalledWith({ packCode: "pack_50" });
  });

  it("returns the PUBLIC key id + the server-resolved amount, and no secret", async () => {
    const res = await createOrderAction({ packCode: "pack_50" });
    expect(res).toEqual({
      ok: true,
      orderId: "order_1",
      keyId: "rzp_test_keyid",
      amount: 200000,
      currency: "INR",
      packCode: "pack_50",
    });
    expect(JSON.stringify(res)).not.toMatch(/secret|whsec/i);
  });

  it("a 404 (unknown pack OR payments off) is ONE generic message — it never guesses which", async () => {
    createCreditOrder.mockResolvedValueOnce(null);
    expect(await createOrderAction({ packCode: "pack_ghost" })).toEqual({
      ok: false,
      error: "Checkout is unavailable right now.",
    });
  });

  it("rejects a blank / oversized pack code without touching the seam (gate still ran first)", async () => {
    expect(await createOrderAction({ packCode: "" })).toEqual({
      ok: false,
      error: "Choose a pack to continue.",
    });
    expect(await createOrderAction({ packCode: "x".repeat(65) })).toEqual({
      ok: false,
      error: "Choose a pack to continue.",
    });
    expect(createCreditOrder).not.toHaveBeenCalled();
    expect(calls).toEqual(["requirePayer", "requirePayer"]);
  });

  it("a seam throw collapses to one retryable line with no reason or PII", async () => {
    createCreditOrder.mockRejectedValueOnce(new Error("payer_id p1 at 98765 43210 unauthorized"));
    const res = await createOrderAction({ packCode: "pack_50" });
    expect(res).toEqual({ ok: false, error: "Couldn't start checkout. Please retry." });
  });
});

describe("verifyPaymentAction — gate FIRST, and NEVER a fabricated success", () => {
  const INPUT = { orderId: "order_1", paymentId: "pay_1", signature: "sig_1" };

  it("calls requirePayer() BEFORE the seam", async () => {
    await verifyPaymentAction(INPUT);
    expect(calls).toEqual(["requirePayer", "verifyCreditPayment"]);
  });

  it("a RECRUITER's payment is confirmed — the org-role gate is not consulted", async () => {
    expect(await verifyPaymentAction(INPUT)).toMatchObject({ ok: true });
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is refused and the verify seam is never reached", async () => {
    requirePayer.mockRejectedValueOnce(REDIRECT);
    await expect(verifyPaymentAction(INPUT)).rejects.toBe(REDIRECT);
    expect(verifyCreditPayment).not.toHaveBeenCalled();
  });

  it("returns the SERVER balance on success (never an optimistic client number)", async () => {
    expect(await verifyPaymentAction(INPUT)).toEqual({ ok: true, balance: 60, creditsAdded: 50 });
    expect(verifyCreditPayment).toHaveBeenCalledWith(INPUT);
  });

  it("creditsAdded 0 is still a SUCCESS — the webhook granted first, the balance is truth", async () => {
    // The regression this pins: treating a 0 delta as failure would tell a payer whose
    // webhook landed first that their successful purchase failed.
    verifyCreditPayment.mockResolvedValueOnce({
      payer_id: "p1",
      balance: 60,
      credits: 0,
      pack_code: "pack_50",
    });
    expect(await verifyPaymentAction(INPUT)).toEqual({ ok: true, balance: 60, creditsAdded: 0 });
  });

  it("an UNVERIFIED payment is an honest failure that points at support, never a fake success", async () => {
    verifyCreditPayment.mockResolvedValueOnce(null);
    const res = await verifyPaymentAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/couldn't confirm/i);
      expect(res.error).toMatch(/credited automatically/i); // never tells a payer they lost money
      expect(res.error).not.toMatch(/signature|forged|payer_id/i); // no oracle
    }
  });

  it("a transport failure says the balance will update — NOT that the payment failed", async () => {
    verifyCreditPayment.mockRejectedValueOnce(new Error("network"));
    const res = await verifyPaymentAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Payment received/i);
      expect(res.error).not.toMatch(/failed/i); // the webhook settles independently
    }
  });

  it("rejects malformed ids without touching the seam", async () => {
    expect(await verifyPaymentAction({ orderId: "", paymentId: "pay_1", signature: "s" })).toEqual({
      ok: false,
      error: "We couldn't confirm that payment. Please contact support.",
    });
    expect(verifyCreditPayment).not.toHaveBeenCalled();
  });
});

/**
 * IDEMPOTENCY + 409 = PENDING, not done (#1185, correcting #1165/#1046). `topUpAction` threads the
 * client-minted per-purchase key to the seam. The backend 409s ONLY while the FIRST attempt is
 * still in flight (uncommitted, may still throw) — so a 409 is "still processing, outcome UNKNOWN",
 * NOT a completed purchase. The action must RE-READ the CURRENT balance for display but return a
 * NON-terminal `pending` result (never `ok:true`), and must never re-POST.
 */
describe("topUpAction — Idempotency-Key threading + 409 = pending (#1185)", () => {
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f"; // a client crypto.randomUUID()

  it("forwards a well-formed idempotency key to the seam", async () => {
    await topUpAction({ packCode: "pack_50", idempotencyKey: KEY });
    expect(topUp).toHaveBeenCalledWith({ packCode: "pack_50", idempotencyKey: KEY });
  });

  it("DROPS a malformed key (degrades to no-key) rather than forwarding junk to the header", async () => {
    await topUpAction({ packCode: "pack_50", idempotencyKey: "not-a-uuid" });
    // The seam is called with an UNDEFINED key — the boundary refuses to forward a junk value.
    expect(topUp).toHaveBeenCalledWith({ packCode: "pack_50", idempotencyKey: undefined });
  });

  it("a 409 is NON-terminal PENDING — never ok:true, re-reads the CURRENT balance, no second POST", async () => {
    topUp.mockRejectedValueOnce(new PurchaseConflictError());
    getCredits.mockResolvedValueOnce({ payerId: "p1", balance: 71 }); // the CURRENT (not-final) balance
    const res = await topUpAction({ packCode: "pack_50", idempotencyKey: KEY });

    // A 409 = "still running, outcome unknown": NOT a completed purchase — never a terminal success.
    expect(res).toEqual({ ok: false, pending: true, balance: 71 });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty("duplicate"); // the old false-terminal-success shape is gone
    expect(res).not.toHaveProperty("creditsAdded"); // never a guessed grant

    // Exactly ONE purchase POST (topUp), then a GET re-read (getCredits) — never a re-POST.
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(getCredits).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["requirePayer", "topUp", "getCredits"]);
  });

  it("a 409 whose re-read ALSO blips stays PENDING with no figure — never ok:true, never a fabricated balance", async () => {
    topUp.mockRejectedValueOnce(new PurchaseConflictError());
    getCredits.mockRejectedValueOnce(new Error("boom"));
    const res = await topUpAction({ packCode: "pack_50", idempotencyKey: KEY });
    expect(res).toEqual({ ok: false, pending: true });
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty("balance"); // no invented number
    // Still no re-POST on the failed-re-read path.
    expect(topUp).toHaveBeenCalledTimes(1);
  });
});

/**
 * #2085 — PRICE CONFIRMATION at the action boundary. The price the payer confirmed is forwarded to
 * the seam (after the gate, unchanged); the API's refusal of a changed price is a non-terminal
 * `priceChanged` result carrying the API's current price — one POST, no re-read, never `ok`, never
 * the in-flight `pending`. A present-but-malformed price is refused before the seam: a guard the
 * caller asked for is never silently dropped.
 */
describe("#2085 — topUpAction / createOrderAction forward the confirmed price; a refusal is 'price changed'", () => {
  const KEY = "5f9d1c2e-1a2b-4c3d-8e4f-0a1b2c3d4e5f";

  it("topUpAction forwards the confirmed price beside the pack code and key (gate first)", async () => {
    await topUpAction({ packCode: "pack_50", idempotencyKey: KEY, expectedPriceInr: 2000 });
    expect(topUp).toHaveBeenCalledWith({
      packCode: "pack_50",
      idempotencyKey: KEY,
      expectedPriceInr: 2000,
    });
    expect(calls).toEqual(["requirePayer", "topUp"]);
  });

  it("a refused price is { priceChanged, currentPriceInr } — ONE POST, no balance re-read, never ok or pending", async () => {
    topUp.mockRejectedValueOnce(new PriceMismatchError("/payer/credits", 1500));
    const res = await topUpAction({ packCode: "pack_50", idempotencyKey: KEY, expectedPriceInr: 2000 });
    expect(res).toEqual({ ok: false, priceChanged: true, currentPriceInr: 1500 });
    expect(res).not.toHaveProperty("pending");
    expect(calls).toEqual(["requirePayer", "topUp"]); // no getCredits, no second topUp
  });

  it("a malformed confirmed price is refused BEFORE the seam (after the gate)", async () => {
    for (const bad of [-1, 12.5, Number.NaN, "2000", 10_000_001]) {
      calls.length = 0;
      const res = await topUpAction({ packCode: "pack_50", expectedPriceInr: bad as number });
      expect(res, String(bad)).toEqual({ ok: false, error: PRICE_UNREADABLE_MESSAGE });
      expect(calls, String(bad)).toEqual(["requirePayer"]);
    }
    expect(topUp).not.toHaveBeenCalled();
  });

  it("createOrderAction forwards the tile's price; a refused price opens no checkout", async () => {
    await createOrderAction({ packCode: "pack_50", expectedPriceInr: 2000 });
    expect(createCreditOrder).toHaveBeenCalledWith({ packCode: "pack_50", expectedPriceInr: 2000 });

    createCreditOrder.mockRejectedValueOnce(new PriceMismatchError("/payer/credits/order", 2400));
    const res = await createOrderAction({ packCode: "pack_50", expectedPriceInr: 2000 });
    expect(res).toEqual({ ok: false, priceChanged: true, currentPriceInr: 2400 });
    expect(createCreditOrder).toHaveBeenCalledTimes(2); // one per call — never re-posted

    const bad = await createOrderAction({ packCode: "pack_50", expectedPriceInr: -3 });
    expect(bad).toEqual({ ok: false, error: PRICE_UNREADABLE_MESSAGE });
    expect(createCreditOrder).toHaveBeenCalledTimes(2);
  });
});

/**
 * A 403 FROM THE API (#2079). #2098 put an owner-only `PayerOrgRoleGuard` on the purchase routes;
 * the 2026-10-07 ruling opens buying to every member and the backend is lifting that guard, but
 * until it deploys a Recruiter this app admits gets a 403 (as could any account the API refuses).
 * The seam types it as PurchaseForbiddenError. The action must turn it into ONE neutral line: no
 * crash, no role name or deny cause (no-oracle), and no "retry" — a retry is the same 403.
 */
describe("a 403 from the API on a purchase (#2079) surfaces neutrally", () => {
  const NEUTRAL = "Buying credits isn't available for this account.";

  it("topUpAction returns the neutral line — no retry invitation, no balance re-read", async () => {
    topUp.mockRejectedValueOnce(new PurchaseForbiddenError());
    const res = await topUpAction({ packCode: "pack_50" });
    expect(res).toEqual({ ok: false, error: NEUTRAL });
    if (!res.ok && "error" in res) {
      expect(res.error).not.toMatch(/retry|forbidden|denied|owner|recruiter|role|403/i);
    }
    // Not the 409 path: nothing to re-read, and never a second POST.
    expect(calls).toEqual(["requirePayer", "topUp"]);
  });

  it("createOrderAction returns the same neutral line — no order, no checkout", async () => {
    createCreditOrder.mockRejectedValueOnce(new PurchaseForbiddenError());
    expect(await createOrderAction({ packCode: "pack_50" })).toEqual({ ok: false, error: NEUTRAL });
  });

  it("verifyPaymentAction stays honest about money that may have moved — points at support", async () => {
    verifyCreditPayment.mockRejectedValueOnce(new PurchaseForbiddenError());
    const res = await verifyPaymentAction({
      orderId: "order_1",
      paymentId: "pay_1",
      signature: "sig_1",
    });
    expect(res).toEqual({
      ok: false,
      error:
        "We couldn't confirm that payment yet. If money left your account, it will be credited automatically — contact support if it isn't.",
    });
  });
});
