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
 *
 * Copy is per-language (TD89): each template holds a Record of language codes to static
 * copy. The worker's `preferred_language` selects the variant at read time. Fallback
 * chain: requested lang → `en` → first available. Copy is NEVER interpolated from an
 * event payload — same §2 guarantee, now localized.
 */

import type { LanguageCode } from "@badabhai/types";

/** Coarse notification type the client maps to an icon/tone. NOT the event name. */
export type NotificationType =
  | "resume_ready"
  | "resume_updated"
  | "profile_ready"
  | "voice_processed"
  | "application_sent"
  | "security";

/** Static copy for one language — title + body, never interpolated. */
export interface TemplateCopy {
  title: string;
  body: string;
}

/** One faceless template: what a worker sees for an allowlisted event. */
interface NotificationTemplate {
  type: NotificationType;
  /** Static copy per language code — at minimum `hi` must exist. */
  copy: Partial<Record<LanguageCode, TemplateCopy>>;
  /**
   * ADR-0034 — does this template ALSO go out as an FCM push?
   *
   * Deliberately a field on the SAME map rather than a second list: the in-app feed and
   * push then share one allowlist and cannot drift, and the §2 guarantee that makes the
   * feed safe (static, server-rendered copy; the event payload is never read) covers
   * push unchanged — which matters more here, because an FCM payload crosses Google's
   * infrastructure.
   *
   * SCOPE (owner ruling 2026-07-17): SECURITY ALERTS ONLY. Resume/profile/voice pushes
   * are deferred — they are valuable but they are not why we are shipping this, and a
   * quiet start is the right posture for a channel that buzzes a worker's phone.
   */
  push: boolean;
}

/** Select the best available copy for a language. Falls back: requested → en → first. */
export function templateCopy(
  template: NotificationTemplate,
  lang?: LanguageCode | null,
): TemplateCopy {
  const fallback = template.copy["en"] ?? Object.values(template.copy)[0]!;
  return template.copy[lang ?? "hi"] ?? fallback;
}

/**
 * The ALLOWLIST — the only events that become worker notifications, each mapped to
 * faceless, PII-free copy. Event names are VERIFIED against
 * packages/event-schema/src/registry.ts.
 *
 * SCOPE (widened 2026-07-17): worker-lifecycle / security signals, PLUS the worker's
 * OWN apply action (`application.submitted`). The original scope excluded
 * "employer/demand signals"; that line still holds for anything the EMPLOYER does —
 * an unlock, a view, a payer action must NEVER surface here. What was added is the
 * worker's own outbound act, which is worker-lifecycle by nature: they did it, so
 * telling them it happened reveals nothing they don't already know.
 *
 * The employer stays invisible regardless: copy is STATIC and server-rendered from
 * this map, and the event payload is never selected (see notifications.repository.ts),
 * so no employer identity, job title, or pay can reach the client — ADR-0024 rules
 * employer identity HIDDEN from workers, and this feed cannot breach that by
 * construction.
 */
export const NOTIFICATION_TEMPLATES: Readonly<Record<string, NotificationTemplate>> = {
  // resume.generated (registry.ts) — actor=system, worker_id in payload.
  "resume.generated": {
    type: "resume_ready",
    copy: {
      hi: { title: "Resume taiyaar hai", body: "Aapka naya resume ban gaya — dekhein aur download karein." },
      en: { title: "Resume ready", body: "Your new resume is ready — view and download." },
    },
    push: false, // deferred (ADR-0034 scope: security only)
  },
  // resume.regenerated — actor=system, worker_id in payload.
  "resume.regenerated": {
    type: "resume_updated",
    copy: {
      hi: { title: "Resume update hua", body: "Aapke resume ka naya version taiyaar hai." },
      en: { title: "Resume updated", body: "Your resume has been updated to a new version." },
    },
    push: false, // deferred
  },
  // profile.confirmed — actor=worker, subject=profile.
  "profile.confirmed": {
    type: "profile_ready",
    copy: {
      hi: { title: "Profile taiyaar hai", body: "Aapki profile confirm ho gayi." },
      en: { title: "Profile ready", body: "Your profile has been confirmed." },
    },
    push: false, // deferred
  },
  // voice_note.transcription_completed — actor=ai_service, worker_id in payload.
  "voice_note.transcription_completed": {
    type: "voice_processed",
    copy: {
      hi: { title: "Voice note taiyaar", body: "Aapka voice note process ho gaya." },
      en: { title: "Voice note ready", body: "Your voice note has been processed." },
    },
    push: false, // deferred
  },
  // application.submitted — actor=worker, worker_id in payload. (subject=job, so the
  // subject leg of the repository's OR does NOT match; the actor + payload legs do.)
  // Copy names NOTHING about the job or employer — the worker knows what they applied
  // to; this is only the "it landed" receipt. NOTE: the copy guard in
  // notifications.service.test.ts bans the bare nouns employer/company/payer in
  // worker-facing copy (a deliberate bright line, ADR-0024) — hence "aage pahunch
  // gayi" rather than "employer tak pahunch gayi". Same receipt, no counterparty.
  "application.submitted": {
    type: "application_sent",
    copy: {
      hi: { title: "Application bhej di", body: "Aapki application aage pahunch gayi." },
      en: { title: "Application sent", body: "Your application has been submitted." },
    },
    push: false, // NEVER: the worker just tapped apply — buzzing them about their own action is noise
  },
  // worker.device_registered — actor=subject=worker.
  "worker.device_registered": {
    type: "security",
    copy: {
      hi: { title: "Naye device se login", body: "Aapke account mein ek naye device se login hua." },
      en: { title: "New device login", body: "A new device has logged into your account." },
    },
    // PUSH: the SIM-swap alarm. Goes to the worker's OTHER devices, never the one that
    // just logged in — otherwise an attacker's handset gets the warning and the real
    // owner does not (owner ruling 2026-07-17).
    push: true,
  },
  // worker.logged_out_all — actor=subject=worker.
  "worker.logged_out_all": {
    type: "security",
    copy: {
      hi: { title: "Sabhi devices se logout", body: "Aapko sabhi devices se logout kar diya gaya." },
      en: { title: "Logged out everywhere", body: "You have been logged out of all devices." },
    },
    // PUSH: goes to the devices this operation JUST revoked — the one case allowed to
    // target revoked devices, because telling them is the entire point.
    push: true,
  },
};

/**
 * The allowlisted event names — the query filter. DERIVED from the templates so it
 * can never drift: an event is queryable iff it has a faceless template.
 */
export const NOTIFICATION_EVENT_NAMES: readonly string[] = Object.keys(NOTIFICATION_TEMPLATES);

/**
 * The SECURITY subset — the events that get RESERVED slots in the feed (TD82).
 *
 * DERIVED from the templates by `type === "security"`, exactly like the list above, so
 * it cannot drift either: marking a template `security` is the ONLY way in, and the
 * allowlist stays the single boundary.
 *
 * WHY a reserved leg exists: the feed is capped (newest-first), and every event here
 * was once-per-worker-lifetime until `application.submitted` landed (2026-07-17) — the
 * first HIGH-FREQUENCY, per-worker-unbounded event in the feed, on a swipe surface
 * designed for rapid tapping (ADR-0009). Without a reserve, a worker who applies to
 * enough jobs in one session pushes an account-takeover tripwire
 * (`worker.device_registered`) out of the window — SILENTLY, since there is no
 * pagination and no server-side read state. A degraded security channel would look
 * exactly like a quiet one.
 */
export const SECURITY_EVENT_NAMES: readonly string[] = Object.entries(NOTIFICATION_TEMPLATES)
  .filter(([, t]) => t.type === "security")
  .map(([name]) => name);

/**
 * ADR-0034 — the PUSH subset. DERIVED from the templates (`push === true`) exactly like
 * the two lists above, so it cannot drift: flagging a template is the ONLY way an event
 * can buzz a phone, and the allowlist stays the single boundary.
 *
 * ⚠ `worker.push_sent` / `worker.push_send_failed` must NEVER be added to
 * NOTIFICATION_TEMPLATES. A push emits an event; if that event were itself pushable the
 * fan-out would push → emit → push forever. `push.service.test.ts` pins the disjointness.
 */
export const PUSH_EVENT_NAMES: readonly string[] = Object.entries(NOTIFICATION_TEMPLATES)
  .filter(([, t]) => t.push)
  .map(([name]) => name);

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
