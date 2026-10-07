/**
 * The values a list filter can take, where no shared package admin-web depends on exports them —
 * copied from the admin API's query DTOs (apps/api/src/admin/*.dto.ts) and PINNED to them by
 * list-filter-values.test.ts, which reads the DTO source and fails when the two drift. Read by the
 * list pages to tell a filter the server could have refused from one it could not
 * (`lib/read-refusal.ts`): with only valid filters in the address, a 400 is the page cursor's,
 * never "that filter".
 *
 * The worker, posting and verification statuses and the feedback tags come from
 * `@badabhai/types`; the AI task types are `AI_TASK_TYPES` in `lib/ai-cost.ts` (pinned the same
 * way); the admin roles are `ADMIN_ROLES` (`lib/auth/capabilities.ts`).
 */

/** `AdminPayersQuerySchema.status` — Companies and Agencies. */
export const PAYER_STATUSES = ["pending", "active", "suspended"] as const;

/** `AdminLedgerQuerySchema.reason` — the credit ledger's reason chips, in the chips' order. */
export const LEDGER_REASONS = ["pack_purchase", "grant", "unlock_debit", "refund"] as const;

/** `AdminOrdersQuerySchema.status` — the Payment orders status chips, in the chips' order. */
export const ORDER_STATUSES = ["created", "paid", "failed"] as const;

/** `AdminAiTracesQuerySchema.success`, as the address carries it. */
export const AI_CALL_OUTCOMES = ["true", "false"] as const;

/** `AdminEventsQuerySchema`: free text, accepted up to these lengths. */
export const EVENT_FILTER_MAX_LENGTH = { eventName: 128, actorType: 64, subjectType: 64 } as const;
