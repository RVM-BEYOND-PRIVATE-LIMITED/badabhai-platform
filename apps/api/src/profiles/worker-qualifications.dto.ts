import { z } from "zod";

import { looksLikePii } from "@badabhai/validators";

import { credentialYearSchema } from "./credential-year";
import {
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  type PreferenceVocabulary,
} from "./worker-preferences.vocabulary";

/**
 * The finishing form's QUALIFICATIONS page — Zone 5's credentials (migration 0098).
 *
 * ═══ WHY THIS IS ITS OWN ENDPOINT AND NOT THREE MORE KEYS ON `SetMyPreferencesSchema` ═══
 *
 * `WorkerPreferencesService` states its own contract in its first paragraph: "IT WRITES
 * `worker_attributes`, NOT A NEW TABLE." Everything it accepts is one scalar or one list per
 * worker, upserted over the interview's answer to the same question, and `wa_worker_key_uq` is
 * what makes that safe. Certificates and educations are REPEATABLE ROWS with an order the worker
 * chose, in two tables with their own uniqueness constraint on `(worker_id, sort_order)` — the
 * shape that forces delete-then-insert rather than upsert.
 *
 * The repository already has that exact precedent and it is not the preferences one:
 * `worker_employment` is a repeatable, ordered, worker-owned table and it got `PUT
 * /workers/me/employment`, its own DTO, service, controller and event. This is the same shape, so
 * it takes the same seam. Folding it into the preferences endpoint would put a transaction inside
 * a service documented not to open one, and would make `keys_written` on
 * `worker.preferences_recorded` count things that are not attribute keys.
 *
 * ═══ THE FOUR `education_*` ATTRIBUTES ARE UNTOUCHED AND STILL WRITTEN ═══
 *
 * Migration 0098 committed to this in writing: the scalar keys keep being written by the
 * preferences form and keep being read, and `worker_education` is a SECOND source that wins where
 * it has rows. So a worker who never opens this page renders exactly as they do today — no
 * cutover, no backfill, and no client is required to move.
 *
 * ═══ THREE STATES PER LIST, AND THE SCHEMA KEEPS THEM APART ═══
 *
 *   absent   the worker did not reach that half of the page — the stored rows SURVIVE
 *   `[]`     "I have none" — a real answer, and it CLEARS the rows
 *   `[...]`  the new list, in the worker's own display order
 *
 * The same `undefined` versus `[]` distinction `SetMyPreferencesSchema` makes, and for the same
 * reason: a worker must be able to take an answer back, and a partial save must not wipe the half
 * of the page they had already filled.
 */

/**
 * FREE TEXT THAT PRINTS ON A RÉSUMÉ — screened HERE, because nothing screens it later.
 *
 * ═══ THIS BOUNDARY IS THE ONLY ONE ═══
 *
 * Zone 5's strings reach `buildQualificationRows` RAW. `looksLikePii` runs at render over
 * `rp.skills`, `preferred_locations`, `role_label`, `domain_label`, `availability`,
 * `current_city` and `shift` — and over nothing in the qualification block, on either audience.
 * So a phone number typed into an issuer field prints verbatim on the worker's own PDF *and* on
 * the employer-facing masked disclosure, with nothing anywhere reporting it. Fail closed at the
 * capture surface is the only place left to fail closed at.
 *
 * ═══ WHY AN ISSUER IS A LIKELY PLACE FOR A NUMBER, NOT A THEORETICAL ONE ═══
 *
 * Training centres print their phone number on the certificate, next to their name — which is
 * exactly what a worker is copying when they fill this field.
 *
 * ═══ WHAT IT CATCHES AND WHAT IT DOES NOT ═══
 *
 * `looksLikePii` is email shapes and runs of seven or more digits. It deliberately does NOT catch
 * organisation names, and must not: "Govt. ITI, Faridabad" and "RVM CAD" are the whole point of
 * the field. A four-digit year passes; two years typed with only a space between them
 * ("2016 2018") would not, because separators are stripped before the digits are counted. That
 * false positive is narrow, it is the same one the agency job-text fields already accept, and a
 * named 400 is a far better outcome than a phone number on a résumé handed to a stranger.
 */
function freeText(max: number, what: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !looksLikePii(value), {
      message: `remove contact details from the ${what}`,
    });
}

/** `z.enum` over a dictionary's keys, so validation and printing cannot drift apart. */
function optionsOf(vocabulary: PreferenceVocabulary): [string, ...string[]] {
  const keys = Object.keys(vocabulary);
  // Not reachable with the shipped dictionaries; asserted so an emptied one fails loudly at
  // module load rather than producing a schema that accepts nothing and reports no reason.
  if (keys.length === 0) throw new Error("qualification vocabulary is empty");
  return keys as [string, ...string[]];
}

/**
 * BOUNDED ON THE SAME RANGE `education_year` ALREADY USES, and the bound is on the same argument:
 * a year in the future or before living memory is a typo, and a typo printed beside a real
 * credential does more damage than a missing segment. The API stays the layer that reports a bad
 * year, so the database never has to.
 *
 * The ceiling is the CURRENT year and moves with the clock — see `credential-year.ts` for why it
 * is evaluated per parse and why it is deliberately narrower than `wc_year_chk` / `wed_year_chk`,
 * which this comment used to claim it matched exactly (#1407).
 */
const credentialYear = credentialYearSchema.nullable().default(null);

/**
 * HOW MANY CERTIFICATES ONE SUBMISSION MAY CARRY.
 *
 * NOT A RENDER BUDGET. Zone 5 rows are shed by `resume-degradation.ts` against
 * `SHEET_LINE_BUDGET`, so nothing is silently dropped by the sheet and the argument that puts
 * `EMPLOYMENT_BLOCK_BUDGET` in the employment DTO does not apply here. This is a plain bound so a
 * malformed client cannot hand the degradation ladder a Certificates row with forty values in it.
 * Both ratified reference sheets carry one or two.
 */
export const CERTIFICATES_MAX = 8;

/** Same argument as {@link CERTIFICATES_MAX}. A worker with five credentials is already unusual. */
export const EDUCATIONS_MAX = 4;

/**
 * One certificate, licence or trade qualification.
 *
 * `name` IS FREE TEXT AND CANNOT BE A CLOSED SET. The reference sheets carry "Mastercam Advanced
 * Multiaxis", "Welder Qualification Test — 3G, MS plate", "Internal Auditor — IATF 16949" and
 * "Wireman / Electrician Licence" — a training centre, an OEM, a certification body and a state
 * licensing board. There is no register to validate against, and inventing a closed set would
 * silently drop every certificate not on it. The role descriptor supplies a SUGGESTED list per
 * trade for the client's search box; this accepts whatever the worker settles on.
 *
 * THE LENGTH CAPS MATCH `wc_name_chk` AND `wc_issuer_len_chk`. Rejecting at the boundary is what
 * keeps a CHECK violation — a 500 with a constraint name in it — off a worker's screen.
 */
const CertificateEntrySchema = z
  .object({
    name: freeText(120, "certificate name"),
    /** A training centre, an OEM, a certification body, an employer. */
    issuer: freeText(120, "issuer").nullable().default(null),
    year: credentialYear,
  })
  .strict();

/**
 * One schooling or trade credential — the five segments the sheet prints, each its own field.
 *
 * "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad". Storing the rendered line would make
 * the composition unfixable and the parts unmatchable: `credential` and `field` are matching
 * inputs, not decoration.
 *
 * EVERY FIELD IS INDIVIDUALLY OPTIONAL — a worker may know their trade and not their council —
 * BUT A ROW MUST SAY SOMETHING. All five null is a blank line the renderer would have to guess
 * about; `wed_not_empty_chk` refuses to store one and the refinement below refuses to accept one,
 * so the rejection names the field rather than the constraint.
 */
const EducationEntrySchema = z
  .object({
    /** A slug from {@link EDUCATION_QUALIFICATIONS} — never the printed label. */
    credential: z.enum(optionsOf(EDUCATION_QUALIFICATIONS)).nullable().default(null),
    /** The trade or stream, in the worker's own words: "Machinist", "Mechanical Engineering". */
    field: freeText(80, "field of study").nullable().default(null),
    /**
     * NCVT, SCVT, a state board — a slug from {@link EDUCATION_COUNCILS}.
     *
     * KEPT APART FROM `credential` BECAUSE THE DISTINCTION IS THE POINT (§4.5). NCVT is the
     * national certificate and SCVT the state one, and they are not interchangeable for a job
     * that requires a specific trade certificate.
     */
    council: z.enum(optionsOf(EDUCATION_COUNCILS)).nullable().default(null),
    year: credentialYear,
    /**
     * The institute, as the worker reads it off the certificate.
     *
     * FREE TEXT, because there is no national register of ITI names to validate against and
     * inventing a closed set would silently drop every institute not on it — the identical
     * reasoning that made `education_institute` the one free-text field on the preferences form.
     */
    institute: freeText(120, "institute name").nullable().default(null),
  })
  .strict()
  .refine(
    (e) =>
      e.credential !== null ||
      e.field !== null ||
      e.council !== null ||
      e.year !== null ||
      e.institute !== null,
    { message: "an education entry must carry at least one field", path: ["credential"] },
  );

export const SetMyQualificationsSchema = z
  .object({
    certificates: z.array(CertificateEntrySchema).max(CERTIFICATES_MAX).optional(),
    educations: z.array(EducationEntrySchema).max(EDUCATIONS_MAX).optional(),
  })
  .strict()
  // AN EMPTY BODY IS A CLIENT BUG, NOT A NO-OP, and it is worth 400-ing rather than absorbing.
  // `{}` and `{"certificates": []}` look alike and mean opposite things — "I did not reach this
  // page" and "I have no certificates" — so a body that expresses neither is a client that has
  // lost track of which it meant. Absorbing it silently is how a worker taps Save, sees success,
  // and finds nothing changed.
  .refine((dto) => dto.certificates !== undefined || dto.educations !== undefined, {
    message: "send certificates, educations, or both",
    path: ["certificates"],
  });

export type SetMyQualificationsDto = z.infer<typeof SetMyQualificationsSchema>;
