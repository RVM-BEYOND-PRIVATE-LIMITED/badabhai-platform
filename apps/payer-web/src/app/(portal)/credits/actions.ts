"use server";

import { z } from "zod";
import { requireOwner } from "../../../lib/auth/org-roles";
import {
  createCreditOrder,
  getCredits,
  PurchaseConflictError,
  topUp,
  verifyCreditPayment,
} from "../../../lib/payer-api";

/**
 * MOCK credit top-up Server Action (XT5 / E-R2 — MOCK ledger only).
 *
 * NO real payments: there is no Razorpay code, no card field, no client-supplied
 * amount. The pack is resolved from CONFIG by code SERVER-SIDE (server-side amount,
 * XT5); the grant is bound to the server-held payer (XB-A). If a real-payment path
 * is ever required, that is a HARD human gate (ADR-0019 Decision D / §7) — STOP.
 *
 * ORG-RBAC (#463 / TD79): billing/wallet is an OWNER-only surface — the SAME claim the
 * Credits page makes (`page.tsx` → `requireOwner()`) and the nav advertises (`nav-model.ts`
 * only lists /credits when `isOwner`). This action RE-ASSERTS that gate itself, exactly like
 * the team write actions (`team/actions.ts`), because a page gate is not an action gate.
 */
export type TopUpActionResult =
  | { ok: true; balance: number; creditsAdded: number }
  // A 409 DUPLICATE (#1046): the first tap of THIS purchase charged once; `balance` is the REAL
  // re-read figure (never a guessed delta), and `creditsAdded` is deliberately absent.
  | { ok: true; balance: number; duplicate: true }
  | { ok: false; error: string };

const packCodeSchema = z.string().min(1).max(64);

/**
 * The per-purchase idempotency key (#1046) — a client-minted `crypto.randomUUID()`. Validated at
 * this boundary (invariant #7): a well-formed UUID is threaded to the seam; anything else is
 * DROPPED (the call degrades to the pre-fix no-key behaviour) rather than forwarding a junk
 * header. PII-free by construction; it carries no payer id (XB-A — the session is the identity).
 */
const idempotencyKeySchema = z.string().uuid();
function safeIdempotencyKey(key: string | undefined): string | undefined {
  return key && idempotencyKeySchema.safeParse(key).success ? key : undefined;
}

export async function topUpAction(input: {
  packCode: string;
  idempotencyKey?: string;
}): Promise<TopUpActionResult> {
  // GATE FIRST (#463 — TD79). A Next.js Server Action is an INDEPENDENTLY INVOCABLE POST
  // endpoint, not a child of the page that renders the button: the page's requireOwner()
  // protects the RENDER only. Before this line the action had NO gate at all, so a RECRUITER
  // in the org — the concrete victim's own colleague, the one the nav deliberately hides
  // /credits from — could replay the panel's request with any pack code and mint credits onto
  // the org's wallet without ever loading the page that 404s them. That made the portal's
  // "Owner-only billing" claim a lie (it was a client-side hide, not an authorization).
  //
  // requireOwner() resolves the SERVER-HELD session (unauthenticated ⇒ /login redirect) and
  // 404s a non-Owner NEUTRALLY — no "forbidden" oracle, no role name, nothing that confirms an
  // Owner-only surface exists (org-roles.ts). It runs BEFORE the pack-code check and BEFORE the
  // seam, so a refused caller mutates NOTHING: no grant happened, therefore there is no state
  // change to eventize here (§1 is satisfied by the API — POST /payer/credits emits the
  // credit-grant event server-side for the calls that DO get through; this action never
  // eventizes on its own and must not start).
  await requireOwner();

  if (!packCodeSchema.safeParse(input.packCode).success) {
    return { ok: false, error: "Choose a pack to top up." };
  }
  try {
    const result = await topUp({
      packCode: input.packCode,
      idempotencyKey: safeIdempotencyKey(input.idempotencyKey),
    });
    if (!result) return { ok: false, error: "That pack is no longer available." };
    return { ok: true, balance: result.balance, creditsAdded: result.creditsAdded };
  } catch (e) {
    // 409 DUPLICATE (#1046): a re-tap of THIS purchase landed while the first was still in flight.
    // The first charged ONCE; the 409 carries no balance, so the correct answer is to RE-READ the
    // REAL balance and surface it — NEVER re-POST (that would be a fresh purchase attempt) and
    // NEVER render a guessed number. `getCredits` is a payer-authed GET (XB-A, session-scoped).
    if (e instanceof PurchaseConflictError) {
      try {
        const { balance } = await getCredits();
        return { ok: true, balance, duplicate: true };
      } catch {
        // The re-read itself blipped — do NOT fabricate a balance. Point the payer at a refresh.
        return {
          ok: false,
          error: "Your top-up is being processed. Refresh in a moment to see your balance.",
        };
      }
    }
    // Every other failure collapses to ONE retryable line — the caller never learns whether the
    // pack, the org, or the backend was the reason (no-oracle, same posture as the gate).
    return { ok: false, error: "Top-up failed (service unavailable). Please retry." };
  }
}

/* ── REAL Razorpay checkout (only reachable when PAYMENTS_ENABLE_REAL is on) ──────── */

export type CreateOrderActionResult =
  | {
      ok: true;
      orderId: string;
      /** PUBLIC `rzp_*` key id, supplied by the API on this response. Never a secret. */
      keyId: string;
      /** Paise — what Razorpay Checkout expects. */
      amount: number;
      currency: string;
      packCode: string;
    }
  | { ok: false; error: string };

export type VerifyPaymentActionResult =
  | { ok: true; balance: number; creditsAdded: number }
  | { ok: false; error: string };

/**
 * Create a REAL Razorpay order for a pack.
 *
 * SAME GATE AS THE MOCK ACTION (#463 / TD79): a Server Action is an independently
 * invocable POST endpoint, so `requireOwner()` runs FIRST — before validation and before
 * the seam. A page gate is not an action gate, and this action starts real money moving.
 *
 * The response deliberately carries no secret: the API returns only the key ID, which
 * Razorpay Checkout requires in the browser and which is public by design.
 */
export async function createOrderAction(input: {
  packCode: string;
}): Promise<CreateOrderActionResult> {
  await requireOwner(); // GATE FIRST — authorization precedes validation and the seam.

  if (!packCodeSchema.safeParse(input.packCode).success) {
    return { ok: false, error: "Choose a pack to continue." };
  }
  try {
    const order = await createCreditOrder({ packCode: input.packCode });
    // null = a 404: an unknown pack OR real payments switched off. The API answers both
    // identically on purpose, so this message must not guess which.
    if (!order) return { ok: false, error: "Checkout is unavailable right now." };
    return {
      ok: true,
      orderId: order.order_id,
      keyId: order.key_id,
      amount: order.amount,
      currency: order.currency,
      packCode: order.pack_code,
    };
  } catch {
    return { ok: false, error: "Couldn't start checkout. Please retry." };
  }
}

/**
 * Confirm a completed checkout with the server and read back the balance.
 *
 * HONEST OUTCOMES ONLY. If verification does not succeed this returns an error that says
 * the payment could not be confirmed — never a fabricated success. And a `creditsAdded: 0`
 * result is a genuine SUCCESS (the webhook granted first); the balance is authoritative,
 * so the UI keys its message on the balance, not on the delta.
 */
export async function verifyPaymentAction(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<VerifyPaymentActionResult> {
  await requireOwner(); // GATE FIRST — same reasoning as above.

  const ids = z.object({
    orderId: z.string().min(1).max(128),
    paymentId: z.string().min(1).max(128),
    signature: z.string().min(1).max(256),
  });
  if (!ids.safeParse(input).success) {
    return { ok: false, error: "We couldn't confirm that payment. Please contact support." };
  }
  try {
    const verified = await verifyCreditPayment(input);
    if (!verified) {
      // The API refuses a forged signature, an unknown order, and another tenant's order
      // with the SAME 404 — so this copy stays generic and points at a human, because the
      // payer may genuinely have been charged and needs a person, not a retry loop.
      return {
        ok: false,
        error:
          "We couldn't confirm that payment yet. If money left your account, it will be credited automatically — contact support if it isn't.",
      };
    }
    return { ok: true, balance: verified.balance, creditsAdded: verified.credits };
  } catch {
    // A transport failure here does NOT mean the purchase failed — the webhook is the
    // source of truth and settles independently. The copy says exactly that.
    return {
      ok: false,
      error:
        "Payment received, but we couldn't refresh your balance. It will update shortly — refresh in a moment.",
    };
  }
}
