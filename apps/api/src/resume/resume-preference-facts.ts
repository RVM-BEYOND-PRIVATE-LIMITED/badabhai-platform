import {
  DOCUMENTS_READY,
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
  /** Undefined means UNANSWERED. Only `true` ever prints; see `buildAvailabilityRows`. */
  readonly willingToRelocate: boolean | undefined;
  readonly accommodationNeeded: boolean | undefined;
}

export const NO_PREFERENCES: ResumePreferenceFacts = {
  languages: [],
  documents: [],
  preferredLocations: [],
  shiftLine: null,
  willingToRelocate: undefined,
  accommodationNeeded: undefined,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
    willingToRelocate: flag(attributes.relocation_willingness),
    accommodationNeeded: flag(attributes.accommodation_needed),
  };
}
