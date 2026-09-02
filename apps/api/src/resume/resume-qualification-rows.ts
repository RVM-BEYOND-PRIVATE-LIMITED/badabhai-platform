/**
 * ZONE 5's two credential rows, composed from the worker's OWN structured rows (migration 0098).
 *
 * ═══ WHAT WAS BROKEN, AND IT WAS TWO DIFFERENT BREAKAGES ═══
 *
 * CERTIFICATES HAD NO WRITER AT ALL. The row prints from `draft.certifications`, which only the
 * LLM extraction path fills — and the trade-form handover deliberately switches extraction OFF.
 * So for every form-first worker the Certificates row had no source and never appeared, while
 * `resume-degradation.ts` carried a ladder step to shed a row that could not exist. Both RVM
 * student reference sheets lead with a certificate.
 *
 * EDUCATION COULD HOLD EXACTLY ONE. It is captured as four scalar keys on `worker_attributes`,
 * a table keyed `(worker_id, attribute_key)` — so a worker with an ITI and a later diploma had
 * to overwrite one with the other. Meanwhile `buildQualificationRows` has always taken
 * `education` as a LIST: the renderer could print several and the capture surface could supply
 * one.
 *
 * ═══ WHY THIS FILE IS PURE, AND SEPARATE FROM THE REPOSITORY ═══
 *
 * Exactly the split `resume-employment-rows.ts` already has. The repository reads rows; this
 * turns rows into the strings the sheet prints. Composition is where the sheet's grammar lives
 * — which separator joins what, which segment carries its own punctuation, what an absent field
 * costs — and none of that is testable through a database.
 *
 * ═══ THE SEPARATORS ARE NOT A CHOICE MADE HERE ═══
 *
 * The ratified sheet prints "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad", and
 * `resume-render-input.ts` already composes exactly that from the attribute scalars: an em-dash
 * between credential and field, a middot between everything after. These functions reproduce it
 * SEGMENT FOR SEGMENT so that a worker who fills the new table and a worker who filled the old
 * scalars get a byte-identical line. Two compositions of one sheet row is how the two drift.
 *
 * ═══ §8: EVERY PRINTED CHARACTER IS THE WORKER'S OWN ═══
 *
 * A credential is a closed-vocabulary label the worker tapped (`EDUCATION_QUALIFICATIONS`,
 * `EDUCATION_COUNCILS`), a year is a number they stated, and a field, institute or certificate
 * name is their own typing. Nothing here derives, infers, expands an abbreviation or supplies a
 * default — an absent segment takes its separator with it and prints nothing at all.
 */

import {
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  labelFor,
} from "../profiles/worker-preferences.vocabulary";

/** One `worker_certificate` row, in display order. Stored and read in clear (see 0098). */
export interface WorkerCertificateRecord {
  readonly name: string;
  readonly issuer: string | null;
  readonly year: number | null;
}

/**
 * One `worker_education` row, in display order. Every field is individually optional.
 *
 * `credential` AND `council` ARE STORED SLUGS, NOT LABELS — the same discipline every closed set
 * on this platform follows. The dictionary is the only place an option's printed English exists,
 * so relabelling "10th pass" costs an edit rather than a backfill, and a slug that is no longer
 * in the dictionary stops printing instead of printing raw.
 */
export interface WorkerEducationRecord {
  readonly credential: string | null;
  readonly field: string | null;
  readonly council: string | null;
  readonly year: number | null;
  readonly institute: string | null;
}

/** The sheet's own separators, named once so neither composition can drift from the other. */
const CREDENTIAL_SEP = " — ";
const SEGMENT_SEP = " · ";

function join(parts: readonly (string | null | undefined)[], sep: string): string | null {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join(sep) : null;
}

/**
 * One education row as the sheet prints it: "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad".
 *
 * RETURNS NULL FOR A ROW THAT SAYS NOTHING rather than an empty string. `wed_not_empty_chk`
 * makes an all-null row unstorable, so this is unreachable through the API — but a null here is
 * dropped by the callers below, and an empty string would print as a blank line under Education.
 */
export function educationLine(record: WorkerEducationRecord): string | null {
  // AN UNKNOWN SLUG IS DROPPED, NOT PRINTED — `labelsFor`'s rule, stated there as the safety
  // property and applying with more force here: `education_credential` on a résumé is the one
  // line a hiring supervisor checks hardest, and "iti_diploma — Machinist" is worse than
  // "Machinist" alone. The DTO validates against these same dictionaries, so an unknown can only
  // arrive from a row written before an option was retired.
  return join(
    [
      join(
        [
          record.credential === null ? null : labelFor(EDUCATION_QUALIFICATIONS, record.credential),
          record.field,
        ],
        CREDENTIAL_SEP,
      ),
      record.council === null ? null : labelFor(EDUCATION_COUNCILS, record.council),
      record.year === null ? null : String(record.year),
      record.institute,
    ],
    SEGMENT_SEP,
  );
}

/**
 * One certificate as the sheet prints it: "CNC Turning & Fanuc Programming (RVM CAD, 2020)".
 *
 * THE PARENTHESES ARE CONDITIONAL ON THEIR CONTENTS. A certificate with neither issuer nor year
 * prints its name and no brackets — "(...)" around nothing reads as a redaction, which is a
 * claim about the certificate that the worker never made. With one of the two it holds one
 * value; the comma appears only when both are there to separate.
 */
export function certificateLine(record: WorkerCertificateRecord): string | null {
  const name = record.name.trim();
  if (!name) return null;
  const inside = join([record.issuer, record.year === null ? null : String(record.year)], ", ");
  return inside === null ? name : `${name} (${inside})`;
}

/**
 * Zone 5's education slots, split the way `ResumeQualificationFacts` splits them.
 *
 * THE FIRST ROW IS THE HEADLINE AND THE REST ARE LIST ENTRIES, because that is the shape
 * `buildQualificationRows` already has: it prints `[educationHeadline, ...education]` joined by
 * the same middot. The worker's own `sort_order` decides which row is first — never the year.
 * Two credentials can share a year, an undated one still has the place the worker gave it, and
 * re-deriving the order would reshuffle rows between renders and make every regenerated PDF a
 * false diff.
 *
 * RETURNS `null` HEADLINE FOR AN EMPTY LIST, NOT AN EMPTY STRING, so the caller's `??` falls
 * through to the attribute-scalar composition. A worker who has never opened the qualifications
 * form keeps exactly the line they had.
 */
export function educationFacts(records: readonly WorkerEducationRecord[]): {
  headline: string | null;
  rest: string[];
} {
  const lines = records.map(educationLine).filter((line): line is string => line !== null);
  return { headline: lines[0] ?? null, rest: lines.slice(1) };
}

/** Every certificate the worker holds, in their own order, ready for the Certificates row. */
export function certificateFacts(records: readonly WorkerCertificateRecord[]): string[] {
  return records.map(certificateLine).filter((line): line is string => line !== null);
}

/**
 * The stored rows as the `qualification` block `buildResumeRenderInput` takes — or `undefined`
 * when the worker has none.
 *
 * ═══ `undefined` VERSUS `[]` DECIDES WHETHER THE EXTRACTION STILL SHOWS, AND IT IS NOT A DETAIL ═══
 *
 * Zone 5 resolves as `qualification?.certifications ?? draftQualification.certifications`, and
 * `??` falls through on nullish ONLY. So an empty ARRAY is an assertion — "this worker has no
 * certificates" — that suppresses whatever the extraction found, while `undefined` means "this
 * surface has nothing to say" and lets the draft answer. Both are correct answers to different
 * questions, and returning the wrong one silently is how a worker's extracted certificates
 * vanish, or how a worker who deleted a certificate finds it back on their next render.
 *
 * ═══ THE RULE: ALL-OR-NOTHING ON THE SURFACE, PER-FIELD WITHIN IT ═══
 *
 * With NO rows of either kind, this returns `undefined` and the sheet renders exactly as it does
 * today — which is what makes shipping this ahead of the client a no-op for every existing worker.
 *
 * With ANY row, the worker has used this surface and BOTH lists become authoritative, empty ones
 * included: a worker who entered their ITI and no certificates is saying they have none, and the
 * model's guess must not fill that in behind them. `educationHeadline` stays per-field — it is
 * `null` with no education rows, which falls through to the attribute-scalar composition, so a
 * worker who logged a certificate keeps the education line the interview gave them.
 */
export function qualificationFactsFrom(loaded: {
  readonly certificates: readonly WorkerCertificateRecord[];
  readonly educations: readonly WorkerEducationRecord[];
}):
  | { educationHeadline: string | null; education: string[]; certifications: string[] }
  | undefined {
  if (loaded.certificates.length === 0 && loaded.educations.length === 0) return undefined;
  const education = educationFacts(loaded.educations);
  return {
    educationHeadline: education.headline,
    education: education.rest,
    certifications: certificateFacts(loaded.certificates),
  };
}
