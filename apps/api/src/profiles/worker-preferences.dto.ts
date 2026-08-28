import { z } from "zod";
import { canonicalCity } from "@badabhai/profiling-lexicon";

import { DOCUMENTS_READY, JOB_TYPES, LANGUAGES, SHIFTS } from "./worker-preferences.vocabulary";

/**
 * The post-interview finishing form's closed-set page (R6 §4).
 *
 * EVERY FIELD IS OPTIONAL AND EVERY LIST MAY BE EMPTY, because the form is one screen the worker
 * can leave half-answered and come back to. An absent key means "not answered" and leaves the
 * stored value alone; an explicitly EMPTY list means "none of these", which is a real answer and
 * must be able to clear a row. Those are different states and the schema keeps them apart:
 * `undefined` versus `[]`.
 *
 * ENUMS ARE DERIVED FROM THE VOCABULARY, never restated. A slug that validates here but has no
 * label there would be stored and then silently dropped at render — the worker would tick a box,
 * see nothing on his sheet, and nothing would log a reason.
 */

/** `z.enum` over a dictionary's keys, so validation and printing cannot drift apart. */
function optionsOf(vocabulary: Readonly<Record<string, string>>): [string, ...string[]] {
  const keys = Object.keys(vocabulary);
  // Not reachable with the shipped dictionaries; asserted so an emptied one fails loudly at
  // module load rather than producing a schema that accepts nothing and reports no reason.
  if (keys.length === 0) throw new Error("preference vocabulary is empty");
  return keys as [string, ...string[]];
}

/**
 * A multi-select of dictionary slugs — de-duplicated, order preserved.
 *
 * CAPPED, because every one of these becomes a row on a one-page sheet. The cap is generous
 * relative to what a real worker ticks (both ratified samples list three languages and five
 * documents) and exists so a malformed client cannot hand the degradation ladder a row with
 * forty values in it.
 */
function multiSelect(vocabulary: Readonly<Record<string, string>>, max: number) {
  return z
    .array(z.enum(optionsOf(vocabulary)))
    .max(max)
    .transform((values) => [...new Set(values)]);
}

/**
 * Preferred cities, RESOLVED THROUGH THE SHARED GAZETTEER rather than accepted as typed.
 *
 * The same `cities.json` that `answer-capture.ts` resolves the interview's city answer against,
 * and that the pseudonymisation gateway now consults before guessing that a capitalised word is
 * a person. Canonicalising here means "gurgaon" and "Gurugram" become one value, so a printed
 * sheet and a match query see the same string.
 *
 * AN UNRESOLVED CITY IS REJECTED, NOT DROPPED. Dropping is the silent-truncation shape: the
 * worker taps three cities, sees two on his sheet, and nothing tells him why. A 400 naming the
 * value lets the client say so. Fail-closed, per the engineering contract.
 */
const preferredCities = z
  .array(z.string().trim().min(1).max(80))
  .max(5)
  .transform((values, ctx) => {
    const resolved: string[] = [];
    for (const value of values) {
      const city = canonicalCity(value)?.value ?? null;
      if (city === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unrecognised city: ${value}`,
        });
        return z.NEVER;
      }
      resolved.push(city);
    }
    return [...new Set(resolved)];
  });

export const SetMyPreferencesSchema = z
  .object({
    languages: multiSelect(LANGUAGES, 6).optional(),
    documents_ready: multiSelect(DOCUMENTS_READY, 8).optional(),
    preferred_cities: preferredCities.optional(),
    job_type: z.enum(optionsOf(JOB_TYPES)).nullable().optional(),
    shift: z.enum(optionsOf(SHIFTS)).nullable().optional(),
    /**
     * ONLY THE POSITIVE CLAIM IS EVER PRINTED (`buildAvailabilityRows`), so `false` here is not
     * a refusal on the sheet — it is the worker withdrawing a claim he previously made, which is
     * why it is a nullable boolean rather than a flag that can only be set.
     */
    willing_to_relocate: z.boolean().nullable().optional(),
    accommodation_needed: z.boolean().nullable().optional(),
  })
  .strict();

export type SetMyPreferencesDto = z.infer<typeof SetMyPreferencesSchema>;
