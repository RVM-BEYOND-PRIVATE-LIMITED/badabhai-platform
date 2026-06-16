import { z } from "zod";
import { LANGUAGE_CODES, MAX_VOICE_NOTE_SECONDS, CONSENT_PURPOSES } from "@badabhai/types";

/**
 * @badabhai/validators — reusable Zod schemas shared by API DTOs, AI contracts,
 * and tests. Keep these small and composable.
 */

/**
 * E.164 phone number, e.g. "+919876543210".
 * Leading "+", first digit 1-9, total 8-15 digits.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Must be a valid E.164 phone number (e.g. +919876543210)");

export function isE164Phone(value: string): boolean {
  return e164PhoneSchema.safeParse(value).success;
}

/** RFC 4122 UUID. */
export const uuidSchema = z.string().uuid();

/** Supported language code (see @badabhai/types LANGUAGE_CODES). */
export const languageCodeSchema = z.enum(LANGUAGE_CODES);

/**
 * Voice note duration in seconds. Must be > 0 and <= 120 (Phase 1 hard limit).
 */
export const voiceDurationSecondsSchema = z
  .number()
  .positive("Duration must be greater than 0")
  .max(MAX_VOICE_NOTE_SECONDS, `Duration must be at most ${MAX_VOICE_NOTE_SECONDS} seconds`);

export function isValidVoiceDuration(seconds: number): boolean {
  return voiceDurationSecondsSchema.safeParse(seconds).success;
}

/** Non-empty (after trim) message string. */
export const nonEmptyMessageSchema = z
  .string()
  .trim()
  .min(1, "Message must not be empty");

/** Default maximum length for free-text fields. */
export const DEFAULT_SAFE_TEXT_MAX = 5000;

/** Safe bounded free text. Defaults to a 5000-char cap. */
export function safeTextSchema(maxLength: number = DEFAULT_SAFE_TEXT_MAX) {
  return z.string().trim().min(1).max(maxLength);
}

/** Consent purposes — must be a non-empty subset of the known purposes. */
export const consentPurposesSchema = z
  .array(z.enum(CONSENT_PURPOSES))
  .min(1, "At least one consent purpose is required")
  .refine((arr) => new Set(arr).size === arr.length, "Consent purposes must be unique");

// ---------------------------------------------------------------------------
// Worker-conversation Storage object keys (ADR-0003)
// ---------------------------------------------------------------------------

/**
 * Object-key contract for the private `worker-conversations` Storage bucket.
 *
 *   <worker_id>/<session_id>/v<version>.json
 *
 * The key carries ONLY opaque UUIDs + an integer version — never PII — and is
 * namespaced by worker so every object for a worker can be listed/deleted by a
 * single prefix (DPDP erasure on consent revoke). The bucket name itself comes
 * from `CONVERSATIONS_BUCKET` (server config); these helpers build the key
 * WITHIN that bucket. They are the frozen path contract the chat-persistence
 * wiring writes against — see ADR-0003.
 */
export interface ConversationObjectKeyParts {
  workerId: string;
  sessionId: string;
  /** Monotonic snapshot version, starting at 1. */
  version: number;
}

const conversationVersionSchema = z
  .number()
  .int("Conversation version must be an integer")
  .positive("Conversation version must be >= 1");

/**
 * Prefix covering every conversation object for one worker — use to list/delete
 * all of a worker's archived conversations (DPDP erasure). Throws if `workerId`
 * is not a UUID (fail closed — a non-opaque id must never become a storage path).
 */
export function conversationWorkerPrefix(workerId: string): string {
  return `${uuidSchema.parse(workerId)}/`;
}

/**
 * Build the opaque object key for a worker conversation snapshot. Throws if any
 * id is not a UUID (fail closed — never let PII reach a storage path) or the
 * version is not a positive integer. The result always starts with
 * `conversationWorkerPrefix(workerId)`, so prefix deletion covers it.
 */
export function conversationObjectKey(parts: ConversationObjectKeyParts): string {
  const workerId = uuidSchema.parse(parts.workerId);
  const sessionId = uuidSchema.parse(parts.sessionId);
  const version = conversationVersionSchema.parse(parts.version);
  return `${workerId}/${sessionId}/v${version}.json`;
}

// ---------------------------------------------------------------------------
// Best-effort PII shape detection (capture-boundary guard)
// ---------------------------------------------------------------------------

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Separators commonly used inside phone numbers; stripped before counting digits
// so spaced/punctuated forms ("98765 43210", "+91-98765-43210") are still caught.
const PHONE_SEPARATORS = /[\s().+-]/g;
const PHONE_DIGIT_RUN = /\d{7,}/;

/**
 * Best-effort heuristic: true if a string looks like an OBVIOUS phone number or
 * email address. Used at capture boundaries (e.g. the actions context bag) to
 * fail closed on raw PII before it reaches the events table.
 *
 * NOT a PII classifier: it only catches email-shaped strings and long digit runs
 * (after stripping common phone separators). It will NOT catch names, addresses,
 * employer names, or other PII — callers must still keep free text out of fields
 * that flow into events/logs.
 */
export function looksLikePii(s: string): boolean {
  if (EMAIL_LIKE.test(s)) return true;
  return PHONE_DIGIT_RUN.test(s.replace(PHONE_SEPARATORS, ""));
}

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type ConsentPurposes = z.infer<typeof consentPurposesSchema>;
