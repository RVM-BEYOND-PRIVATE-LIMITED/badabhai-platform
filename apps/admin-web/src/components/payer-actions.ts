"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../lib/admin-http";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  ADMIN_CREDIT_GRANT_MAX,
  CREDIT_GRANT_REASONS,
  type CreditGrantReason,
} from "../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../lib/admin-action-result";
import type { ConfirmReason } from "../lib/confirm-tiers";

/**
 * Company/Agency (payer) governed actions — shared by both surfaces, exactly like
 * `PayerDetailView` itself. Mirrors `AdminActionsController`'s `/admin/payers/:id/*` routes
 * 1:1 (ADR-0025 ADMIN-3a); `suspend_payer` gates suspend/reinstate, `grant_credits` gates the
 * grant.
 */

const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });

/**
 * #2579 — the company header's T2 requires a written reason; it is stored on `audit_logs` by
 * the backend. The legacy payer-detail header may still call these actions without one.
 */
const payerReasonSchema = z
  .object({
    reason_code: z.enum(["policy", "fraud", "request", "correction", "security", "other"]),
    reason_text: z.string().trim().min(15).max(500),
  })
  .strict();

function reasonBody(reason: ConfirmReason | undefined) {
  if (!reason) return {};
  const parsed = payerReasonSchema.safeParse({
    reason_code: reason.category,
    reason_text: reason.text,
  });
  return parsed.success ? { body: parsed.data } : { invalid: true as const };
}

export async function suspendPayerAction(
  payerId: string,
  reason?: ConfirmReason,
): Promise<AdminActionOutcome> {
  const body = reasonBody(reason);
  if ("invalid" in body) {
    return { ok: false, error: "Explain the reason in at least 15 characters." };
  }
  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/suspend`, {
      method: "POST",
      ...body,
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Account suspended. Its postings are hidden and its sessions revoked."
        : "Already suspended — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function reinstatePayerAction(
  payerId: string,
  reason?: ConfirmReason,
): Promise<AdminActionOutcome> {
  const body = reasonBody(reason);
  if ("invalid" in body) {
    return { ok: false, error: "Explain the reason in at least 15 characters." };
  }
  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/reinstate`, {
      method: "POST",
      ...body,
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Account reinstated to its pre-suspension state."
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
  /** #2750 item 11 — the written reason (15–500, no phone number). */
  reasonText: z.string().trim().min(15).max(500).optional(),
  /** #2750 item 11 — the ledger row a correction corrects. */
  correctsLedgerId: z.string().uuid().optional(),
});
const grantCreditsResultSchema = resultSchema.extend({
  ledger_id: z.string(),
  balance: z.number(),
});

export interface GrantCreditsInput {
  amount: number;
  reasonCode: CreditGrantReason;
  idempotencyKey: string;
  /** #2750 item 11 — the written reason shown on the grant's audit row. */
  reasonText?: string;
  /** #2750 item 11 — the ledger row a correction corrects (super admin only). */
  correctsLedgerId?: string;
}

/** The answer copy for a goodwill cap refusal, using the server's own used/cap numbers. */
function goodwillCapCopy(body: Record<string, unknown> | undefined): string | null {
  if (body?.used === undefined || body.cap === undefined) return null;
  const used = Number(body.used);
  const cap = Number(body.cap);
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return null;
  return `${used} of ${cap} goodwill credits already granted this quarter.`;
}

/** The correction picker's rows: this company's ledger, newest first. PII-free. */
export interface GrantLedgerRow {
  id: string;
  label: string;
}

const grantLedgerRowsSchema = z.object({
  ledger: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        reason: z.string(),
        delta: z.number(),
        created_at: z.string(),
      }),
    ),
  }),
});

export async function getGrantLedgerRowsAction(
  payerId: string,
): Promise<{ ok: true; rows: GrantLedgerRow[] } | { ok: false; error: string }> {
  try {
    const view = await adminFetch(
      `/admin/payers/${encodeURIComponent(payerId)}/credits?limit=50`,
      { schema: grantLedgerRowsSchema },
    );
    return {
      ok: true,
      rows: view.ledger.items.map((row) => ({
        id: row.id,
        label: `${row.created_at.slice(0, 10)} · ${row.reason.replace(/_/g, " ")} · ${
          row.delta >= 0 ? "+" : ""
        }${row.delta}`,
      })),
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function grantCreditsAction(
  payerId: string,
  input: GrantCreditsInput,
): Promise<AdminActionOutcome> {
  const parsed = grantCreditsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Enter a whole number of credits from 1 to ${ADMIN_CREDIT_GRANT_MAX} and a reason of 15–500 characters.`,
    };
  }

  try {
    const res = await adminFetch(`/admin/payers/${encodeURIComponent(payerId)}/credits`, {
      method: "POST",
      body: {
        amount: parsed.data.amount,
        reason_code: parsed.data.reasonCode,
        idempotency_key: parsed.data.idempotencyKey,
        ...(parsed.data.reasonText ? { reason_text: parsed.data.reasonText } : {}),
        ...(parsed.data.correctsLedgerId
          ? { corrects_ledger_id: parsed.data.correctsLedgerId }
          : {}),
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
    if (isAdminRequestError(err)) {
      const code = typeof err.body?.code === "string" ? err.body.code : "";
      if (code === "GOODWILL_CAP_EXCEEDED") {
        return {
          ok: false,
          error: goodwillCapCopy(err.body) ?? "The quarterly goodwill cap is already used.",
        };
      }
      if (code === "GRANT_REASON_RETIRED") {
        return {
          ok: false,
          error: "This company is under the credit rules: grant goodwill or a correction.",
        };
      }
      if (code === "REASON_TEXT_REQUIRED") {
        return { ok: false, error: "Add a written reason of 15–500 characters." };
      }
      if (code === "CORRECTS_LEDGER_ID_REQUIRED") {
        return { ok: false, error: "Choose the ledger row this correction corrects." };
      }
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}
