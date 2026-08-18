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
