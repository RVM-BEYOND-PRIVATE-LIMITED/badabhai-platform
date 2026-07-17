import { z } from "zod";
import {
  LANGUAGE_CODES,
  MAX_VOICE_NOTE_SECONDS,
  CONSENT_PURPOSES,
  type VacancyBand,
} from "@badabhai/types";

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

// ---------------------------------------------------------------------------
// Best-effort ORG-NAME shape detection (worker-visible job free text, ADR-0024)
// ---------------------------------------------------------------------------

// Strong legal-entity markers — safe to match ANYWHERE, case-insensitively (each
// is a suffix shape that essentially never occurs in legitimate trade text):
// Pvt Ltd / Pvt. Ltd., Private Limited, LLP, Inc, Corp/Corporation, "& Co" /
// "and Co", and "Co." — where the DOT is REQUIRED so "co-worker" and words that
// merely start with "co" ("control") stay legal.
const ORG_SUFFIX_STRONG = new RegExp(
  [
    String.raw`\bpvt\.?\s+ltd\b`, // Pvt Ltd / Pvt. Ltd.
    String.raw`\bprivate\s+limited\b`, // Private Limited
    String.raw`\bllp\b`, // LLP
    String.raw`\binc\b`, // Inc / Inc.
    String.raw`\bcorp(?:oration)?\b`, // Corp / Corp. / Corporation
    String.raw`(?:&|\band)\s+co\b`, // "& Co" / "and Co"
    String.raw`\bco\.`, // "Co." (dot REQUIRED — bare "co"/"co-worker" pass)
  ].join("|"),
  "i",
);

// Bare "Ltd"/"Limited" WITHOUT a pvt/private prefix is genuinely ambiguous:
// "limited experience ok" is legal trade prose. So the bare form is flagged only
// in TRAILING ENTITY-SUFFIX POSITION — preceded by a Capitalized-ish token and at
// end-of-string (or followed only by punctuation). The suffix is spelled with
// per-letter classes because the Capitalized-token requirement forbids the `i`
// flag (which would also case-fold the [A-Z] class).
const ORG_TRAILING_LTD = new RegExp(
  String.raw`(?:^|\s)[A-Z][\w&.'()-]*\s+(?:[Ll][Tt][Dd]|[Ll][Ii][Mm][Ii][Tt][Ee][Dd])\.?\s*(?:$|[.,;:!?)\]])`,
);

/**
 * Best-effort heuristic: true if a string looks like it contains a LEGAL-ENTITY
 * company name — an org-suffix marker such as "Pvt Ltd" / "Pvt. Ltd." /
 * "Private Limited" / "LLP" / "Inc" / "Corp"/"Corporation" / "& Co"/"and Co" /
 * "Co.", or a trailing bare "Ltd"/"Limited" in entity position. The fail-closed
 * companion to {@link looksLikePii} for worker-visible job free text (title /
 * description / benefits / requirements items) — ADR-0024 final addendum
 * (2026-07-16): employer identity must never enter the worker-visible `jobs`
 * columns, so every jobs write path rejects strings this flags.
 *
 * NOT a classifier: it is deliberately TIGHT to legal-entity suffix markers and
 * will NOT catch a bare brand name ("Sharma Precision") or generic org-ish words
 * ("Industries" / "Works" / "Engineering" alone — far too many false positives
 * on legitimate trade text). Tradeoffs, documented and pinned by tests:
 *  - bare "Ltd"/"Limited" is flagged ONLY as a TRAILING entity suffix (preceded
 *    by a Capitalized-ish token, at end-of-string or followed by punctuation),
 *    so plain prose like "limited experience ok" is never rejected;
 *  - consequence: an all-lowercase "acme ltd" (or a mid-sentence bare "Ltd")
 *    slips that tier — the strong markers still catch the Pvt Ltd / Private
 *    Limited / LLP / Inc / Corp / & Co / Co. forms anywhere, case-blind.
 * Callers must still keep employer identity out of these fields by policy.
 */
export function looksLikeOrgName(s: string): boolean {
  return ORG_SUFFIX_STRONG.test(s) || ORG_TRAILING_LTD.test(s);
}

// ---------------------------------------------------------------------------
// Best-effort URL / link shape detection (worker-visible job free text, ADR-0024)
// ---------------------------------------------------------------------------

// Link shapes: an explicit http(s) scheme, a "www." prefix, or a dotted common
// TLD. The TLD tier requires the dot IMMEDIATELY before the TLD token
// ("acme.in", "acme-components.com", "acme.co.in") — prose like "2.5 in" (space
// before "in") or an org-suffix "Co." (dot AFTER "co") never matches.
const URL_SCHEME = /\bhttps?:\/\//i;
const URL_WWW = /\bwww\./i;
const URL_TLD = /\.(?:com|net|org|co\.in|co|in|io|biz|info)\b/i;

/**
 * Best-effort heuristic: true if a string looks like it contains a URL / web
 * link — an explicit http(s) scheme, a "www." prefix, or a dotted common TLD.
 * The THIRD fail-closed companion (with {@link looksLikePii} and
 * {@link looksLikeOrgName}) for worker-visible job free text — the ADR-0024
 * final addendum's HIDDEN clause bars contact LINKS from every `jobs` write
 * path, so a link-shaped string in title/description/benefits/requirements is
 * rejected before it can reach a worker.
 *
 * NOT a classifier: spelled-out domains ("acme dot in") and exotic TLDs slip —
 * callers must still keep contact routes out of these fields by policy.
 */
export function looksLikeUrl(s: string): boolean {
  return URL_SCHEME.test(s) || URL_WWW.test(s) || URL_TLD.test(s);
}

// ---------------------------------------------------------------------------
// Vacancy band derivation (ADR-0012: job_postings is BANDED, not an integer)
// ---------------------------------------------------------------------------

/**
 * Map a RAW vacancy count to the existing shipped band (`VACANCY_BANDS`).
 *
 * The raw count is INTAKE-ONLY: it is derived to a band at the boundary and the
 * integer is then discarded — it is NEVER stored on a column and NEVER put in an
 * event. This keeps ADR-0012 intact (postings stay banded, not counted).
 *
 * Boundaries reproduce the EXACT shipped band strings:
 *   n <= 1        -> "1"
 *   2 <= n <= 5   -> "2-5"
 *   6 <= n <= 10  -> "6-10"
 *   11 <= n <= 25 -> "11-25"
 *   n >= 26       -> "25+"
 *
 * Note the 25/26 boundary: "25+" means STRICTLY GREATER than 25 — 25 itself
 * falls in "11-25". Defensive guard: a non-positive-integer `n` is invalid (the
 * DTO already blocks it, but the helper fails closed rather than guessing).
 */
export function bandForCount(n: number): VacancyBand {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`vacancy count must be a positive integer, got: ${n}`);
  }
  if (n <= 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 10) return "6-10";
  if (n <= 25) return "11-25";
  return "25+";
}

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type ConsentPurposes = z.infer<typeof consentPurposesSchema>;
