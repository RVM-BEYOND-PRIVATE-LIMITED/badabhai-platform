import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The events data layer — the portal's read seam onto the audit spine.
 *
 * `audit_logs` has **zero writers** today; the events table IS the audit source
 * (D15). The richer 13-field record lands later behind {@link listAuditEntries}, so the
 * Audit view swaps its implementation rather than being redesigned.
 *
 * Every projection here is PII-free by construction on the server side: ids, enums,
 * timestamps and codes only. The portal does not re-check that — it could not, since it
 * cannot know which opaque id is which — it simply never asks for anything else.
 */

const countBucket = z.object({ key: z.string(), count: z.number() });

export const eventListItemSchema = z.object({
  id: z.string(),
  event_name: z.string(),
  event_version: z.number(),
  actor_type: z.string(),
  actor_id: z.string().nullable(),
  subject_type: z.string(),
  subject_id: z.string().nullable(),
  occurred_at: z.string(),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
});
export type EventListItem = z.infer<typeof eventListItemSchema>;

const eventsPageSchema = z.object({
  events: z.array(eventListItemSchema),
  nextCursor: z.string().nullable(),
});
export type EventsPage = z.infer<typeof eventsPageSchema>;

const eventDetailSchema = eventListItemSchema.extend({
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()),
});
export type EventDetail = z.infer<typeof eventDetailSchema>;

/**
 * A funnel stage. `suppressed` is the k-anonymity flag: when fewer than `k_anon_floor`
 * distinct subjects reached this stage, the server floors `distinct_subjects` to 0.
 *
 * The UI MUST NOT render that 0 as a count. "0 workers" and "too few workers to report"
 * are different claims, and printing the first would be a quiet lie on an operations
 * console — the exact thing that teaches operators to distrust every other number.
 */
const funnelStageSchema = z.object({
  event_name: z.string(),
  count: z.number(),
  distinct_subjects: z.number(),
  suppressed: z.boolean(),
});
export type FunnelStage = z.infer<typeof funnelStageSchema>;

/**
 * `by_day` does NOT use the `{key,count}` bucket shape the other two use — the server
 * emits `{day,count}`. Assuming otherwise made the whole metrics response fail to parse,
 * which (correctly, by design) surfaced as "metrics unavailable" rather than as a
 * half-rendered dashboard — but it meant the counters silently vanished.
 */
const dayBucket = z.object({ day: z.string(), count: z.number() });

/** Exported so tests can parse a REAL captured payload through it, not around it. */
export const metricsSchema = z.object({
  window_days: z.number(),
  by_event_name: z.array(countBucket),
  by_day: z.array(dayBucket),
  by_actor_type: z.array(countBucket),
  funnel: z.array(funnelStageSchema),
  breaches: z.array(countBucket),
  k_anon_floor: z.number(),
});
export type EventMetrics = z.infer<typeof metricsSchema>;

/** Filters the list route accepts. Mirrors `eventFilterShape` on the server. */
export interface EventFilters {
  eventName?: string;
  actorType?: string;
  subjectType?: string;
  correlationId?: string;
  cursor?: string;
  limit?: number;
}

function toQuery(filters: EventFilters): string {
  const q = new URLSearchParams();
  // Empty strings are dropped rather than sent: the server DTO is `.strict()` with
  // `.min(1)` on these, so a blank filter field would 400 the whole page.
  if (filters.eventName) q.set("eventName", filters.eventName);
  if (filters.actorType) q.set("actorType", filters.actorType);
  if (filters.subjectType) q.set("subjectType", filters.subjectType);
  if (filters.correlationId) q.set("correlationId", filters.correlationId);
  if (filters.cursor) q.set("cursor", filters.cursor);
  if (filters.limit) q.set("limit", String(filters.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function listEvents(filters: EventFilters = {}): Promise<EventsPage> {
  return adminFetch(`/admin/events${toQuery(filters)}`, { schema: eventsPageSchema });
}

export async function getEvent(id: string): Promise<EventDetail> {
  return adminFetch(`/admin/events/${encodeURIComponent(id)}`, { schema: eventDetailSchema });
}

export async function getMetrics(windowDays?: number): Promise<EventMetrics> {
  const q = windowDays ? `?windowDays=${windowDays}` : "";
  return adminFetch(`/admin/events/metrics${q}`, { schema: metricsSchema });
}

const traceSchema = z.object({
  correlation_id: z.string(),
  events: z.array(eventDetailSchema),
});

export async function getTrace(correlationId: string) {
  return adminFetch(`/admin/events/trace/${encodeURIComponent(correlationId)}`, {
    schema: traceSchema,
  });
}

/**
 * Subject types the per-entity timeline route (`GET /admin/entities/:type/:id/timeline`)
 * accepts. Mirrors `ADMIN_TIMELINE_SUBJECT_TYPES` in `apps/api/src/admin/admin-events.dto.ts`
 * verbatim, so an unsupported type is a compile-time error here rather than a runtime 400
 * from the server's whitelist.
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
export type AdminTimelineSubjectType = (typeof ADMIN_TIMELINE_SUBJECT_TYPES)[number];

const entityTimelineSchema = z.object({
  subject_type: z.string(),
  subject_id: z.string(),
  events: z.array(eventListItemSchema),
  nextCursor: z.string().nullable(),
});
export type EntityTimeline = z.infer<typeof entityTimelineSchema>;

export interface EntityTimelineQuery {
  cursor?: string;
  limit?: number;
}

function toTimelineQuery(query: EntityTimelineQuery): string {
  const q = new URLSearchParams();
  if (query.cursor) q.set("cursor", query.cursor);
  if (query.limit) q.set("limit", String(query.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Route #4 — every event recorded for one subject, keyset-paginated. The endpoint the
 * per-entity "View event timeline" links were always meant to call, instead of the generic
 * `/admin/events` filter (which has no `subjectId` filter and would show every entity's
 * events, not just this one's).
 */
export async function getEntityTimeline(
  type: AdminTimelineSubjectType,
  id: string,
  query: EntityTimelineQuery = {},
): Promise<EntityTimeline> {
  return adminFetch(
    `/admin/entities/${type}/${encodeURIComponent(id)}/timeline${toTimelineQuery(query)}`,
    { schema: entityTimelineSchema },
  );
}

/**
 * The AUDIT read seam (D15).
 *
 * Deliberately a NARROW interface over the events spine rather than a pass-through: when
 * the 13-field `audit_logs` record ships, this function changes implementation and the
 * Audit screen does not change at all. Building the screen directly against the events
 * response shape is what would force a redesign later.
 */
export interface AuditEntry {
  id: string;
  occurredAt: string;
  /** The acting admin, when the event records one. */
  actorId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string | null;
  correlationId: string;
}

export interface AuditQuery {
  action?: string;
  actorType?: string;
  cursor?: string;
  limit?: number;
}

export async function listAuditEntries(
  query: AuditQuery = {},
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const page = await listEvents({
    eventName: query.action,
    actorType: query.actorType,
    cursor: query.cursor,
    limit: query.limit,
  });
  return {
    entries: page.events.map((e) => ({
      id: e.id,
      occurredAt: e.occurred_at,
      actorId: e.actor_id,
      actorType: e.actor_type,
      action: e.event_name,
      targetType: e.subject_type,
      targetId: e.subject_id,
      correlationId: e.correlation_id,
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * Platform health. `/health` is the API's own public probe — the portal reads it
 * server-side so the browser never learns the internal origin.
 *
 * `ai_posture` matters more than `ai_service`: TD81 is the case where the service is
 * absent but `/health` still 200s, and the posture field is what makes "we are silently
 * running mocked AI" visible instead of looking healthy.
 */
const healthSchema = z.object({
  status: z.string(),
  service: z.string(),
  environment: z.string(),
  timestamp: z.string(),
  checks: z.record(z.string()),
});
export type PlatformHealth = z.infer<typeof healthSchema>;

export async function getHealth(): Promise<PlatformHealth> {
  // `public: true` — /health takes no admin token, and sending one would be pointless
  // credential exposure on a route that does not read it.
  return adminFetch("/health", { schema: healthSchema, public: true });
}
