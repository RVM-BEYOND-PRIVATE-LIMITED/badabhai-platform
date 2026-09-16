/**
 * ═══ THE EIGHT KEYS `f455bb36` SERVED ON TRADE FORMS, FROZEN (#1503) ═══
 *
 * For three days every trade form carried all eight `qp_universal@2` questions. #1503 removes
 * them (owner ruling 2026-09-15: résumé facts live on the pages that own them, never on extra
 * question screens). An app holding a schema fetched BEFORE that deploy can still POST one of these
 * keys for the screen it is showing.
 *
 * WHY THAT MUST NOT 400. The app only re-reads the schema when told to: `TradeFormCubit.
 * answerQuestion` re-fetches and re-flattens (`_resyncAfterStaleSchema`, `trade_form_cubit.dart`)
 * exactly when the answer response carries `schema_stale: true` — and `answerLegacyUniversalKey`'s
 * response below always sets that flag, so accepting one of these eight keys is what TRIGGERS the
 * resync that clears the stale screen from the worker's walk. A 400 instead would skip that trigger
 * entirely: the cubit leaves the worker on the SAME screen on a 400, and "skip" POSTs the same key
 * and 400s too, so he is stranded until he kills the app. A build that predates
 * `schema_stale`/`_resyncAfterStaleSchema` (#1382) simply ignores the flag and keeps its stale
 * screen list for the rest of the session — this shim's response shape (200, no `worker_attributes`
 * write, no completion side effect) is also safe for that older build, since it never writes
 * anything the rest of the form or the sheet depends on. CLAUDE.md §3: never break an API a shipped
 * client is calling.
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
