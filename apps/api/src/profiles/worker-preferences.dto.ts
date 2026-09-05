import { z } from "zod";
import { canonicalCity } from "@badabhai/profiling-lexicon";

import { credentialYearSchema } from "./credential-year";
import {
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_CREDENTIALS,
  JOB_TYPES,
  LANGUAGES,
  SHIFTS,
} from "./worker-preferences.vocabulary";

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
 *
 * THE CAP APPLIES BEFORE THE DE-DUPLICATION, which is what makes it a bound on the REQUEST rather
 * than on the answer: `.max()` runs on the raw array and `.transform()` collapses it afterwards.
 * That ordering is deliberate — it is the malformed client this guards against, not the worker.
 */
function multiSelect(vocabulary: Readonly<Record<string, string>>, max: number) {
  return z
    .array(z.enum(optionsOf(vocabulary)))
    .max(max)
    .transform((values) => [...new Set(values)]);
}

/**
 * A multi-select a worker may legitimately tick EVERY option of, so the cap is the dictionary.
 *
 * ═══ WHY THIS EXISTS INSTEAD OF A NUMBER ═══
 *
 * `documents_ready` was `multiSelect(DOCUMENTS_READY, 8)` against a dictionary of exactly eight,
 * so the literal was already the dictionary's size — it just did not say so. Adding `esic` made it
 * nine options behind a cap of eight, and the failure would have been invisible to every existing
 * test: the eight-document worker still passes, and only the worker who genuinely holds all nine
 * gets a 400 naming a limit nobody meant to impose.
 *
 * A DERIVED CAP CANNOT DRIFT. The next slug added to a dictionary used this way raises the bound
 * with it, which is the property a hand-written 8 did not have and could not have.
 *
 * NOT FOR EVERY LIST. `languages` is capped at 6 of 16 ON PURPOSE — that is a real editorial
 * limit on how many a sheet will print, not an accident of the dictionary's length. This helper is
 * only for the lists where "all of them" is a true and unremarkable answer.
 */
function multiSelectAll(vocabulary: Readonly<Record<string, string>>) {
  return multiSelect(vocabulary, Object.keys(vocabulary).length);
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
    // EVERY DOCUMENT IS A TRUE ANSWER FOR SOME WORKER — a man with Aadhaar, PAN, a bank account,
    // UAN, ESIC, an ITI certificate, an experience letter, photos and a licence has nine, and
    // there is nothing unusual about him. See {@link multiSelectAll}.
    documents_ready: multiSelectAll(DOCUMENTS_READY).optional(),
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

    /**
     * The upper end of the expected-salary BAND (R10 R-1).
     *
     * §4.4 is explicit that a point figure invites anchoring against the worker, and the ratified
     * sheet prints a range. Deriving one from a stated number is the claim §8 forbids — so the
     * band is ASKED, and a worker who gives only the lower end still prints a point figure rather
     * than a manufactured range.
     *
     * BOUNDED to the same range the interview's own salary gate uses, because a typo printed as a
     * worker's asking price costs him money in the direction nothing else in the system guards.
     */
    salary_expected_max: z.number().int().min(1000).max(500000).nullable().optional(),

    // ── THE CREDENTIAL'S THREE MISSING COMPONENTS (R9 §3) ────────────────────────────
    //
    // The ratified sheet prints "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad". We held
    // the level and the trade and nothing else, so three of five segments had no source at all.
    //
    // A FORM, NOT AN INTERVIEW ASK, and the routing rule is the same one that put languages and
    // documents here: a council is a closed set, a year is a number, and an institute name is
    // something the worker reads off a certificate. None needs a model, none can be misparsed,
    // and the engine's ask budget belongs to the questions where phrasing carries meaning.
    /**
     * ITI or Diploma — which of the two the merged pack option covers (R11 §3.1).
     *
     * A CLOSED SET OF EXACTLY TWO, and no "other". The question this answers is not "what is your
     * highest qualification" — `education_level` already holds that — it is the narrower "the
     * option you tapped names two credentials; which is yours". A third value would make it a
     * competing answer to the first question rather than a refinement of it.
     */
    education_credential: z.enum(optionsOf(EDUCATION_CREDENTIALS)).nullable().optional(),
    education_council: z.enum(optionsOf(EDUCATION_COUNCILS)).nullable().optional(),
    /**
     * The year the credential was awarded.
     *
     * BOUNDED, AND NOT AT "any four digits". A year in the future or before living memory is a
     * typo, and a typo printed on a résumé beside a real credential does more damage than a
     * missing segment. The floor is 1950 (a worker awarded earlier is past retirement) and the
     * ceiling is the CURRENT year — a certificate can be dated the year it is issued, and no
     * later. It used to be a fixed 2100, which is not what "in the future" means and let a worker
     * date an ITI certificate 2099 (#1407). See `credential-year.ts`.
     */
    education_year: credentialYearSchema.nullable().optional(),
    /**
     * The institute, as the worker reads it off the certificate.
     *
     * FREE TEXT, because there is no national register of ITI names this could validate against
     * and inventing a closed set would silently drop every institute not on it. It is the ONE
     * free-text field on this form; the length cap is what keeps it a name rather than a
     * paragraph, and `looksLikePii` screens it at the render boundary like every other string.
     */
    education_institute: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();

export type SetMyPreferencesDto = z.infer<typeof SetMyPreferencesSchema>;
