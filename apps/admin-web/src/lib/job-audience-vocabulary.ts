/**
 * #2956 / #2958 — the words for WHERE A JOB SHOWS. Plain module (no `server-only`), so the client
 * forms and the server pages share one vocabulary. The values mirror the API's
 * (`admin-posting-audience.dto.ts`); labels are the screen's own.
 */

/** The stored audience values, in the order the control offers them. */
export const JOB_AUDIENCES = ["rvm_students", "both", "badabhai_workers"] as const;
export type JobAudience = (typeof JOB_AUDIENCES)[number];

export const AUDIENCE_LABELS: Readonly<Record<JobAudience, string>> = {
  rvm_students: "Campus only",
  both: "Campus and BadaBhai",
  badabhai_workers: "BadaBhai only",
};

export const AUDIENCE_HINTS: Readonly<Record<JobAudience, string>> = {
  rvm_students: "RVM students on Campus. Usually a few openings in a trade RVM trains.",
  both: "RVM students on Campus and BadaBhai workers in the app. Usually many openings.",
  badabhai_workers: "BadaBhai workers only. Any trade RVM has no students for.",
};

/** Where a posting shows now, as the API reads it through the worker and Campus rules. */
export const SHOWN_TO = ["campus", "both", "badabhai", "nobody"] as const;
export type ShownTo = (typeof SHOWN_TO)[number];

export const SHOWN_TO_LABELS: Readonly<Record<ShownTo, string>> = {
  campus: "Campus only",
  both: "Campus and BadaBhai",
  badabhai: "BadaBhai only",
  nobody: "Nobody",
};

/** The list's tabs, the default first. */
export const AUDIENCE_FILTERS = ["to_decide", "campus", "both", "badabhai", "changed"] as const;
export type AudienceFilter = (typeof AUDIENCE_FILTERS)[number];

export const AUDIENCE_FILTER_LABELS: Readonly<Record<AudienceFilter, string>> = {
  to_decide: "To decide",
  campus: "Campus only",
  both: "Campus and BadaBhai",
  badabhai: "BadaBhai only",
  changed: "Changed since decision",
};

export function isAudienceFilter(value: unknown): value is AudienceFilter {
  return typeof value === "string" && (AUDIENCE_FILTERS as readonly string[]).includes(value);
}

export const AUDIENCE_OUTCOMES = [
  "changed",
  "unchanged",
  "not_found",
  "twin_not_allowed",
  "posting_closed",
  "trade_required",
  "trade_not_taught_at_campus",
  "targeting_option_not_offered",
] as const;
export type AudienceOutcome = (typeof AUDIENCE_OUTCOMES)[number];

/** One plain sentence per outcome, for the result of a decision. */
export const AUDIENCE_OUTCOME_MESSAGES: Readonly<Record<AudienceOutcome, string>> = {
  changed: "Saved.",
  unchanged: "Already set this way. Nothing changed.",
  not_found: "This job no longer exists.",
  twin_not_allowed: "An agency job's copy always shows on BadaBhai only.",
  posting_closed: "This job is closed. Reopen it first.",
  trade_required:
    "Set this job's trade first. A job needs a trade before BadaBhai workers or Campus can see it.",
  trade_not_taught_at_campus:
    "RVM doesn't train this trade, so this job can only show on BadaBhai.",
  targeting_option_not_offered: "A branch or course chosen is not offered by Campus any more.",
};

/** The openings band as the screen says it. */
export function openingsLabel(band: string): string {
  return band === "1" ? "1 opening" : `${band} openings`;
}
