"use server";

import { z } from "zod";
import { payerAuth } from "../../lib/auth";

/**
 * Login Server Action (ADR-0019 Decision B / XB-H).
 *
 * Runs SERVER-SIDE only: the mock seam sets an httpOnly signed cookie; no secret
 * or session token ever reaches the client. Returns ONE neutral error for any
 * failure (bad email OR password OR unknown account) — no user-enumeration oracle.
 * Nothing about the attempt is logged.
 */

const loginInputSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});

export type LoginActionResult = { ok: true } | { ok: false; error: string };

export async function loginAction(input: {
  email: string;
  password: string;
}): Promise<LoginActionResult> {
  const parsed = loginInputSchema.safeParse(input);
  if (!parsed.success) {
    // Same neutral copy as a credential mismatch — no enumeration via validation.
    return { ok: false, error: "Invalid email or password." };
  }
  const result = await payerAuth().login(parsed.data);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}
