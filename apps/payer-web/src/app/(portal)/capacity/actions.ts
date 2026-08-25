"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { buyCapacity, getCapacity, PurchaseConflictError } from "../../../lib/payer-api";
import { hiringCapacityTiers } from "../../../lib/pricing-config";

/**
 * MOCK hiring-capacity upgrade Server Action (ADR-0016 — MOCK payment only).
 *
 * GATE-FIRST (no-oracle): the FIRST statement is the SAME session gate the capacity page
 * uses — {@link requirePayer} (resolve the server-held session or redirect to /login).
 * The action runs ONLY for an authenticated payer; server-side ownership stays the gate
 * (XB-A) — the tier-code check below is a value guard, NOT authz.
 *
 * INPUT is `{ tier }` ONLY (XT5 / XB-A): the client sends a tier CODE — NEVER a payer_id,
 * NEVER a price/amount/quota. The CODE is validated against the config'd capacity tiers
 * (an arbitrary string is rejected with a NEUTRAL error — never trusted). The seam prices
 * it server-side and binds it to the session payer.
 *
 * NO real payments: the backend mock-purchases (real_call:false); there is NO Razorpay.
 * A real-payment path is a HARD human gate (ADR-0019 Decision D / §7) — STOP.
 */
export type UpgradeCapacityActionResult =
  | { ok: true; resumedCount: number; allowance: number }
  // A 409 DUPLICATE-IN-FLIGHT (#1185, correcting #1148's inverted reading): the backend 409s ONLY
  // while the FIRST attempt's in-flight sentinel still stands — it has NOT committed and MAY STILL
  // THROW. So a 409 is "still processing, outcome UNKNOWN", NOT a completed purchase. Non-terminal:
  // `allowance` (when present) is the CURRENT figure, re-read for display only — never final.
  | { ok: false; pending: true; allowance?: number }
  | { ok: false; error: string };

/**
 * The per-purchase idempotency key (#1148) — a client-minted `crypto.randomUUID()`. Validated at
 * this boundary (invariant #7): a well-formed UUID is threaded to the seam; anything else is
 * DROPPED so the call degrades to the pre-fix no-key behaviour rather than forwarding junk.
 * PII-free; no payer id (XB-A — the session is the identity).
 */
const idempotencyKeySchema = z.string().uuid();

export async function upgradeCapacityAction(input: {
  tier: string;
  idempotencyKey?: string;
}): Promise<UpgradeCapacityActionResult> {
  // GATE FIRST — same session gate as the capacity page; any failure path stays neutral.
  await requirePayer();

  // Value guard (NOT authz): the tier must be one of the config'd capacity codes — from
  // the LIVE catalog (D-6; fetch failure falls open to the compile-time defaults, which
  // is fine: the backend re-resolves + rejects an unknown tier server-side anyway). An
  // unknown/arbitrary string is rejected neutrally — never forwarded to the seam.
  const { products } = await getLiveCatalog();
  const isKnownTier = hiringCapacityTiers(products).some((t) => t.code === input.tier);
  if (!isKnownTier) {
    return { ok: false, error: "Choose a capacity tier to upgrade." };
  }

  const idempotencyKey =
    input.idempotencyKey && idempotencyKeySchema.safeParse(input.idempotencyKey).success
      ? input.idempotencyKey
      : undefined;

  try {
    const res = await buyCapacity({ tier: input.tier, idempotencyKey });
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    // Refresh the capacity view (the allowance + at-capacity banner reflect the new grant).
    revalidatePath("/capacity");
    return { ok: true, resumedCount: res.resumedPlanIds.length, allowance: res.allowance };
  } catch (e) {
    // 409 DUPLICATE-IN-FLIGHT (#1185): the backend 409s ONLY while the FIRST attempt's in-flight
    // sentinel still stands — it has NOT committed and may still throw. This is "still processing,
    // outcome UNKNOWN", NOT "already granted" (the earlier #1148 branch read this inverted and
    // reported a false terminal success over the PRE-purchase allowance). So return a NON-terminal
    // `pending` result: NEVER re-POST (a second purchase would double-fire the payment/coupon
    // spine), and NEVER claim it completed. We MAY re-read the CURRENT allowance to SHOW it —
    // presented as current-not-final.
    if (e instanceof PurchaseConflictError) {
      try {
        const cap = await getCapacity();
        revalidatePath("/capacity");
        return { ok: false, pending: true, allowance: cap.activeVacancyAllowance };
      } catch {
        // The re-read blipped — still pending, just with no current figure to show.
        return { ok: false, pending: true };
      }
    }
    // Any OTHER thrown transport error collapses to one retryable line (no leaked reason).
    return { ok: false, error: "Capacity upgrade failed (service unavailable). Please retry." };
  }
}
