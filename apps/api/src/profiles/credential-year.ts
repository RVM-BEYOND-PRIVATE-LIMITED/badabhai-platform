import { z } from "zod";

/**
 * The year bound shared by `credentialYear` (qualifications) and `education_year` (preferences).
 *
 * ═══ WHY THIS IS A MODULE AND NOT TWO `z.number().int().min(1950).max(2100)` LITERALS ═══
 *
 * It was exactly that, in both files, and the two literals agreed with each other and disagreed
 * with the rule their own doc comments stated. Both said, in as many words, "a year IN THE FUTURE
 * or before living memory is a typo" — and then bounded the field at a fixed 2100, which does not
 * implement "in the future" and would not have implemented it at any point in this platform's
 * life. A worker could date an ITI certificate 2099 and every layer accepted it (#1407).
 *
 * ONE CEILING, EVALUATED AT PARSE TIME, NOT AT IMPORT TIME. `new Date().getFullYear()` read into
 * a module-level constant would be correct on the day the container starts and wrong every
 * January afterwards — an api container on this platform routinely runs for weeks, so a
 * module-level read would silently refuse the current year's certificates from 1 January until
 * the next deploy. That is a worse failure than the one being fixed here, because it rejects
 * TRUE statements and it arrives on a date nobody is deploying. The `refine` below therefore
 * calls `currentYear()` on every parse.
 *
 * DELIBERATELY STRICTER THAN THE DATABASE, which is a change from what the qualifications doc
 * comment used to claim. `wc_year_chk` / `wed_year_chk` (migration 0098) remain `BETWEEN 1950 AND
 * 2100` and are NOT being tightened: a CHECK constraint cannot depend on the clock — it would
 * have to be re-evaluated against every existing row on every New Year, and a row that was legal
 * when written must not become illegal while it sits there. So the database keeps the widest
 * bound that is always true, and this schema keeps the narrow one that is true today. The API
 * stays the layer that reports a bad year, exactly as before; it now reports more of them.
 *
 * THE FLOOR STAYS 1950 and is a plain `.min()`, because it is genuinely fixed: a worker awarded
 * a credential before 1950 is past any working age this platform serves.
 */

/** A worker awarded a credential before this is past any working age the platform serves. */
export const CREDENTIAL_YEAR_FLOOR = 1950;

/**
 * The ceiling, as of NOW. Injectable so a test can pin "today" without touching the system clock.
 */
export function currentYear(now: Date = new Date()): number {
  return now.getFullYear();
}

/**
 * A four-digit award year: not before living memory, and not in the future.
 *
 * Not nullable and not optional on purpose — the two callers differ (`.nullable().default(null)`
 * on a certificate row, `.nullable().optional()` on a preferences key) and each applies its own
 * wrapper. Null never reaches the refinement: `.nullable()` short-circuits it, so "no year given"
 * stays a legal answer on both surfaces.
 */
export const credentialYearSchema = z
  .number()
  .int()
  .min(CREDENTIAL_YEAR_FLOOR)
  .refine((year) => year <= currentYear(), {
    // Names the ceiling rather than restating the rule, because the client renders this string
    // and "must be 1950 or later" is already covered by `.min`'s own message.
    message: "year cannot be in the future",
  });
