import { titleCaseWords } from "@badabhai/validators";

/**
 * THE CASING A WORKER-TYPED EMPLOYER NAME AND EDUCATION FIELD ARE STORED IN (#1940).
 *
 * ═══ WHY THE API CASES AT ALL ═══
 *
 * Since worker-app f55a020f the trade form title-cases `employer_name`, `role_label` and the
 * education `field` before its PUT. Every other writer sent them as typed, and the API stored them
 * as received: the companion v2 edit card, the finishing form, the extracted-review education
 * form, an extracted-profile correction, and any app build older than that release. So the #1432
 * backfill could never stay one-time; lowercase rows kept arriving behind it.
 *
 * ═══ ONE PLACE, AND EVERY WRITER INHERITS IT ═══
 *
 * `WorkerEmploymentService.replaceForWorker` and `WorkerQualificationsService.replaceForWorker` are
 * the only writers of `worker_employment.employer_name_enc` and `worker_education.field`. Every path
 * above reaches one of them: the two PUT routes, `ExtractedCorrectionsService` and
 * `CompanionEditService.confirm`. They run these functions on the value they are about to store,
 * so no caller can skip the casing, and no controller or repository holds a rule of its own.
 *
 * ═══ THE APP'S RULE, EXACTLY ═══
 *
 * `titleCaseWords` (`@badabhai/validators`, #1929) is a port of the app's `titleCaseName`, held to it
 * on every Unicode scalar value. It raises the first letter of each whitespace-separated word and
 * never lowercases anything, so "RVM CAD" and "CNC Machinist" are stored byte-identical. It is
 * idempotent, so a value the app already cased is stored exactly as sent. It is also the function
 * the #1432 backfill applies, so a row written here is one that backfill never changes. It never
 * changes a string's length, so a value the DTO's length bound accepted cannot outgrow its column.
 *
 * It is NOT `resume-text-case.ts`'s `titleCaseName`. That one is the renderer's wider print rule
 * (a hyphen, `(` and `&` also start a word there), and it stays a render-time concern.
 *
 * ═══ NOT `role_label` ═══
 *
 * The app cases role labels too, but this rule turns "cnc turner" into "Cnc Turner", which reads as
 * a misspelt trade, and the renderer deliberately leaves role labels alone. Whether the API cases
 * them is an open owner decision on #1940, so nothing here touches them. A role label is stored
 * exactly as it arrives.
 *
 * ═══ ALSO READ BY THE COMPANION'S CARD ═══
 *
 * `normaliseValue` (`chat-companion/v2/edit-catalogue.ts`) runs these same functions, so a card's
 * `after` is the string the writer will store. That keeps its no-op drop honest: an edit that would
 * store the bytes already stored is no edit. Its stale check then compares stored strings with
 * stored strings.
 */

/** `rvm cad pvt ltd` → `Rvm Cad Pvt Ltd`; `RVM CAD` → `RVM CAD`. Applied before encryption. */
export function storedEmployerName(typed: string): string {
  return titleCaseWords(typed);
}

/** `mechanical engineering` → `Mechanical Engineering`; null (no field given) stays null. */
export function storedEducationField(typed: string | null): string | null {
  return typed === null ? null : titleCaseWords(typed);
}
