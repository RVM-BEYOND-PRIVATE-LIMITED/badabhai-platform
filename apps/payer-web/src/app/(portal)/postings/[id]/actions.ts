"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePayer } from "../../../../lib/auth";
import { buyBoost, buyPlan } from "../../../../lib/payer-api";
import { boostTiers, postingPlanTiers } from "../../../../lib/pricing-config";

/**
 * Company POSTING-DETAIL buy Server Actions (B3 / #179 — MOCK payment only).
 *
 * GATE-FIRST (no-oracle): the FIRST statement is the SAME session gate the posting-detail page
 * uses — {@link requirePayer}. The action runs ONLY for an authenticated payer; server-side
 * OWNERSHIP stays the gate (the backend asserts it FIRST via the no-oracle getOneForPayer — a
 * foreign/unknown posting returns the SAME neutral 403/404, never surfaced as a cause).
 *
 * INPUT is `{ postingId, tier, coupon? }` (XT5 / XB-A): the client sends a tier CODE (validated
 * against the config'd tiers — an arbitrary string is rejected NEUTRALLY, never forwarded) and an
 * OPTIONAL coupon — NEVER a payer_id, NEVER a price/amount/quota. The posting id rides the PATH.
 *
 * NO real payments: the backend mock-purchases (real_call:false); there is NO Razorpay. A
 * real-payment path is a HARD human gate (ADR-0019 Decision D / §7) — STOP.
 */

export type BuyPlanActionResult =
  | { ok: true; tier: "standard" | "pro"; status: string; paused: boolean; expiresAt: string | null }
  | { ok: false; error: string };

export type BuyBoostActionResult =
  | { ok: true; tier: "all_candidates"; status: string; endsAt: string | null }
  | { ok: false; error: string };

const postingIdSchema = z.string().uuid();
const planTierSchema = z.enum(["standard", "pro"]);
const boostTierSchema = z.enum(["all_candidates"]);
// A coupon is an opaque, bounded, PII-free code (mirrors the backend `coupon` bound). Optional.
const couponSchema = z.string().min(1).max(64).optional();

/** Buy a paid plan (standard|pro) for the caller's OWN posting. Ownership is the backend gate. */
export async function buyPlanAction(input: {
  postingId: string;
  tier: string;
  coupon?: string;
}): Promise<BuyPlanActionResult> {
  await requirePayer(); // GATE FIRST — same session gate as the page; any failure stays neutral.

  if (!postingIdSchema.safeParse(input.postingId).success) {
    return { ok: false, error: "That posting could not be found." };
  }
  const tier = planTierSchema.safeParse(input.tier);
  const coupon = couponSchema.safeParse(input.coupon);
  // Value guard (NOT authz): the tier must be a known config'd plan code AND parse as an enum.
  if (!tier.success || !postingPlanTiers().some((t) => t.code === input.tier)) {
    return { ok: false, error: "Choose a plan to buy." };
  }
  if (!coupon.success) return { ok: false, error: "That coupon code isn't valid." };

  const res = await buyPlan({ postingId: input.postingId, tier: tier.data, coupon: coupon.data });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/postings/${input.postingId}`);
  return { ok: true, tier: res.tier, status: res.status, paused: res.paused, expiresAt: res.expiresAt };
}

/** Buy a booster (all_candidates) for the caller's OWN posting. Ownership is the backend gate. */
export async function buyBoostAction(input: {
  postingId: string;
  tier: string;
  coupon?: string;
}): Promise<BuyBoostActionResult> {
  await requirePayer(); // GATE FIRST.

  if (!postingIdSchema.safeParse(input.postingId).success) {
    return { ok: false, error: "That posting could not be found." };
  }
  const tier = boostTierSchema.safeParse(input.tier);
  const coupon = couponSchema.safeParse(input.coupon);
  if (!tier.success || !boostTiers().some((t) => t.code === input.tier)) {
    return { ok: false, error: "Choose a boost to buy." };
  }
  if (!coupon.success) return { ok: false, error: "That coupon code isn't valid." };

  const res = await buyBoost({ postingId: input.postingId, tier: tier.data, coupon: coupon.data });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/postings/${input.postingId}`);
  return { ok: true, tier: res.tier, status: res.status, endsAt: res.endsAt };
}
