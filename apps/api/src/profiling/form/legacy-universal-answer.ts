/**
 * ═══ THE EIGHT KEYS `f455bb36` SERVED ON TRADE FORMS, FROZEN (#1503) ═══
 *
 * For three days every trade form carried all eight `qp_universal@2` questions. #1503 removes
 * them (owner ruling 2026-09-15: résumé facts live on the pages that own them, never on extra
 * question screens). An app holding a schema fetched BEFORE that deploy can still POST one of these
 * keys for the screen it is showing.
 *
 * WHY THAT MUST NOT 400. The app re-reads the schema after every response
 * (`trade_form_repository_impl.dart:207`), so the exposure is one screen mid-session — but on a
 * 400 the cubit keeps the worker on the SAME screen, and "skip" POSTs the same key and 400s too.
 * The worker is stranded until he kills the app. CLAUDE.md §3: never break an API a shipped client
 * is calling.
 *
 * A LITERAL, NOT DERIVED FROM `loadUniversal()`. This is the list of keys one specific commit put on
 * the wire, and it must never widen: a `qp_universal@3` that adds a ninth question did not ship on
 * any trade form, so no client can be holding it, so the shim has no business accepting it. Deriving
 * the list from the live pack would silently re-open a second write path for every question the
 * universal pack ever gains.
 *
 * REMOVAL: once the shim's count-only log line has read zero across a release window.
 */
export const LEGACY_FORM_UNIVERSAL_KEYS: readonly string[] = Object.freeze([
  "primary_trade",
  "experience_years",
  "current_city",
  "salary_expected",
  "preferred_locations",
  "availability",
  "education",
  "shift_preference",
]);

export function isLegacyFormUniversalKey(questionKey: string): boolean {
  return LEGACY_FORM_UNIVERSAL_KEYS.includes(questionKey);
}
