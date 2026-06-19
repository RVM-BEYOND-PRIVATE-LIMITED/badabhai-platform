"use server";

import { z } from "zod";
import { topUp } from "../../../lib/payer-api";

/**
 * MOCK credit top-up Server Action (XT5 / E-R2 — MOCK ledger only).
 *
 * NO real payments: there is no Razorpay code, no card field, no client-supplied
 * amount. The pack is resolved from CONFIG by code SERVER-SIDE (server-side amount,
 * XT5); the grant is bound to the server-held payer (XB-A). If a real-payment path
 * is ever required, that is a HARD human gate (ADR-0019 Decision D / §7) — STOP.
 */
export type TopUpActionResult =
  | { ok: true; balance: number; creditsAdded: number }
  | { ok: false; error: string };

const packCodeSchema = z.string().min(1).max(64);

export async function topUpAction(input: { packCode: string }): Promise<TopUpActionResult> {
  if (!packCodeSchema.safeParse(input.packCode).success) {
    return { ok: false, error: "Choose a pack to top up." };
  }
  try {
    const result = await topUp({ packCode: input.packCode });
    if (!result) return { ok: false, error: "That pack is no longer available." };
    return { ok: true, balance: result.balance, creditsAdded: result.creditsAdded };
  } catch {
    return { ok: false, error: "Top-up failed (service unavailable). Please retry." };
  }
}
