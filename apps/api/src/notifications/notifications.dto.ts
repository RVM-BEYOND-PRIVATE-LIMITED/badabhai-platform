/**
 * Worker Alerts feed contract (GET /workers/me/notifications).
 *
 * The feed is a FACELESS, PII-FREE projection of the worker's OWN real events
 * (CLAUDE.md §2). Copy is SERVER-RENDERED from the static allowlist below, keyed by
 * `event_name` — the event PAYLOAD is NEVER passed through. So no employer name/id,
 * phone, raw name, or pay can reach the client even if a payload carried one. A row
 * carries only the event id, a coarse type, faceless copy, and the timestamp.
 *
 * Adding an event to {@link NOTIFICATION_TEMPLATES} is the ONLY way it can surface —
 * the allowlist IS the safety boundary. Interview-kit is intentionally ABSENT:
 * `interview_kit.render_completed` carries no `worker_id` (a shared per-trade
 * artifact, subject_id=null) so it is not worker-scopable — see TD in
 * docs/registers/tech-debt-register.md.
 */

/** Coarse notification type the client maps to an icon/tone. NOT the event name. */
export type NotificationType =
  | "resume_ready"
  | "resume_updated"
  | "profile_ready"
  | "voice_processed"
  | "security";

/** One faceless template: what a worker sees for an allowlisted event. */
interface NotificationTemplate {
  type: NotificationType;
  title: string;
  body: string;
}

/**
 * The ALLOWLIST — the only events that become worker notifications, each mapped to
 * faceless, PII-free copy. Event names are VERIFIED against
 * packages/event-schema/src/registry.ts. All are worker-lifecycle / security signals
 * (no employer/demand signals in this scope).
 */
export const NOTIFICATION_TEMPLATES: Readonly<Record<string, NotificationTemplate>> = {
  // resume.generated (registry.ts) — actor=system, worker_id in payload.
  "resume.generated": {
    type: "resume_ready",
    title: "Resume taiyaar hai",
    body: "Aapka naya resume ban gaya — dekhein aur download karein.",
  },
  // resume.regenerated — actor=system, worker_id in payload.
  "resume.regenerated": {
    type: "resume_updated",
    title: "Resume update hua",
    body: "Aapke resume ka naya version taiyaar hai.",
  },
  // profile.confirmed — actor=worker, subject=profile.
  "profile.confirmed": {
    type: "profile_ready",
    title: "Profile taiyaar hai",
    body: "Aapki profile confirm ho gayi.",
  },
  // voice_note.transcription_completed — actor=ai_service, worker_id in payload.
  "voice_note.transcription_completed": {
    type: "voice_processed",
    title: "Voice note taiyaar",
    body: "Aapka voice note process ho gaya.",
  },
  // worker.device_registered — actor=subject=worker.
  "worker.device_registered": {
    type: "security",
    title: "Naye device se login",
    body: "Aapke account mein ek naye device se login hua.",
  },
  // worker.logged_out_all — actor=subject=worker.
  "worker.logged_out_all": {
    type: "security",
    title: "Sabhi devices se logout",
    body: "Aapko sabhi devices se logout kar diya gaya.",
  },
};

/**
 * The allowlisted event names — the query filter. DERIVED from the templates so it
 * can never drift: an event is queryable iff it has a faceless template.
 */
export const NOTIFICATION_EVENT_NAMES: readonly string[] = Object.keys(NOTIFICATION_TEMPLATES);

/**
 * One notification row on the wire. PII-FREE: no `worker_id` (it IS the caller), no
 * `payer_id`, no employer, no pay — only the event id, coarse type, faceless copy,
 * and the ISO timestamp.
 */
export interface WorkerNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  created_at: string; // ISO-8601 (the event's occurred_at)
}
