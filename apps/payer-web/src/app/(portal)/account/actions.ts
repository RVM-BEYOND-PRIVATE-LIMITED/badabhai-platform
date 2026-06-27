"use server";

import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import { payerFetch } from "../../../lib/payer-http";
import { payerMeWireSchema } from "../../../lib/contracts";
import { ACCOUNT_SAVE_ERROR } from "./messages";

/**
 * Account update Server Action (PROF-4) — runs SERVER-SIDE only.
 *
 * Patches the caller's OWN account (org name / contact phone) via the payer-authed
 * `PATCH /payer/me` (PROF-3). The session JWT is read from the httpOnly cookie inside
 * {@link payerFetch}; no secret/token ever reaches the client.
 *
 * SECURITY / PRIVACY:
 *  - XB-A: the body NEVER carries `payer_id` (or `email`/`role`/`status`) — the backend
 *    derives tenancy from `req.payer.id` and REJECTS those keys (.strict()). We send only
 *    the fields the payer actually changed; an empty body is impossible (the form keeps
 *    Save disabled while pristine, and we re-guard ≥1 field here).
 *  - NO-ORACLE (XB-H): every failure — validation, 400, 401, network, parse — collapses to
 *    ONE neutral error ({@link ACCOUNT_SAVE_ERROR}). No field-level / status-level signal.
 *  - The submitted values are the payer's OWN data; they are NEVER logged (invariant #2).
 */

/** Org name parity with the backend: trimmed, 2..120 by code-point / grapheme count. */
const orgNameSchema = z
  .string()
  .trim()
  .refine((v) => {
    const len = [...v].length;
    return len >= 2 && len <= 120;
  });

/** Only the two editable fields; partial; the action re-guards ≥1 present before the call. */
const accountPatchSchema = z
  .object({
    orgName: orgNameSchema.optional(),
    phone: e164PhoneSchema.optional(),
  })
  .strict();

export type UpdateAccountActionResult = { ok: true } | { ok: false; error: string };

export async function updateAccountAction(input: {
  orgName?: string;
  phone?: string;
}): Promise<UpdateAccountActionResult> {
  // Drop undefined keys so an unchanged field is never sent; parse what remains.
  const provided: Record<string, unknown> = {};
  if (input.orgName !== undefined) provided.orgName = input.orgName;
  if (input.phone !== undefined) provided.phone = input.phone;

  const parsed = accountPatchSchema.safeParse(provided);
  // Empty body or any invalid field → the SAME neutral error (no enumeration via validation).
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return { ok: false, error: ACCOUNT_SAVE_ERROR };
  }

  try {
    await payerFetch("/payer/me", {
      method: "PATCH",
      // Only the changed, validated fields — NEVER payer_id/email/role/status.
      body: parsed.data,
      schema: payerMeWireSchema,
    });
    return { ok: true };
  } catch {
    // No-oracle: 400 / 401 / network / parse all collapse to one neutral error. Nothing logged.
    return { ok: false, error: ACCOUNT_SAVE_ERROR };
  }
}
