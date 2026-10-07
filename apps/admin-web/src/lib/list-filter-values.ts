/**
 * The values a list filter can take, where admin-web has no other runtime source for them —
 * mirrored from the admin API's query DTOs (apps/api/src/admin/*.dto.ts). Read by the list pages
 * to tell a filter the server could have refused from one it could not (`lib/read-refusal.ts`):
 * with only valid filters in the address, a 400 is the page cursor's, never "that filter".
 *
 * The worker, posting and verification statuses come from `@badabhai/types`, the feedback tags
 * from `lib/feedback.ts`, the AI task types from `lib/ai-cost.ts` — not restated here.
 */

/** `AdminPayersQuerySchema.status` — Companies and Agencies. */
export const PAYER_STATUSES = ["pending", "active", "suspended"] as const;

/** `AdminAiTracesQuerySchema.success`, as the address carries it. */
export const AI_CALL_OUTCOMES = ["true", "false"] as const;

/** `AdminEventsQuerySchema`: free text, accepted up to these lengths. */
export const EVENT_FILTER_MAX_LENGTH = { eventName: 128, actorType: 64, subjectType: 64 } as const;
