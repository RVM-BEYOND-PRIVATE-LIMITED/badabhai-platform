import {
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_CREDENTIALS,
  JOB_TYPES,
  LANGUAGES,
  SHIFTS,
  labelFor,
  labelsFor,
} from "../profiles/worker-preferences.vocabulary";

/**
 * The finishing form's answers, read off `worker_attributes` and printed in English (R6 §4).
 *
 * WHY A SEPARATE FILE FROM `trade-resume-map.ts`. That one is PER-PACK: a turner's machines, a
 * welder's processes, keyed by the pack the interview ran. These seven are trade-independent —
 * every worker on the platform has languages and documents whatever they do — so keying them by
 * pack would mean copying the same seven rows into every future role map and getting one of them
 * wrong.
 *
 * PURE. No I/O, no DI, no clock. It takes the attribute bag `loadTradeSheet` already returns and
 * yields printable values, so both branches of `buildResumeRenderInput` read it the same way.
 *
 * AN UNKNOWN SLUG IS DROPPED, never printed raw — the same safety rule the pack map states. A
 * value that stops being a legal option must stop appearing on sheets, not start appearing as
 * `uan_pf`.
 */

/** Zone 3 and Zone 5's self-declared values, already in the English the sheet prints. */
export interface ResumePreferenceFacts {
  readonly languages: string[];
  readonly documents: string[];
  readonly preferredLocations: string[];
  /** "Rotational shifts · Permanent" — shift and employment type, as the ratified sheet joins them. */
  readonly shiftLine: string | null;
  /**
   * The shift half of {@link shiftLine} on its own ("Night shift"), or null.
   *
   * EXPOSED SEPARATELY BECAUSE ONE CALLER NEEDS THE HALF, NOT THE LINE (#1426).
   * `humanizeAvailability` suppresses the night-shift-readiness clause when the sheet's shift
   * already says nights, and its test is an ANCHORED regex — so it can match "Night shift" and
   * can never match "Night shift · Permanent". Splitting the composed line back apart at the
   * separator would work today and break the first time a half contains one.
   */
  readonly shiftLabel: string | null;
  /** Undefined means UNANSWERED. Only `true` ever prints; see `buildAvailabilityRows`. */
  readonly willingToRelocate: boolean | undefined;
  readonly accommodationNeeded: boolean | undefined;
  /**
   * "NCVT · 2018 · Govt. ITI, Faridabad" — the credential's three captured components, joined
   * (R9 section 3). NULL when the worker answered none of them.
   *
   * THE TRAILING SEGMENTS ONLY. The level and the trade ("ITI - Machinist") come from the answer
   * map's `education_level` / `education_field` and are composed by the caller, because those two
   * are asked in the interview and these three on the form. Joining all five here would put a
   * fact from one surface inside a value read from another, and the caller is where the sheet
   * already decides which source wins.
   */
  readonly educationDetail: string | null;
  /**
   * "ITI" or "Diploma" — which credential the merged `iti_diploma` level covers (R11 §3.1), or
   * null when the worker has not said.
   *
   * SEPARATE FROM {@link educationDetail} BECAUSE IT REPLACES A SEGMENT RATHER THAN ADDING ONE.
   * The other three components append after the em-dash; this one narrows the value in front of
   * it, and the caller is where the sheet already decides which source wins for that segment.
   */
  readonly educationCredential: string | null;
  /**
   * The upper end of the expected-salary band (R10 R-1), or null when the worker gave only one
   * figure. NEVER derived — see `formatSalaryBand`.
   */
  readonly salaryMax: number | null;
}

export const NO_PREFERENCES: ResumePreferenceFacts = {
  languages: [],
  documents: [],
  preferredLocations: [],
  shiftLine: null,
  shiftLabel: null,
  willingToRelocate: undefined,
  accommodationNeeded: undefined,
  educationDetail: null,
  educationCredential: null,
  salaryMax: null,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * A stored `numeric` attribute as a printable year.
 *
 * `worker-attributes.repository.ts` already converts the column to a JS number on read, but a row
 * written before that conversion existed - or by any other writer - can still arrive as a string,
 * so both shapes are accepted and anything else yields nothing. A year is printed as an integer:
 * "2018", never "2018.0000", which is what the 14,4 column would otherwise give.
 */
function year(value: unknown): string | null {
  const n = numeric(value);
  return n !== null && Number.isInteger(n) ? String(n) : null;
}

/**
 * A stored `numeric` attribute as a JS number.
 *
 * BOTH SHAPES ACCEPTED. `worker-attributes.repository.ts` converts the column on read, but pg
 * returns `numeric` as a STRING and a row written by any other path can still arrive that way.
 * Anything that is not a finite positive number yields null rather than NaN reaching a formatter.
 */
function numeric(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Read the seven form keys out of the attribute bag.
 *
 * `preferred_locations` IS RETURNED RAW rather than through a dictionary, and it is the only one:
 * the writer already canonicalised each city through the shared gazetteer, so the stored value IS
 * the printable English ("Gurugram", not `gurgaon`). Putting a second dictionary in front of it
 * would mean maintaining a city list here as well as in `cities.json`.
 */
export function readPreferenceFacts(
  attributes: Readonly<Record<string, unknown>>,
): ResumePreferenceFacts {
  const shift = labelFor(SHIFTS, scalar(attributes.shift_preference) ?? "");
  const jobType = labelFor(JOB_TYPES, scalar(attributes.job_type) ?? "");
  return {
    languages: labelsFor(LANGUAGES, stringList(attributes.languages)),
    documents: labelsFor(DOCUMENTS_READY, stringList(attributes.documents_ready)),
    preferredLocations: stringList(attributes.preferred_locations),
    // JOINED HERE rather than in two rows, because the ratified sheet prints one line
    // ("Rotational shifts · Permanent") and an empty half must take its separator with it — the
    // same rule the verdict line follows. Either half alone still prints.
    shiftLine: [shift, jobType].filter((v): v is string => v !== null).join(" · ") || null,
    shiftLabel: shift,
    willingToRelocate: flag(attributes.relocation_willingness),
    accommodationNeeded: flag(attributes.accommodation_needed),
    // COUNCIL, YEAR, INSTITUTE - in the order the ratified sheet prints them, each dropping its
    // own separator when absent. A worker who gave only the year gets "2018", not "· 2018 ·".
    salaryMax: numeric(attributes.salary_expected_max),
    // R11 §3.1 — an UNKNOWN slug yields null and the caller falls back to the merged label, which
    // is the same drop-the-unknown rule every dictionary here follows. Falling back to
    // "ITI / Diploma" is not a degradation: it is the less specific truth, and printing a slug or
    // guessing between the two would both be worse.
    educationCredential: labelFor(
      EDUCATION_CREDENTIALS,
      scalar(attributes.education_credential) ?? "",
    ),
    educationDetail:
      [
        labelFor(EDUCATION_COUNCILS, scalar(attributes.education_council) ?? ""),
        year(attributes.education_year),
        scalar(attributes.education_institute),
      ]
        .filter((v): v is string => Boolean(v))
        .join(" · ") || null,
  };
}
