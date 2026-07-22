"use server";

import { z } from "zod";
import { requireOwner } from "../../../lib/auth/org-roles";
import { topUp } from "../../../lib/payer-api";

/**
 * MOCK credit top-up Server Action (XT5 / E-R2 — MOCK ledger only).
 *
 * NO real payments: there is no Razorpay code, no card field, no client-supplied
 * amount. The pack is resolved from CONFIG by code SERVER-SIDE (server-side amount,
 * XT5); the grant is bound to the server-held payer (XB-A). If a real-payment path
 * is ever required, that is a HARD human gate (ADR-0019 Decision D / §7) — STOP.
 *
 * ORG-RBAC (#463 / TD79): billing/wallet is an OWNER-only surface — the SAME claim the
 * Credits page makes (`page.tsx` → `requireOwner()`) and the nav advertises (`portal-nav.tsx`
 * only renders /credits when `isOwner`). This action RE-ASSERTS that gate itself, exactly like
 * the team write actions (`team/actions.ts`), because a page gate is not an action gate.
 */
export type TopUpActionResult =
  | { ok: true; balance: number; creditsAdded: number }
  | { ok: false; error: string };

const packCodeSchema = z.string().min(1).max(64);

export async function topUpAction(input: { packCode: string }): Promise<TopUpActionResult> {
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
    const result = await topUp({ packCode: input.packCode });
    if (!result) return { ok: false, error: "That pack is no longer available." };
    return { ok: true, balance: result.balance, creditsAdded: result.creditsAdded };
  } catch {
    // Every non-404 failure collapses to ONE retryable line — the caller never learns whether
    // the pack, the org, or the backend was the reason (no-oracle, same posture as the gate).
    return { ok: false, error: "Top-up failed (service unavailable). Please retry." };
  }
}
