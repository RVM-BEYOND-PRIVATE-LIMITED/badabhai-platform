import { auditActionLabel } from "./skill-discovery-vocabulary";

/**
 * Closed vocabularies for governed admin-action request bodies (ADR-0025 ADMIN-3a).
 *
 * These are literal copies of the CODE enums in apps/api's `admin-actions.dto.ts`
 * (`ADMIN_CREDIT_GRANT_REASONS`, `WORKER_FLAG_REASON_CODES`) — a sibling app cannot import
 * that file, and this file exists for the SAME reason `lib/auth/capabilities.ts` carries no
 * copy of the role→capability matrix: rendering a closed set of choices needs to know the
 * vocabulary, not own it.
 *
 * A drift here can only make the client UNDER-offer an option the API would accept, never
 * smuggle one past it — the API's own zod schema (`AdminGrantCreditsSchema` /
 * `AdminFlagWorkerSchema`) is the sole authority that accepts or rejects a value, on every
 * request, regardless of what this file says.
 */

export const CREDIT_GRANT_REASONS = [
  "goodwill",
  "correction",
  "promo",
  "support_resolution",
] as const;
export type CreditGrantReason = (typeof CREDIT_GRANT_REASONS)[number];
export const CREDIT_GRANT_REASON_LABELS: Record<CreditGrantReason, string> = {
  goodwill: "Goodwill",
  correction: "Correction",
  promo: "Promotional",
  support_resolution: "Support resolution",
};

/** Mirrors `ADMIN_CREDIT_GRANT_MAX` — the hard upper bound on a single grant. */
export const ADMIN_CREDIT_GRANT_MAX = 10_000;

export const WORKER_FLAG_REASON_CODES = [
  "quality_review",
  "abuse_report",
  "duplicate",
  "other",
] as const;
export type WorkerFlagReasonCode = (typeof WORKER_FLAG_REASON_CODES)[number];
export const WORKER_FLAG_REASON_LABELS: Record<WorkerFlagReasonCode, string> = {
  quality_review: "Quality review",
  abuse_report: "Abuse report",
  duplicate: "Duplicate account",
  other: "Other",
};

/**
 * Why an admin is revealing a worker's phone — `ADMIN_PII_REVEAL_REASONS` in apps/api's
 * `admin-pii-reveal.dto.ts` (ADR-0025 Decision 4). The CODE is what `admin.pii_viewed` records;
 * the free-text note beside it is checked by the API and never stored. Same rule as the two lists
 * above: a copy for rendering the choice, never the authority on it.
 */
export const PII_REVEAL_REASON_CODES = [
  "worker_support_callback",
  "dispute_resolution",
  "safety_escalation",
] as const;
export type PiiRevealReasonCode = (typeof PII_REVEAL_REASON_CODES)[number];
export const PII_REVEAL_REASON_LABELS: Record<PiiRevealReasonCode, string> = {
  worker_support_callback: "Calling the worker back (support)",
  dispute_resolution: "Resolving a dispute",
  safety_escalation: "Safety escalation",
};

/**
 * Human labels for the `action_code` on an `admin.action_performed` event — the OPEN vocabulary
 * of `ADMIN_ACTION_CODES` in apps/api's `admin-actions.service.ts` (action_code is a free string
 * on the event, so the server can add a code without an event-schema change).
 *
 * Display polish for the event detail page, never translation of meaning: the raw code is shown
 * beside the label, and a code this build does not know renders as itself (the skill-candidate
 * decision codes have their own sentences in `skill-discovery-vocabulary.ts`).
 *
 * The last six are ADR-0060's: direct creation, password set/reset, a trusted device, and the
 * per-admin two-step verification switch.
 */
export const ADMIN_ACTION_CODE_LABELS: Readonly<Record<string, string>> = {
  payer_suspended: "Customer suspended",
  payer_reinstated: "Customer reinstated",
  credits_granted: "Credits granted",
  posting_force_closed: "Posting force-closed",
  worker_flagged: "Worker flagged",
  worker_unflagged: "Worker unflagged",
  admin_invited: "Admin invited",
  admin_invite_accepted: "Admin invite accepted",
  admin_role_changed: "Admin role changed",
  admin_suspended: "Admin suspended",
  admin_mfa_reset: "Admin MFA reset",
  admin_created: "Admin created with a temporary password",
  admin_password_set: "Admin password set",
  admin_password_reset: "Admin password reset with an emailed code",
  admin_device_trusted: "Device trusted to skip the authenticator code",
  admin_mfa_enabled: "Two-step verification (MFA) turned on",
  admin_mfa_disabled: "Two-step verification (MFA) turned off",
};

/**
 * The label for an admin action code: this table, then the skill-candidate decision sentences,
 * then the code itself when this build does not know it.
 */
export function adminActionLabel(code: string): string {
  return Object.hasOwn(ADMIN_ACTION_CODE_LABELS, code)
    ? ADMIN_ACTION_CODE_LABELS[code]!
    : auditActionLabel(code);
}
