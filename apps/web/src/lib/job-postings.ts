import { VACANCY_BANDS, type VacancyBand } from "@badabhai/types";

/**
 * Job-postings ops helpers (ADR-0010). No data access here — just the stub
 * ops-actor id, the band list for the create/edit selects, and the client-side
 * mirror of the server's description-only PII reject.
 */

/**
 * Stub ops-actor id; replace with the authenticated ops session id when ops auth
 * lands (Phase 2). There is no ops login in alpha, so the console supplies this
 * single opaque, v4-shaped uuid as `created_by` on create. The operator never
 * sees or types a raw uuid.
 */
export const OPS_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

/** The 5 vacancy bands, re-exported for the create/edit selects. */
export const VACANCY_BAND_OPTIONS: readonly VacancyBand[] = VACANCY_BANDS;

/** Default band for a fresh create form (smallest band). */
export const DEFAULT_VACANCY_BAND: VacancyBand = "1";

// ---------------------------------------------------------------------------
// Client-side mirror of the server's DESCRIPTION-ONLY PII reject.
//
// These regexes are copied verbatim from `looksLikePii` in
// @badabhai/validators (packages/validators/src/index.ts) — the same heuristic
// the API's job-postings DTO refines `description` with. They are replicated
// (not imported) so the web client doesn't pull `zod` + `@badabhai/types`'s
// validator graph into the browser bundle; keep them in sync with the shared
// validator if it ever changes.
//
// Apply ONLY to `description`. A long digit run in org_label / role_title /
// location_label is a legit machine model number / pincode / job code, so those
// fields are deliberately NOT screened (mirrors the server).
// ---------------------------------------------------------------------------
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_SEPARATORS = /[\s().+-]/g;
const PHONE_DIGIT_RUN = /\d{7,}/;

/** True if a string looks like an obvious phone number or email address. */
export function descriptionLooksLikePii(s: string): boolean {
  if (EMAIL_LIKE.test(s)) return true;
  return PHONE_DIGIT_RUN.test(s.replace(PHONE_SEPARATORS, ""));
}

/** The exact message the server returns for the description PII reject. */
export const DESCRIPTION_PII_MESSAGE = "remove contact details from the description";

/** Inline warning shown near every free-text field on the create/edit forms. */
export const FREE_TEXT_PII_WARNING =
  "Do not enter worker or personal contact details (phone, email). This is an internal register.";

/** Human-friendly labels for the lifecycle statuses (used by the status badge). */
export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
};
