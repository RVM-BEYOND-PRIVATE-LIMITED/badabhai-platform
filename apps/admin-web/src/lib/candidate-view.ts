import type {
  CandidateCorrection,
  CandidateDetail,
  CandidateField,
} from "./candidate-detail";
import type { IdentityPosture } from "./identity";
import { displayName } from "./identity";
import { shortId } from "./format";

/**
 * How the Candidates drawer (A7, #2577) READS one #2560 record — pure, so every rule is unit
 * tested without a DOM: the field labels, the humanised source tags, the name posture, the
 * small value formatters, and the Edit log's corrections. No React, no server-only import
 * (the types above are erased), so the client drawer and the tests share it.
 */

// ---------------------------------------------------------------------------
// where a value came from — the `source` tag beside every field
// ---------------------------------------------------------------------------

/**
 * The server's closed `FIELD_SOURCES`, in words (docs/api/admin-candidate-detail-api-reference.md):
 * a short tag for the field row, and the meaning for its hover text. A source this build was not
 * taught renders de-snaked rather than blank — a value worth looking at, never hidden.
 */
export const SOURCE_TAGS: Readonly<Record<string, { label: string; meaning: string }>> = {
  interview: { label: "Interview", meaning: "From the AI profiling interview." },
  form: { label: "Form", meaning: "From the trade form or the general form." },
  resume_import: {
    label: "Resume import",
    meaning: "From a CV the worker uploaded and accepted.",
  },
  worker_edit: {
    label: "Worker edit",
    meaning: "The worker's own answer or edit in the app.",
  },
  ops: { label: "Ops", meaning: "Written by an operator." },
  // #2561 / ADR-0062 — a live admin correction. It sits above every store source until reverted.
  admin_override: {
    label: "Admin override",
    meaning: "Corrected by an admin, and shown above the worker's own answer until reverted.",
  },
  derived: {
    label: "Derived",
    meaning: "Computed by the platform — the match derivation, the occupation matcher or a default.",
  },
  none: { label: "Not stored", meaning: "Nothing is stored for this field." },
  unknown: {
    label: "Unknown source",
    meaning: "A value is stored, but its row cannot say which writer put it there.",
  },
};

/** A source tag's words: the table, else the de-snaked code. */
export function sourceTag(source: string): { label: string; meaning: string } {
  if (Object.hasOwn(SOURCE_TAGS, source)) return SOURCE_TAGS[source]!;
  const label = humanize(source);
  return { label, meaning: `Source: ${label}.` };
}

// ---------------------------------------------------------------------------
// the field labels — ONE per field, shared by the tabs and the Edit log
// ---------------------------------------------------------------------------

/** One `{ value, source, correction }` field of the record: its key, its label, how to reach it. */
export interface CandidateFieldSpec {
  key: string;
  label: string;
  pick: (d: CandidateDetail) => CandidateField<unknown>;
}

/**
 * Every field of the #2560 record that carries a `source` and a `correction`, in the order the
 * drawer shows them. The tabs label their rows from it and the Edit log walks it, so a correction
 * on any field is found — `candidate-view.test.ts` fails if the record ever carries a field this
 * list does not name.
 */
export const CANDIDATE_FIELDS = [
  { key: "identity.name", label: "Name", pick: (d) => d.identity.name },
  { key: "identity.resume_show_photo", label: "Photo on resume", pick: (d) => d.identity.resume_show_photo },
  { key: "identity.has_photo", label: "Profile photo", pick: (d) => d.identity.has_photo },
  { key: "identity.preferred_language", label: "App language", pick: (d) => d.identity.preferred_language },
  { key: "location.current_city", label: "Current city", pick: (d) => d.location.current_city },
  { key: "location.current_state", label: "State", pick: (d) => d.location.current_state },
  { key: "location.preferred_locations", label: "Wants to work in", pick: (d) => d.location.preferred_locations },
  { key: "trade.display_name", label: "Trade", pick: (d) => d.trade.display_name },
  { key: "trade.job_domain", label: "Job domain", pick: (d) => d.trade.job_domain },
  { key: "trade.secondary_roles", label: "Other occupations", pick: (d) => d.trade.secondary_roles },
  { key: "trade.canonical_trade_id", label: "Trade id", pick: (d) => d.trade.canonical_trade_id },
  { key: "trade.canonical_role_id", label: "Role id", pick: (d) => d.trade.canonical_role_id },
  { key: "languages", label: "Languages", pick: (d) => d.languages },
  { key: "salary.band", label: "Expected salary", pick: (d) => d.salary.band },
  { key: "salary.period", label: "Salary period", pick: (d) => d.salary.period },
  { key: "preferences.availability", label: "Availability", pick: (d) => d.preferences.availability },
  { key: "preferences.shift", label: "Shift", pick: (d) => d.preferences.shift },
  { key: "preferences.night_shift_ready", label: "Night shift ready", pick: (d) => d.preferences.night_shift_ready },
  { key: "preferences.job_type", label: "Job type", pick: (d) => d.preferences.job_type },
  { key: "preferences.work_types", label: "Work types", pick: (d) => d.preferences.work_types },
  { key: "preferences.relocation", label: "Willing to relocate", pick: (d) => d.preferences.relocation },
  { key: "preferences.accommodation", label: "Needs accommodation", pick: (d) => d.preferences.accommodation },
  { key: "preferences.commute_max_km", label: "Longest commute", pick: (d) => d.preferences.commute_max_km },
  { key: "preferences.willing_to_travel", label: "Willing to travel", pick: (d) => d.preferences.willing_to_travel },
  { key: "preferences.documents", label: "Documents ready", pick: (d) => d.preferences.documents },
  { key: "education.headline", label: "Highest education", pick: (d) => d.education.headline },
  { key: "education.education", label: "Other education", pick: (d) => d.education.education },
  { key: "education.education_level", label: "Education level", pick: (d) => d.education.education_level },
  { key: "education.education_field", label: "Field of study", pick: (d) => d.education.education_field },
  { key: "education.education_credential", label: "Credential", pick: (d) => d.education.education_credential },
  { key: "education.education_detail", label: "Credential details", pick: (d) => d.education.education_detail },
  { key: "education.certifications", label: "Certifications", pick: (d) => d.education.certifications },
  { key: "education.training", label: "Training", pick: (d) => d.education.training },
  { key: "experience.total_years", label: "Total experience", pick: (d) => d.experience.total_years },
  { key: "experience.industry_tenure", label: "Experience by industry", pick: (d) => d.experience.industry_tenure },
  { key: "work_history", label: "Work history", pick: (d) => d.work_history },
  { key: "skills.skills", label: "Skills", pick: (d) => d.skills.skills },
  { key: "skills.machines", label: "Machines", pick: (d) => d.skills.machines },
  { key: "employer_card.role", label: "Role", pick: (d) => d.employer_card.role },
  { key: "employer_card.role_months", label: "Experience in the role", pick: (d) => d.employer_card.role_months },
  { key: "employer_card.other_roles", label: "Other roles", pick: (d) => d.employer_card.other_roles },
  { key: "employer_card.industry", label: "Industry", pick: (d) => d.employer_card.industry },
  { key: "employer_card.industry_months", label: "Experience in the industry", pick: (d) => d.employer_card.industry_months },
  { key: "employer_card.city", label: "City on the card", pick: (d) => d.employer_card.city },
  { key: "employer_card.trade_levels", label: "Trade levels", pick: (d) => d.employer_card.trade_levels },
] as const satisfies readonly CandidateFieldSpec[];

export type CandidateFieldKey = (typeof CANDIDATE_FIELDS)[number]["key"];

/** A field's label, by key — the one place a field is named. */
export function fieldLabel(key: CandidateFieldKey): string {
  return CANDIDATE_FIELDS.find((f) => f.key === key)!.label;
}

/** One admin correction the record carries, for the Edit log. */
export interface CandidateCorrectionEntry {
  key: CandidateFieldKey;
  label: string;
  correction: NonNullable<CandidateCorrection>;
}

/**
 * The corrections on this record, newest first, from the live `correction` metadata (#2561). The
 * drawer's Edit log uses the API's history when the session may edit; this fallback is for a
 * read-only role, which sees that a field changed but not the admin's reason text.
 */
export function corrections(d: CandidateDetail): CandidateCorrectionEntry[] {
  const out: CandidateCorrectionEntry[] = [];
  for (const spec of CANDIDATE_FIELDS) {
    const correction = spec.pick(d).correction;
    if (correction) out.push({ key: spec.key, label: spec.label, correction });
  }
  return out.sort((a, b) => b.correction.created_at.localeCompare(a.correction.created_at));
}

// ---------------------------------------------------------------------------
// the name — the console's three postures, on a record that SAYS whether it disclosed one
// ---------------------------------------------------------------------------

/**
 * The name posture of one record. The response says outright whether it disclosed a name
 * (`name_disclosed`), so — as `identityPosture` does from key presence — a disclosure that
 * ARRIVED is named whatever the session claims, and only an undisclosed one asks the capability:
 * entitled ⇒ capped (this read was refused: the hourly name budget), not ⇒ faceless (the role).
 */
export function candidatePosture(d: CandidateDetail, entitled: boolean): IdentityPosture {
  if (d.identity.name_disclosed) return "named";
  return entitled ? "capped" : "faceless";
}

/** "Candidate 5eed…0001" — how a candidate is titled when no name is shown. */
export function candidateIdTitle(id: string): string {
  return `Candidate ${shortId(id)}`;
}

/** The drawer's title for a loaded record: the disclosed name, else the short id. */
export function candidateTitle(d: CandidateDetail): string {
  const name = d.identity.name_disclosed ? displayName(d.identity.name.value) : null;
  return name ?? candidateIdTitle(d.worker_id);
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** `quality_review` → "Quality review": de-snaked, first letter up, the rest kept. */
export function humanize(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2021-04" → "Apr 2021". Anything else is returned as it came (never guessed). */
export function formatYearMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const month = m ? Number(m[2]) : 0;
  return m && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : ym;
}

/** A stint: "Apr 2021 – present" (no end is CURRENT), "Apr 2019 – Mar 2021", or "dates not given". */
export function formatStint(start: string | null, end: string | null): string {
  if (!start && !end) return "dates not given";
  const from = start ? formatYearMonth(start) : "start not given";
  return `${from} – ${end ? formatYearMonth(end) : "present"}`;
}

/** Whole months, with the years beside them from a year up: "48 months (4 yr)", "7 months". */
export function formatMonths(n: number): string {
  const months = `${n} ${n === 1 ? "month" : "months"}`;
  if (n < 12) return months;
  const years = Math.round((n / 12) * 10) / 10;
  return `${months} (${years} yr)`;
}

/** Years of experience: "4 years", "1 year", "0.5 years". */
export function formatYears(n: number): string {
  return `${n} ${n === 1 ? "year" : "years"}`;
}

/** A yes/no answer; null means the worker never answered — not "no". */
export function formatAnswer(value: boolean | null): string {
  if (value === null) return "Not answered";
  return value ? "Yes" : "No";
}

const PERIOD_WORDS: Readonly<Record<string, string>> = {
  month: "a month",
  day: "a day",
  year: "a year",
};

/** "a month" / "a day" / "a year" — an unknown period is shown as itself. */
export function formatSalaryPeriod(period: string): string {
  return PERIOD_WORDS[period] ?? humanize(period);
}

/** The worker's own availability answer in one line: "Within a week · from 3 Nov 2026 · 15 days notice". */
export function formatAvailability(a: {
  status: string | null;
  status_label: string | null;
  available_from: string | null;
  notice_period_days: number | null;
}): string | null {
  const parts = [
    a.status_label ?? (a.status ? humanize(a.status) : null),
    a.available_from ? `from ${a.available_from}` : null,
    a.notice_period_days !== null ? `${a.notice_period_days} days notice` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A trade-level badge as words: "TIG Welder — Operator (confirmed)". */
export function formatTradeLevel(t: {
  skillId: string;
  skillLabel: string | null;
  tradeLevelLabel: string;
  levelConfirmed: boolean;
}): string {
  return `${t.skillLabel ?? humanize(t.skillId)} — ${t.tradeLevelLabel} (${
    t.levelConfirmed ? "confirmed" : "not confirmed"
  })`;
}

/** The consent state in words. */
export function consentLabel(state: string): string {
  switch (state) {
    case "none":
      return "Never given";
    case "active":
      return "Given";
    case "revoked":
      return "Withdrawn";
    default:
      return humanize(state);
  }
}
