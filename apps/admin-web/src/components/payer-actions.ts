"use server";

import { z } from "zod";
import { adminFetch } from "../lib/admin-http";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  ADMIN_CREDIT_GRANT_MAX,
  CREDIT_GRANT_REASONS,
  type CreditGrantReason,
} from "../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/**
 * Company/Agency (payer) governed actions — shared by both surfaces, exactly like
 * `PayerDetailView` itself. Mirrors `AdminActionsController`'s `/admin/payers/:id/*` routes
 * 1:1 (ADR-0025 ADMIN-3a); `suspend_payer` gates suspend/reinstate, `grant_credits` gates the
 * grant.
 */

const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });

export async function suspendPayerAction(payerId: string): Promise<AdminActionOutcome> {
  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/suspend`, {
      method: "POST",
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Payer suspended. Their postings are hidden and their sessions revoked."
        : "Already suspended — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function reinstatePayerAction(payerId: string): Promise<AdminActionOutcome> {
  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/reinstate`, {
      method: "POST",
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Payer reinstated to their pre-suspension state."
        : "Not suspended — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

const grantCreditsInputSchema = z.object({
  amount: z.number().int().positive().max(ADMIN_CREDIT_GRANT_MAX),
  reasonCode: z.enum(CREDIT_GRANT_REASONS),
  // The exactly-once token (ADMIN-3a H2) — generated ONCE per form mount by the caller
  // (`crypto.randomUUID()` in `useState(() => …)`), never regenerated on retry, so a genuine
  // double-submit is exactly-once server-side rather than a double grant.
  idempotencyKey: z.string().uuid(),
});
const grantCreditsResultSchema = resultSchema.extend({
  ledger_id: z.string(),
  balance: z.number(),
});

export interface GrantCreditsInput {
  amount: number;
  reasonCode: CreditGrantReason;
  idempotencyKey: string;
}

export async function grantCreditsAction(
  payerId: string,
  input: GrantCreditsInput,
): Promise<AdminActionOutcome> {
  const parsed = grantCreditsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Enter a whole number of credits from 1 to ${ADMIN_CREDIT_GRANT_MAX}.` };
  }

  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/credits`, {
      method: "POST",
      body: {
        amount: parsed.data.amount,
        reason_code: parsed.data.reasonCode,
        idempotency_key: parsed.data.idempotencyKey,
      },
      schema: grantCreditsResultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? `Granted ${parsed.data.amount} credits. New balance: ${res.balance}.`
        : `This grant was already applied with that key — no new credits. Balance: ${res.balance}.`,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
