import {
  AVAILABILITY_STATUSES,
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_CREDENTIALS,
  JOB_TYPES,
  LANGUAGES,
  SALARY_PERIODS,
  SHIFTS,
  WORK_TYPES,
  labelFor,
  labelsFor,
} from "../profiles/worker-preferences.vocabulary";
import {
  resolveAvailabilityState,
  resolveSalaryPeriod,
  resolveWorkTypes,
  type SalaryPeriod,
} from "../profiles/worker-field-precedence";
import { MONTHS } from "./resume-employment-rows";

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
  /**
   * The LOWER end of the band as the GENERAL FORM stores it (`salary_expected_min`, ADR-0045), or
   * null. Read here beside {@link salaryMax} so the band's two ends have one narrower; printed only
   * by the general road (`resume-render-input.ts`), the one road whose form writes this key — so on
   * every other sheet it is read and prints nothing.
   */
  readonly salaryMin: number | null;

  // ── ADR-0042 D9 / Layer A (c) — the attribute extensions, read for the renderers ──────────
  //
  // THESE ARE FACTS, NOT ROWS YET: the existing sheet prints none of them (the Layer A universal
  // sections do), and every field here is optional-with-a-neutral-default so an old attribute bag
  // produces exactly the previous values.

  /**
   * The worker's employment types, multi-first — see `resolveWorkTypes`. LABELS, because the
   * sheet prints English and the slack is a slug.
   */
  readonly workTypes: string[];
  /** The period the salary figures are quoted in. ABSENT MEANS `month` (the pre-existing meaning). */
  readonly salaryPeriod: SalaryPeriod;
  /** "per month" / "per day" / "per year" — the period's printed label, or null for the default. */
  readonly salaryPeriodLabel: string | null;
  /** How far the worker will travel, in km, or null when they did not say. 0 is a stated 0. */
  readonly commuteMaxKm: number | null;
  /** Undefined means UNANSWERED; only `true` ever prints. Never derived from `commuteMaxKm`. */
  readonly willingToTravel: boolean | undefined;
  /** The printed status ("Within a week"), from the worker's own answer or the model's. */
  readonly availabilityStatusLabel: string | null;
  /**
   * The same status as its SLUG (`immediate`, `serving_notice`, …), or null — narrowed to the
   * vocabulary, so an unknown slug reads as null exactly as its label does. For a rule that must
   * branch on the answer (the general road's "Available from", {@link formAvailabilityLabel}):
   * branching on the printed label would make a copy edit a behaviour change.
   */
  readonly availabilityStatus: string | null;
  /** `YYYY-MM-DD`, as the worker stated it. Null unless the structured answer carries one. */
  readonly availableFrom: string | null;
  readonly noticePeriodDays: number | null;
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
  salaryMin: null,
  workTypes: [],
  salaryPeriod: "month",
  salaryPeriodLabel: null,
  commuteMaxKm: null,
  willingToTravel: undefined,
  availabilityStatusLabel: null,
  availabilityStatus: null,
  availableFrom: null,
  noticePeriodDays: null,
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
  const salaryPeriod = resolveSalaryPeriod(scalar(attributes.salary_period));
  // THE WORKER'S OWN ANSWER OUTRANKS THE MODEL'S, on the rule `worker-field-precedence.ts`
  // states — the model's status arrives on the caller's side and is not read here.
  const availability = resolveAvailabilityState({
    workerAnswer: asObject(attributes.availability),
    legacyStatus: null,
  });
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
    salaryMin: numeric(attributes.salary_expected_min),
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
    // ── Layer A (c) ─────────────────────────────────────────────────────────────────────────
    workTypes: labelsFor(
      WORK_TYPES,
      resolveWorkTypes(stringList(attributes.work_types), scalar(attributes.job_type)),
    ),
    salaryPeriod,
    // NULL FOR THE DEFAULT, so a worker who never answered prints exactly as they did before:
    // the sheet's "/ month" suffix is the default and a label here would be a second spelling of
    // the same fact.
    salaryPeriodLabel:
      scalar(attributes.salary_period) === null || salaryPeriod === "month"
        ? null
        : labelFor(SALARY_PERIODS, salaryPeriod),
    commuteMaxKm: nonNegativeNumber(attributes.commute_max_km),
    willingToTravel: flag(attributes.willing_to_travel),
    availabilityStatusLabel: labelFor(AVAILABILITY_STATUSES, availability.status ?? ""),
    availabilityStatus:
      labelFor(AVAILABILITY_STATUSES, availability.status ?? "") === null
        ? null
        : availability.status,
    availableFrom: availability.availableFrom,
    noticePeriodDays: availability.noticePeriodDays,
  };
}

/** The stored `availability` json attribute, if it is an object. Anything else is absence. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A stored non-negative number — `commute_max_km`'s reader.
 *
 * DELIBERATELY NOT {@link numeric}: that helper demands `n > 0` because every caller before this
 * one was a salary or a year, where zero says nothing. Zero kilometres is a STATED answer here
 * ("I will not travel"), and the DTO's own floor is 0, so a helper that dropped it would silently
 * erase exactly the workers the field exists for.
 */
function nonNegativeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * THE GENERAL ROAD'S "Available from" ROW (ADR-0045 §3.4) — the general form's own availability
 * answer, phrased for a page that is read LATER than it is written. Null when the worker answered
 * none of it, and the caller then prints what the row printed before.
 *
 * FIRST RULE THAT APPLIES:
 *   - a date after the render day            → "From 12 Oct 2026"
 *   - a date on or before it, or `immediate` → "Immediately" (the vocabulary's own label)
 *   - `serving_notice` with a day count      → "Serving notice (30 days)"; without one, the label
 *   - `within_week` / `within_month`         → "Within a week" / "Within a month"
 *
 * THE DATE WINS OVER THE STATUS, because it is the more specific statement — "serving notice"
 * with an `available_from` has already told us the day. A PAST date prints "Immediately" rather
 * than "From <a day already gone>": the employer copy renders live, possibly months after the
 * answer, and a start date in the past means the worker is free now.
 *
 * "TODAY" IS THE RENDER DAY IN INDIA (`Asia/Kolkata`), the footer's clock — so a sheet generated
 * at 1 a.m. IST does not call today's date "From" a day that has already begun. With no clock
 * (`asOf` null) no date is judged at all and the status decides; a date nobody can place against
 * the calendar is not printed.
 *
 * THE MONTH IS THE SHEET'S OWN ABBREVIATION (`MONTHS`), not `Intl`'s, whose en-GB short month
 * changed spelling between ICU builds ("Sept"/"Sep").
 */
export function formAvailabilityLabel(
  facts: Pick<ResumePreferenceFacts, "availabilityStatus" | "availableFrom" | "noticePeriodDays">,
  asOf: Date | null,
): string | null {
  const from = facts.availableFrom === null ? null : calendarDate(facts.availableFrom);
  const today = asOf === null ? null : indiaCalendarDay(asOf);
  const immediately = labelFor(AVAILABILITY_STATUSES, "immediate");
  if (from !== null && today !== null) {
    return from.iso > today
      ? `From ${from.day} ${MONTHS[from.month - 1]} ${from.year}`
      : immediately;
  }
  switch (facts.availabilityStatus) {
    case "immediate":
      return immediately;
    case "serving_notice": {
      const label = labelFor(AVAILABILITY_STATUSES, "serving_notice");
      const days = facts.noticePeriodDays;
      if (label === null || days === null || days <= 0) return label;
      return `${label} (${days} ${days === 1 ? "day" : "days"})`;
    }
    case "within_week":
    case "within_month":
      return labelFor(AVAILABILITY_STATUSES, facts.availabilityStatus);
    default:
      return null;
  }
}

/**
 * A stored `YYYY-MM-DD` as its parts, or null when it names no real day ("2026-02-31"): the
 * write-side DTO checks the shape, and `resolveAvailabilityState` re-checks only the shape, so a
 * hand-written row can still carry a date no calendar has.
 */
function calendarDate(iso: string): {
  readonly iso: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  const real =
    at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
  return real ? { iso, year, month, day } : null;
}

/** The render instant's calendar day in India, as `YYYY-MM-DD` — comparable to a stored date. */
function indiaCalendarDay(at: Date): string | null {
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value;
  const [year, month, day] = [part("year"), part("month"), part("day")];
  return year && month && day ? `${year}-${month}-${day}` : null;
}
