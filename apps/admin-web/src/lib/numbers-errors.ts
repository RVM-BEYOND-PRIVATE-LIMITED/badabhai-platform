import "server-only";
import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "./admin-http";
import { describeAdminActionError } from "./describe-admin-error";

/**
 * Copy for the numbers screen's governed writes (#2884).
 *
 * The launch-test routes answer closed `reason` codes, and some name each offending worker. Those
 * codes are safe to turn into sentences — they are the API's own vocabulary, not free text from
 * the body. Anything the catalogue below does not know falls through to the portal's standard
 * `describeAdminActionError`, which never renders server text.
 */

const WORKER_REASONS: Readonly<Record<string, string>> = {
  not_found: "no such worker",
  sample_worker: "a sample worker",
  test_worker: "a test worker",
  linked_rvm_identity: "a linked RVM student who has not signed in",
  not_in_search_pool: "not in company search with his own consent",
};

const REASONS: Readonly<Record<string, string>> = {
  idempotency_key_required: "A request key is required. Reload the page and try again.",
  idempotency_key_reused: "That request key was already used for a different factory.",
  workers_not_eligible: "Some workers cannot be sent to a factory.",
  campus_company: "That factory or account belongs to a Campus company.",
  portal_import: "That factory is already in the portal import ledger.",
  factory_already_recorded: "A factory with that phone is already recorded.",
  share_limit_exceeded: "A factory can receive at most five profiles.",
  payer_not_found: "That company account does not exist.",
  link_created_without_ref: "A link time needs a payment link.",
  paid_at_mismatch: "A paid date is set exactly when the result is paid.",
  payment_order_without_payer: "A paid order needs the factory's company account.",
  payment_order_needs_paid_result: "A paid order is linked only after the factory has paid.",
  payment_order_not_found: "No such payment order.",
  payment_order_not_real: "That is not a real payment order.",
  payment_order_not_paid: "That payment order is not paid.",
  payment_order_other_payer: "That order belongs to a different company account.",
  payment_order_already_linked: "Another factory already links that payment order.",
};

function reasonText(reason: string, body: Record<string, unknown> | undefined): string {
  if (reason === "workers_not_eligible") {
    const workers = Array.isArray(body?.workers) ? body.workers : [];
    const named = workers.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const worker = row as { worker_id?: unknown; reason?: unknown };
      if (typeof worker.worker_id !== "string") return [];
      const why =
        typeof worker.reason === "string"
          ? (WORKER_REASONS[worker.reason] ?? worker.reason.replace(/_/g, " "))
          : "not eligible";
      return [`${worker.worker_id} — ${why}`];
    });
    const base = REASONS.workers_not_eligible!;
    return named.length > 0 ? `${base} ${named.join("; ")}.` : base;
  }
  return REASONS[reason] ?? "That request was refused.";
}

/** Operator copy for a failed numbers write; never the API's own message text. */
export function describeNumbersActionError(err: unknown): string {
  if (isAdminUnauthorized(err)) return describeAdminActionError(err);
  if (isAdminForbidden(err)) return describeAdminActionError(err);
  if (isAdminRequestError(err)) {
    // The guard answers a bare 404 while the switch is off; a missing migration is a 503.
    if (err.status === 404) return "Not switched on yet.";
    if (err.status === 503) return "Try again later.";
    const reason = typeof err.body?.reason === "string" ? err.body.reason : undefined;
    if (reason) return reasonText(reason, err.body);
  }
  return describeAdminActionError(err);
}
