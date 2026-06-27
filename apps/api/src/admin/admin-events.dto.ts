import { z } from "zod";

/**
 * Zod DTOs for the Admin Ops Portal read-only event-spine API (ADR-0025 ADMIN-2).
 *
 * Every boundary into the events spine is validated here: the filter+pagination query, the
 * route params, and the export shape. The contracts encode the HARD CAPS (page size, export
 * rows, metrics window) and the WHITELISTED subject-type enum — so an over-broad/unbounded
 * query is rejected at the pipe, never reaching the (select-only) repository.
 *
 * NOTHING here decrypts or returns PII: filters are ids/enums/timestamps, responses are the
 * already-PII-free event rows (payloads carry ids/hashes/codes only by registry construction).
 */

/** Hard upper bound on a single events page (keyset). Default page size when unspecified. */
export const ADMIN_EVENTS_PAGE_MAX = 100;
export const ADMIN_EVENTS_PAGE_DEFAULT = 50;
/** Hard upper bound on a trace / timeline result (bounded causal chains). */
export const ADMIN_TRACE_MAX = 500;
/** Hard upper bound on a single export (CSV/JSON row cap). */
export const ADMIN_EXPORT_ROW_MAX = 5000;
/** Hard upper bound on the metrics aggregation window (days). */
export const ADMIN_METRICS_WINDOW_DAYS_MAX = 90;
export const ADMIN_METRICS_WINDOW_DAYS_DEFAULT = 30;

/**
 * Subject types an admin may pivot the entity timeline on (ADMIN-2 route #4). A WHITELIST,
 * not the full `SUBJECT_TYPES` enum — the timeline is the worker/payer/job lifecycle surface
 * the UI renders; an unknown/unlisted type is rejected (deny-by-default). Extend deliberately.
 */
export const ADMIN_TIMELINE_SUBJECT_TYPES = [
  "worker",
  "payer",
  "job",
  "job_posting",
  "unlock",
  "profile",
  "resume",
  "consent",
  "chat_session",
  "voice_note",
  "ai_job",
  "invite",
  "agency_invite",
] as const;
export const AdminTimelineSubjectType = z.enum(ADMIN_TIMELINE_SUBJECT_TYPES);
export type AdminTimelineSubjectType = z.infer<typeof AdminTimelineSubjectType>;

/** Coerce a query-string into a non-empty array (one or many `eventName=` repeats / CSV). */
const stringOrArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .pipe(z.array(z.string().min(1).max(128)).min(1).max(50));

/**
 * The shared event-filter shape (route #1 list + route #6 export). All fields optional; each
 * maps onto an existing index (`event_name`, `(subject_type, subject_id)`, `correlation_id`,
 * `occurred_at`) so a filtered query is index-backed, never a full scan.
 */
const eventFilterShape = {
  eventName: stringOrArray.optional(),
  actorType: z.string().min(1).max(64).optional(),
  actorId: z.string().uuid().optional(),
  subjectType: z.string().min(1).max(64).optional(),
  subjectId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  occurredFrom: z.coerce.date().optional(),
  occurredTo: z.coerce.date().optional(),
};

/**
 * GET /admin/events query. Keyset cursor on `(occurred_at, id)` — the cursor is an opaque
 * base64url token (see `admin-events.cursor.ts`); `limit` is hard-capped at
 * {@link ADMIN_EVENTS_PAGE_MAX}.
 */
export const AdminEventsQuerySchema = z
  .object({
    ...eventFilterShape,
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_EVENTS_PAGE_MAX)
      .optional()
      .default(ADMIN_EVENTS_PAGE_DEFAULT),
  })
  .strict();
export type AdminEventsQueryDto = z.infer<typeof AdminEventsQuerySchema>;

/** GET /admin/entities/:type/:id/timeline query (keyset-paginated, same cursor scheme). */
export const AdminTimelineQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_EVENTS_PAGE_MAX)
      .optional()
      .default(ADMIN_EVENTS_PAGE_DEFAULT),
  })
  .strict();
export type AdminTimelineQueryDto = z.infer<typeof AdminTimelineQuerySchema>;

/** GET /admin/entities/:type/:id/timeline params — `:type` is the whitelisted enum. */
export const AdminTimelineParamsSchema = z
  .object({
    type: AdminTimelineSubjectType,
    id: z.string().uuid(),
  })
  .strict();
export type AdminTimelineParamsDto = z.infer<typeof AdminTimelineParamsSchema>;

/** GET /admin/events/metrics query — bounded window, optional event-name scoping. */
export const AdminMetricsQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_METRICS_WINDOW_DAYS_MAX)
      .optional()
      .default(ADMIN_METRICS_WINDOW_DAYS_DEFAULT),
  })
  .strict();
export type AdminMetricsQueryDto = z.infer<typeof AdminMetricsQuerySchema>;

/** GET /admin/events/export query — same filters as the list + a `format` + hard row cap. */
export const AdminExportQuerySchema = z
  .object({
    ...eventFilterShape,
    format: z.enum(["csv", "json"]).optional().default("json"),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_EXPORT_ROW_MAX)
      .optional()
      .default(ADMIN_EXPORT_ROW_MAX),
  })
  .strict();
export type AdminExportQueryDto = z.infer<typeof AdminExportQuerySchema>;

// ---------------------------------------------------------------------------
// Response projections — PII-FREE by construction (ids + enums + timestamps + codes only).
// ---------------------------------------------------------------------------

/** The list/timeline row projection — the spine fields the UI needs, plus the (PII-free) payload. */
export interface AdminEventListItem {
  id: string;
  event_name: string;
  event_version: number;
  actor_type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string | null;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
}

/** The full event detail (route #2) — the envelope + the already-PII-free payload + metadata. */
export interface AdminEventDetail extends AdminEventListItem {
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
