import { z } from "zod";

/**
 * Zod DTOs for the ADMIN-3b reason-gated worker-PII reveal (ADR-0025 Decision 4) — the single
 * most sensitive route in the system (it decrypts a worker's phone). The body is `.strict()` so
 * no extra (PII-shaped) key can ride in, the `reason_code` is a CLOSED enum (a code, never free
 * text), and the optional `note` is length-bounded AND residual-PII-rejected.
 *
 * The target worker id is the validated PATH param (see {@link AdminPiiRevealParamsSchema}); the
 * actor is always the SESSION admin (`@CurrentAdmin().id`). No body carries an actor or target id.
 */

/** A uuid path param (`:id`) — the spoofing-proof target worker id (validated, never from body). */
export const AdminPiiRevealParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminPiiRevealParamsDto = z.infer<typeof AdminPiiRevealParamsSchema>;

/**
 * The CLOSED reason CODE behind a PII reveal (ADR-0025 Decision 4, must-fix #6/#7). It is the
 * audit fact recorded on `admin.pii_viewed.reason_code` — a code, NEVER free text, NEVER the note.
 * A missing/invalid reason is a 400 with no reveal (Control 2).
 */
export const ADMIN_PII_REVEAL_REASONS = [
  "worker_support_callback",
  "dispute_resolution",
  "safety_escalation",
] as const;
export const AdminPiiRevealReason = z.enum(ADMIN_PII_REVEAL_REASONS);
export type AdminPiiRevealReason = z.infer<typeof AdminPiiRevealReason>;

/** Max length of the optional free-text reveal note (Control 3). */
export const ADMIN_PII_REVEAL_NOTE_MAX = 280;

/**
 * Residual-PII detectors for the optional `note` (must-fix #6). MIRRORS the AI service's
 * `pseudonymize.py` residual checks so the note is held to the SAME bar as anything heading toward
 * an LLM — a note that contains a phone-shaped digit run / an email is REJECTED (400), never
 * persisted, never logged, never put on the event. The note is the ONE place an admin could
 * scribble a worker's contact back in; this closes that hole.
 */
// A "+"-optional run of >= ~9 digits possibly spaced/dashed (phone-like) — mirrors
// pseudonymize.py `_PHONE_RE`.
const PHONE_LIKE_RE = /(?<!\d)\+?\d[\d\s-]{7,}\d(?!\d)/;
// Any remaining long digit run — mirrors pseudonymize.py `_RESIDUAL_DIGITS_RE` (the fail-closed
// numeric-PII net: Aadhaar/account/long id numbers).
const RESIDUAL_DIGITS_RE = /\d{7,}/;
// A basic email shape (an additional PII channel a free-text note could smuggle a contact in).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** True when `note` contains residual contact-PII (phone-shaped digits / long digit run / email). */
export function noteHasResidualPii(note: string): boolean {
  return PHONE_LIKE_RE.test(note) || RESIDUAL_DIGITS_RE.test(note) || EMAIL_RE.test(note);
}

/**
 * POST /admin/workers/:id/reveal-contact body — the CLOSED reason code + an OPTIONAL note. The
 * note is length-bounded (≤280) AND residual-PII-rejected (must-fix #6): a phone-shaped digit run
 * / long digit run / email → 400. The note is VALIDATED but NOT persisted and NEVER enters the
 * `admin.pii_viewed` payload (schema-locked to {admin_id, subject_id, reason_code}) — the
 * `reason_code` + the event are the audit trail. `.strict()` rejects any extra key.
 */
export const AdminPiiRevealSchema = z
  .object({
    reason_code: AdminPiiRevealReason,
    note: z
      .string()
      .max(ADMIN_PII_REVEAL_NOTE_MAX)
      .refine((n) => !noteHasResidualPii(n), {
        message: "note must not contain a phone number, email, or other contact details",
      })
      .optional(),
  })
  .strict();
export type AdminPiiRevealDto = z.infer<typeof AdminPiiRevealSchema>;

/** The reveal response — the decrypted phone exists SOLELY here (Control 8). ids + the phone only. */
export interface AdminPiiRevealResponse {
  worker_id: string;
  phone: string;
}
