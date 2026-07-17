"use server";

import { revalidatePath } from "next/cache";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { buyCapacity } from "../../../lib/payer-api";
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
  | { ok: false; error: string };

export async function upgradeCapacityAction(input: {
  tier: string;
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

  const res = await buyCapacity({ tier: input.tier });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  // Refresh the capacity view (the allowance + at-capacity banner reflect the new grant).
  revalidatePath("/capacity");
  return { ok: true, resumedCount: res.resumedPlanIds.length, allowance: res.allowance };
}
