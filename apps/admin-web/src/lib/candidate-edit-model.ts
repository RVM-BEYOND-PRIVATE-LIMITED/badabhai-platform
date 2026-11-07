import type { CandidateDetail } from "./candidate-detail";
import { formatPayBand } from "./format";

/**
 * The candidate correction form's pure model (A7, #2577; API #2561; #2728).
 *
 * ── WHAT IS EDITABLE ──────────────────────────────────────────────────────────────────
 * Every correctable fact now has a section. The eight structured facts (skills, work history,
 * education, certifications, training, languages, work types and documents) prefill from the
 * record's `correction_values` block — the EFFECTIVE current value in the correction API's own
 * shapes. When that block is null (the session lacks `edit_candidates`, or an older API answered)
 * those sections are not offered at all; the simple sections keep working from the general
 * record.
 *
 * The structured rows are held in the draft as JSON strings, because the draft is one string per
 * input. The parse/serialize helpers below are the only place that shape is interpreted, and
 * `draftFactValue` always emits the API's shape — work history never carries a voice-note id.
 *
 * Locked facts (`full_name`, `phone_e164`, `whatsapp_enc`, `resume_show_photo`) are never in a
 * section; the API refuses them, and the UI shows them locked.
 */

export const CORRECTION_REASON_CODES = [
  "worker_request",
  "profile_correction",
  "verification_error",
  "other",
] as const;
export type CorrectionReasonCode = (typeof CORRECTION_REASON_CODES)[number];

export const CORRECTION_REASON_LABELS: Record<CorrectionReasonCode, string> = {
  worker_request: "Worker asked for this change",
  profile_correction: "Correcting the profile",
  verification_error: "A verification error",
  other: "Other",
};

/** One row of `GET /admin/candidates/:id/corrections` — metadata plus the reason text. */
export interface CorrectionHistoryItem {
  override_id: string;
  fact_key: string;
  admin_id: string;
  reason_code: string;
  reason_text: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_id: string | null;
  live: boolean;
}

/** What the drawer knows about the correction history right now. */
export type CorrectionHistoryView =
  | { status: "idle" | "loading"; items: readonly CorrectionHistoryItem[] }
  | { status: "ok"; items: readonly CorrectionHistoryItem[] }
  | { status: "failed"; items: readonly CorrectionHistoryItem[]; error: string };

/** The T2 reason choices, in the shape `ConfirmDialog` takes. */
export const CORRECTION_REASON_CATEGORIES = CORRECTION_REASON_CODES.map((value) => ({
  value,
  label: CORRECTION_REASON_LABELS[value],
}));

/** Every fact key the API corrects, in the drawer's language (the Edit log names them). */
export const FACT_LABELS: Readonly<Record<string, string>> = {
  current_city: "Current city",
  preferred_locations: "Wants to work in",
  trade: "Trade",
  role: "Role",
  secondary_roles: "Other occupations",
  skills: "Skills",
  experience: "Total experience",
  work_history: "Work history",
  education: "Education",
  certifications: "Certifications",
  training: "Training",
  languages: "Languages",
  salary_expected: "Expected salary",
  salary_period: "Salary period",
  availability: "Availability",
  shift: "Shift",
  relocation: "Willing to relocate",
  accommodation: "Needs accommodation",
  job_type: "Employment type",
  work_types: "Work types",
  commute_max_km: "Longest commute",
  willing_to_travel: "Willing to travel",
  documents_ready: "Documents ready",
};

/**
 * Facts whose current value the record cannot hand back in the correction's own shape. Empty as
 * of #2728: the gated `correction_values` block supplies all eight structured facts. Kept as an
 * export so a future record that withholds a value has one named place to say so.
 */
export const UNEDITABLE_FACT_KEYS = [] as const;

/** The structured editors' field kinds — one client component renders each. */
export const STRUCTURED_EDIT_KINDS = [
  "skill-list",
  "work-history-rows",
  "education-rows",
  "certificate-rows",
  "training-rows",
  "language-rows",
  "work-type-list",
  "document-list",
] as const;
export type StructuredEditKind = (typeof STRUCTURED_EDIT_KINDS)[number];

export function isStructuredEditKind(kind: EditFieldSpec["kind"]): kind is StructuredEditKind {
  return (STRUCTURED_EDIT_KINDS as readonly string[]).includes(kind);
}

/** One input in an edit section. Several inputs may feed ONE fact (salary ends, availability). */
export interface EditFieldSpec {
  /** The input's name in the draft. */
  formKey: string;
  /** The correction fact the input feeds. */
  factKey: string;
  label: string;
  kind:
    | "text"
    | "city-list"
    | "id"
    | "id-list"
    | "number"
    | "int"
    | "date"
    | "select"
    | "tri"
    | StructuredEditKind;
  /** `select` options, and the closed sets for the two list editors. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
}

export type EditSectionId =
  | "location"
  | "trade"
  | "work"
  | "skills"
  | "work-history"
  | "education"
  | "certifications"
  | "training"
  | "languages"
  | "work-types"
  | "documents"
  | "pay";

export interface EditSection {
  id: EditSectionId;
  title: string;
  fields: readonly EditFieldSpec[];
}

const SHIFT_OPTIONS = [
  { value: "day", label: "Day shift" },
  { value: "night", label: "Night shift" },
  { value: "rotational", label: "Rotational shifts" },
  { value: "any", label: "Any shift" },
] as const;

const JOB_TYPE_OPTIONS = [
  { value: "permanent", label: "Permanent" },
  { value: "contract", label: "Contract" },
  { value: "apprentice", label: "Apprenticeship" },
  { value: "daily_wage", label: "Daily wage" },
] as const;

/** The work-types correction's closed set — the same four slugs `job_type` uses. */
export const WORK_TYPE_OPTIONS = JOB_TYPE_OPTIONS;

/**
 * The documents-ready correction's closed set (the API dictionary; a correction may tick at most
 * eight).
 */
export const DOCUMENT_OPTIONS = [
  { value: "aadhaar", label: "Aadhaar" },
  { value: "pan", label: "PAN" },
  { value: "bank_account", label: "Bank account" },
  { value: "uan_pf", label: "UAN / PF" },
  { value: "esic", label: "ESIC" },
  { value: "iti_certificate", label: "ITI certificate" },
  { value: "experience_letter", label: "Experience letter" },
  { value: "passport_photos", label: "Passport photos" },
  { value: "driving_licence", label: "Driving licence" },
] as const;

/** The languages correction's closed set (16 slugs; the API caps a submission at 16). */
export const LANGUAGE_OPTIONS = [
  { value: "hindi", label: "Hindi" },
  { value: "english", label: "English" },
  { value: "haryanvi", label: "Haryanvi" },
  { value: "bhojpuri", label: "Bhojpuri" },
  { value: "punjabi", label: "Punjabi" },
  { value: "marathi", label: "Marathi" },
  { value: "gujarati", label: "Gujarati" },
  { value: "bengali", label: "Bengali" },
  { value: "tamil", label: "Tamil" },
  { value: "telugu", label: "Telugu" },
  { value: "kannada", label: "Kannada" },
  { value: "malayalam", label: "Malayalam" },
  { value: "odia", label: "Odia" },
  { value: "urdu", label: "Urdu" },
  { value: "assamese", label: "Assamese" },
  { value: "rajasthani", label: "Rajasthani" },
] as const;

/** The education correction's closed credential set. */
export const EDUCATION_CREDENTIAL_OPTIONS = [
  { value: "below_10", label: "Below 10th" },
  { value: "class_10", label: "10th pass" },
  { value: "class_12", label: "12th pass" },
  { value: "iti", label: "ITI" },
  { value: "diploma", label: "Diploma" },
  { value: "graduate", label: "Graduate" },
  { value: "postgraduate", label: "Postgraduate" },
  { value: "doctorate", label: "Doctorate" },
] as const;

/** The education correction's closed council set. */
export const EDUCATION_COUNCIL_OPTIONS = [
  { value: "ncvt", label: "NCVT" },
  { value: "scvt", label: "SCVT" },
  { value: "nsqf", label: "NSQF" },
  { value: "aicte", label: "AICTE" },
  { value: "state_board", label: "State board" },
  { value: "cbse", label: "CBSE" },
  { value: "icse", label: "ICSE" },
  { value: "open_school", label: "NIOS / Open school" },
] as const;

const PERIOD_OPTIONS = [
  { value: "month", label: "Per month" },
  { value: "day", label: "Per day" },
  { value: "year", label: "Per year" },
] as const;

const AVAILABILITY_OPTIONS = [
  { value: "immediate", label: "Immediately" },
  { value: "within_week", label: "Within a week" },
  { value: "within_month", label: "Within a month" },
  { value: "serving_notice", label: "Serving notice" },
] as const;

const TRI_OPTIONS = [
  { value: "", label: "Not answered" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

/** The sections the drawer can edit, and the facts each one saves together. */
export const EDIT_SECTIONS: readonly EditSection[] = [
  {
    id: "location",
    title: "Location",
    fields: [
      {
        formKey: "current_city",
        factKey: "current_city",
        label: "Current city",
        kind: "text",
        placeholder: "Pune",
        help: "The city the worker currently lives in.",
      },
      {
        formKey: "preferred_locations",
        factKey: "preferred_locations",
        label: "Wants to work in",
        kind: "city-list",
        placeholder: "Pune, Chakan",
        help: "One to five cities, separated by commas.",
      },
    ],
  },
  {
    id: "trade",
    title: "Trade",
    fields: [
      {
        formKey: "trade",
        factKey: "trade",
        label: "Trade id",
        kind: "text",
        placeholder: "dom_welder",
        help: "A canonical trade id (dom_*). Leave empty to clear it.",
      },
      {
        formKey: "role",
        factKey: "role",
        label: "Role id",
        kind: "text",
        placeholder: "role_tig_welder",
        help: "A canonical role id (role_*). Leave empty to clear it.",
      },
      {
        formKey: "secondary_roles",
        factKey: "secondary_roles",
        label: "Other occupations",
        kind: "id-list",
        placeholder: "role_fitter, role_grinder",
        help: "Up to four role ids, separated by commas.",
      },
    ],
  },
  {
    id: "work",
    title: "Experience",
    fields: [
      {
        formKey: "experience",
        factKey: "experience",
        label: "Total experience",
        kind: "number",
        placeholder: "4",
        help: "Whole years, from 0 to 60. Leave empty when the worker has not said.",
      },
    ],
  },
  // ── #2728 — the eight structured facts, pre-filled from `correction_values` ──────────────
  {
    id: "skills",
    title: "Skills",
    fields: [
      {
        formKey: "skills",
        factKey: "skills",
        label: "Skills",
        kind: "skill-list",
        help: "Choose up to 50 skill ids. An id the match list does not know stays visible as-is.",
      },
    ],
  },
  {
    id: "work-history",
    title: "Work history",
    fields: [
      {
        formKey: "work_history",
        factKey: "work_history",
        label: "Work history",
        kind: "work-history-rows",
        help: "Up to four employments, each with one to four roles. A voice note can never be attached.",
      },
    ],
  },
  {
    id: "education",
    title: "Education",
    fields: [
      {
        formKey: "education",
        factKey: "education",
        label: "Education",
        kind: "education-rows",
        help: "Up to four entries; each must name at least one thing.",
      },
    ],
  },
  {
    id: "certifications",
    title: "Certifications",
    fields: [
      {
        formKey: "certifications",
        factKey: "certifications",
        label: "Certifications",
        kind: "certificate-rows",
        help: "Up to eight certificates, licences or trade qualifications.",
      },
    ],
  },
  {
    id: "training",
    title: "Training",
    fields: [
      {
        formKey: "training",
        factKey: "training",
        label: "Training",
        kind: "training-rows",
        help: "Up to eight courses or training programmes.",
      },
    ],
  },
  {
    id: "languages",
    title: "Languages",
    fields: [
      {
        formKey: "languages",
        factKey: "languages",
        label: "Languages",
        kind: "language-rows",
        help: "Up to sixteen languages, each with at least one ability and no repeats.",
      },
    ],
  },
  {
    id: "work-types",
    title: "Work types",
    fields: [
      {
        formKey: "work_types",
        factKey: "work_types",
        label: "Work types",
        kind: "work-type-list",
        options: WORK_TYPE_OPTIONS,
        help: "Choose up to four of the listed work types.",
      },
    ],
  },
  {
    id: "documents",
    title: "Documents ready",
    fields: [
      {
        formKey: "documents_ready",
        factKey: "documents_ready",
        label: "Documents ready",
        kind: "document-list",
        options: DOCUMENT_OPTIONS,
        help: "Choose up to eight of the listed documents.",
      },
    ],
  },
  {
    id: "pay",
    title: "Pay and availability",
    fields: [
      {
        formKey: "salary_min",
        factKey: "salary_expected",
        label: "Salary from",
        kind: "int",
        placeholder: "12000",
      },
      {
        formKey: "salary_max",
        factKey: "salary_expected",
        label: "Salary to",
        kind: "int",
        placeholder: "18000",
      },
      {
        formKey: "salary_period",
        factKey: "salary_period",
        label: "Salary period",
        kind: "select",
        options: PERIOD_OPTIONS,
      },
      {
        formKey: "availability_status",
        factKey: "availability",
        label: "Available",
        kind: "select",
        options: AVAILABILITY_OPTIONS,
      },
      {
        formKey: "available_from",
        factKey: "availability",
        label: "Available from",
        kind: "date",
      },
      {
        formKey: "notice_period_days",
        factKey: "availability",
        label: "Notice (days)",
        kind: "int",
        placeholder: "15",
      },
      {
        formKey: "shift",
        factKey: "shift",
        label: "Shift",
        kind: "select",
        options: SHIFT_OPTIONS,
      },
      {
        formKey: "job_type",
        factKey: "job_type",
        label: "Employment type",
        kind: "select",
        options: JOB_TYPE_OPTIONS,
      },
      {
        formKey: "relocation",
        factKey: "relocation",
        label: "Willing to relocate",
        kind: "tri",
        options: TRI_OPTIONS,
      },
      {
        formKey: "accommodation",
        factKey: "accommodation",
        label: "Needs accommodation",
        kind: "tri",
        options: TRI_OPTIONS,
      },
      {
        formKey: "commute_max_km",
        factKey: "commute_max_km",
        label: "Longest commute (km)",
        kind: "int",
        placeholder: "25",
      },
      {
        formKey: "willing_to_travel",
        factKey: "willing_to_travel",
        label: "Willing to travel",
        kind: "tri",
        options: TRI_OPTIONS,
      },
    ],
  },
];

export function editSection(id: EditSectionId): EditSection {
  return EDIT_SECTIONS.find((s) => s.id === id)!;
}

/** The draft: an input value per form key. `""` means "not answered" for nullable fields. */
export type EditDraft = Readonly<Record<string, string>>;

const triValue = (value: boolean | null): string =>
  value === null ? "" : value ? "true" : "false";

/** The label of a closed option, matched case-insensitively (the record returns labels). */
function optionFromLabel(
  options: ReadonlyArray<{ value: string; label: string }>,
  label: string | null,
): string {
  if (label === null) return "";
  const found = options.find((o) => o.label.toLocaleLowerCase() === label.toLocaleLowerCase());
  return found?.value ?? "";
}

// ---------------------------------------------------------------------------
// #2728 — the structured rows, parsed and serialized in the API's own shapes
// ---------------------------------------------------------------------------

export interface WorkHistoryRoleDraft {
  role_label: string;
  start_ym: string;
  end_ym: string;
  work_done: string;
}

export interface WorkHistoryDraftRow {
  employer_name: string;
  employer_city: string;
  employer_state: string;
  start_ym: string;
  end_ym: string;
  roles: WorkHistoryRoleDraft[];
}

export interface EducationDraftRow {
  credential: string;
  field: string;
  council: string;
  year: string;
  institute: string;
}

export interface CertificateDraftRow {
  name: string;
  issuer: string;
  year: string;
  licence_number: string;
  licence_expiry: string;
}

export interface TrainingDraftRow {
  name: string;
  provider: string;
  year: string;
}

export interface LanguageDraftRow {
  language: string;
  can_speak: boolean;
  can_read: boolean;
  can_write: boolean;
}

function jsonValue(value: string | undefined): unknown {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseWorkHistoryRows(value: string | undefined): WorkHistoryDraftRow[] {
  const employments = jsonArray(jsonObject(jsonValue(value)).employments);
  return employments.map((entry) => {
    const e = jsonObject(entry);
    const rawRoles = jsonArray(e.roles);
    const roles: WorkHistoryRoleDraft[] =
      rawRoles.length > 0
        ? rawRoles.map((role) => {
            const r = jsonObject(role);
            return {
              role_label: stringOf(r.role_label),
              start_ym: stringOf(r.start_ym),
              end_ym: stringOf(r.end_ym),
              work_done: stringOf(r.work_done),
            };
          })
        : [
            {
              role_label: stringOf(e.role_label),
              start_ym: stringOf(e.start_ym),
              end_ym: stringOf(e.end_ym),
              work_done: stringOf(e.work_done),
            },
          ];
    return {
      employer_name: stringOf(e.employer_name),
      employer_city: stringOf(e.employer_city),
      employer_state: stringOf(e.employer_state),
      start_ym: stringOf(e.start_ym),
      end_ym: stringOf(e.end_ym),
      roles,
    };
  });
}

/**
 * Always emits the `roles[]` form, which the API accepts for one or more roles. Voice-note ids
 * are written as `null` at both levels: an admin correction can never attach a worker's audio.
 */
export function serializeWorkHistoryRows(rows: readonly WorkHistoryDraftRow[]): string {
  return JSON.stringify({
    employments: rows.map((row) => ({
      employer_name: row.employer_name.trim(),
      employer_city: emptyToNull(row.employer_city),
      employer_state: emptyToNull(row.employer_state),
      start_ym: emptyToNull(row.start_ym),
      end_ym: emptyToNull(row.end_ym),
      // Explicit at BOTH levels: an admin correction never attaches a worker's audio.
      work_done: null,
      work_done_voice_note_id: null,
      roles: row.roles.map((role) => ({
        role_label: role.role_label.trim(),
        start_ym: emptyToNull(role.start_ym),
        end_ym: emptyToNull(role.end_ym),
        work_done: emptyToNull(role.work_done),
        work_done_voice_note_id: null,
      })),
    })),
  });
}

export function parseEducationRows(value: string | undefined): EducationDraftRow[] {
  return jsonArray(jsonValue(value)).map((entry) => {
    const e = jsonObject(entry);
    return {
      credential: stringOf(e.credential),
      field: stringOf(e.field),
      council: stringOf(e.council),
      year: numberText(e.year),
      institute: stringOf(e.institute),
    };
  });
}

export function serializeEducationRows(rows: readonly EducationDraftRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      credential: emptyToNull(row.credential),
      field: emptyToNull(row.field),
      council: emptyToNull(row.council),
      year: intOrNull(row.year),
      institute: emptyToNull(row.institute),
    })),
  );
}

export function parseCertificateRows(value: string | undefined): CertificateDraftRow[] {
  return jsonArray(jsonValue(value)).map((entry) => {
    const e = jsonObject(entry);
    return {
      name: stringOf(e.name),
      issuer: stringOf(e.issuer),
      year: numberText(e.year),
      licence_number: stringOf(e.licence_number),
      licence_expiry: stringOf(e.licence_expiry),
    };
  });
}

export function serializeCertificateRows(rows: readonly CertificateDraftRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      name: row.name.trim(),
      issuer: emptyToNull(row.issuer),
      year: intOrNull(row.year),
      licence_number: emptyToNull(row.licence_number),
      licence_expiry: emptyToNull(row.licence_expiry),
    })),
  );
}

export function parseTrainingRows(value: string | undefined): TrainingDraftRow[] {
  return jsonArray(jsonValue(value)).map((entry) => {
    const e = jsonObject(entry);
    return {
      name: stringOf(e.name),
      provider: stringOf(e.provider),
      year: numberText(e.year),
    };
  });
}

export function serializeTrainingRows(rows: readonly TrainingDraftRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      name: row.name.trim(),
      provider: emptyToNull(row.provider),
      year: intOrNull(row.year),
    })),
  );
}

export function parseLanguageRows(value: string | undefined): LanguageDraftRow[] {
  return jsonArray(jsonValue(value)).map((entry) => {
    const e = jsonObject(entry);
    return {
      language: stringOf(e.language),
      can_speak: e.can_speak === true,
      can_read: e.can_read === true,
      can_write: e.can_write === true,
    };
  });
}

export function serializeLanguageRows(rows: readonly LanguageDraftRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      language: row.language.trim(),
      can_speak: row.can_speak,
      can_read: row.can_read,
      can_write: row.can_write,
    })),
  );
}

export function parseStringList(value: string | undefined): string[] {
  return jsonArray(jsonValue(value))
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

export function serializeStringList(values: readonly string[]): string {
  return JSON.stringify(values);
}

/**
 * The section's fields, pre-filled from the record. Values the correction can clear start blank;
 * a label the build does not know stays blank rather than being written back as a slug.
 */
export function initialEditDraft(detail: CandidateDetail, sectionId: EditSectionId): EditDraft {
  const section = editSection(sectionId);
  const draft: Record<string, string> = {};
  const p = detail.preferences;
  const band = detail.salary.band.value;
  const availability = p.availability.value;
  // #2728 — the EFFECTIVE values, in the correction API's shapes (null without edit_candidates).
  const values = detail.correction_values;
  for (const field of section.fields) {
    switch (field.formKey) {
      case "current_city":
        draft[field.formKey] = detail.location.current_city.value ?? "";
        break;
      case "preferred_locations":
        draft[field.formKey] = detail.location.preferred_locations.value.join(", ");
        break;
      case "trade":
        draft[field.formKey] = detail.trade.canonical_trade_id.value ?? "";
        break;
      case "role":
        draft[field.formKey] = detail.trade.canonical_role_id.value ?? "";
        break;
      case "secondary_roles":
        draft[field.formKey] = detail.trade.secondary_roles.value.map((r) => r.id).join(", ");
        break;
      case "experience":
        draft[field.formKey] = detail.experience.total_years.value?.toString() ?? "";
        break;
      case "skills":
        draft[field.formKey] = serializeStringList(values?.skills ?? []);
        break;
      case "work_history":
        draft[field.formKey] = JSON.stringify(values?.work_history ?? { employments: [] });
        break;
      case "education":
        draft[field.formKey] = JSON.stringify(values?.education ?? []);
        break;
      case "certifications":
        draft[field.formKey] = JSON.stringify(values?.certifications ?? []);
        break;
      case "training":
        draft[field.formKey] = JSON.stringify(values?.training ?? []);
        break;
      case "languages":
        draft[field.formKey] = JSON.stringify(values?.languages ?? []);
        break;
      case "work_types":
        draft[field.formKey] = serializeStringList(values?.work_types ?? []);
        break;
      case "documents_ready":
        draft[field.formKey] = serializeStringList(values?.documents_ready ?? []);
        break;
      case "salary_min":
        draft[field.formKey] = band?.low?.toString() ?? "";
        break;
      case "salary_max":
        draft[field.formKey] = band?.high?.toString() ?? "";
        break;
      case "salary_period":
        draft[field.formKey] = detail.salary.period.value ?? "";
        break;
      case "availability_status":
        draft[field.formKey] = availability.status ?? "";
        break;
      case "available_from":
        draft[field.formKey] = availability.available_from?.slice(0, 10) ?? "";
        break;
      case "notice_period_days":
        draft[field.formKey] = availability.notice_period_days?.toString() ?? "";
        break;
      case "shift":
        draft[field.formKey] = optionFromLabel(SHIFT_OPTIONS, p.shift.value);
        break;
      case "job_type":
        draft[field.formKey] = optionFromLabel(JOB_TYPE_OPTIONS, p.job_type.value);
        break;
      case "relocation":
        draft[field.formKey] = triValue(p.relocation.value);
        break;
      case "accommodation":
        draft[field.formKey] = triValue(p.accommodation.value);
        break;
      case "commute_max_km":
        draft[field.formKey] = p.commute_max_km.value?.toString() ?? "";
        break;
      case "willing_to_travel":
        draft[field.formKey] = triValue(p.willing_to_travel.value);
        break;
      default:
        draft[field.formKey] = "";
    }
  }
  return draft;
}

/** Trimmed text, or null when empty. */
function textOrNull(value: string | undefined): string | null {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
}

function intOrNull(value: string | undefined): number | null {
  const t = value?.trim() ?? "";
  if (t === "") return null;
  return Number(t);
}

function boolOrNull(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function cities(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * Work history in the PUT's own shape. A single-role employment keeps the shorthand if that is
 * what the draft holds; one written by the editor uses `roles[]`. Either way a voice-note id is
 * emitted as `null` — an admin correction can never attach a worker's audio.
 */
function workHistoryFactValue(value: string | undefined): { employments: unknown[] } {
  const employments = jsonArray(jsonObject(jsonValue(value)).employments).map((entry) => {
    const e = jsonObject(entry);
    const base = {
      employer_name: stringOf(e.employer_name).trim(),
      employer_city: emptyToNull(stringOf(e.employer_city)),
      employer_state: emptyToNull(stringOf(e.employer_state)),
      start_ym: emptyToNull(stringOf(e.start_ym)),
      end_ym: emptyToNull(stringOf(e.end_ym)),
    };
    const roles = jsonArray(e.roles);
    if (roles.length > 0) {
      return {
        ...base,
        work_done: null,
        work_done_voice_note_id: null,
        roles: roles.map((role) => {
          const r = jsonObject(role);
          return {
            role_label: stringOf(r.role_label).trim(),
            start_ym: emptyToNull(stringOf(r.start_ym)),
            end_ym: emptyToNull(stringOf(r.end_ym)),
            work_done: emptyToNull(stringOf(r.work_done)),
            work_done_voice_note_id: null,
          };
        }),
      };
    }
    return {
      ...base,
      role_label: stringOf(e.role_label).trim(),
      work_done: emptyToNull(stringOf(e.work_done)),
      work_done_voice_note_id: null,
    };
  });
  return { employments };
}

function educationFactValue(value: string | undefined): unknown[] {
  return parseEducationRows(value).map((row) => ({
    credential: emptyToNull(row.credential),
    field: emptyToNull(row.field),
    council: emptyToNull(row.council),
    year: intOrNull(row.year),
    institute: emptyToNull(row.institute),
  }));
}

function certificateFactValue(value: string | undefined): unknown[] {
  return parseCertificateRows(value).map((row) => ({
    name: row.name.trim(),
    issuer: emptyToNull(row.issuer),
    year: intOrNull(row.year),
    licence_number: emptyToNull(row.licence_number),
    licence_expiry: emptyToNull(row.licence_expiry),
  }));
}

function trainingFactValue(value: string | undefined): unknown[] {
  return parseTrainingRows(value).map((row) => ({
    name: row.name.trim(),
    provider: emptyToNull(row.provider),
    year: intOrNull(row.year),
  }));
}

function languageFactValue(value: string | undefined): unknown[] {
  return parseLanguageRows(value).map((row) => ({
    language: row.language.trim(),
    can_speak: row.can_speak,
    can_read: row.can_read,
    can_write: row.can_write,
  }));
}

/** The fact's value as the correction API takes it, from this section's inputs. */
export function draftFactValue(factKey: string, draft: EditDraft): unknown {
  switch (factKey) {
    case "current_city":
      return textOrNull(draft.current_city);
    case "preferred_locations":
      return cities(draft.preferred_locations);
    case "trade":
      return textOrNull(draft.trade);
    case "role":
      return textOrNull(draft.role);
    case "secondary_roles":
      return cities(draft.secondary_roles);
    case "experience":
      return draft.experience?.trim() === "" ? null : Number(draft.experience);
    case "salary_expected": {
      const min = intOrNull(draft.salary_min);
      const max = intOrNull(draft.salary_max);
      return min === null && max === null ? null : { min, max };
    }
    case "salary_period":
      return textOrNull(draft.salary_period);
    case "availability": {
      const status = textOrNull(draft.availability_status);
      const from = textOrNull(draft.available_from);
      const notice = intOrNull(draft.notice_period_days);
      return status === null && from === null && notice === null
        ? null
        : { status, available_from: from, notice_period_days: notice };
    }
    case "shift":
      return textOrNull(draft.shift);
    case "job_type":
      return textOrNull(draft.job_type);
    case "relocation":
      return boolOrNull(draft.relocation);
    case "accommodation":
      return boolOrNull(draft.accommodation);
    case "commute_max_km":
      return intOrNull(draft.commute_max_km);
    case "willing_to_travel":
      return boolOrNull(draft.willing_to_travel);
    case "skills":
      return parseStringList(draft.skills);
    case "work_history":
      return workHistoryFactValue(draft.work_history);
    case "education":
      return educationFactValue(draft.education);
    case "certifications":
      return certificateFactValue(draft.certifications);
    case "training":
      return trainingFactValue(draft.training);
    case "languages":
      return languageFactValue(draft.languages);
    case "work_types":
      return parseStringList(draft.work_types);
    case "documents_ready":
      return parseStringList(draft.documents_ready);
    default:
      return null;
  }
}

/** One changed fact, ready for review. */
export interface EditChange {
  factKey: string;
  label: string;
  before: string;
  after: string;
  value: unknown;
}

/** "Not answered", a comma list, or a closed option's label. */
function displayOption(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string | null,
): string {
  if (value === null || value === "") return "Not answered";
  return options.find((o) => o.value === value)?.label ?? value;
}

/** "YYYY-MM – present", or the honest "dates not stated". */
function monthRange(start: string, end: string): string {
  if (start === "" && end === "") return "dates not stated";
  return `${start || "unknown"} – ${end || "present"}`;
}

function joinParts(parts: readonly (string | null)[]): string {
  return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
}

function workHistoryValueSummary(value: unknown): string {
  const employments = jsonArray(jsonObject(value).employments);
  if (employments.length === 0) return "—";
  return employments
    .map((entry, index) => {
      const e = jsonObject(entry);
      const employer = stringOf(e.employer_name).trim() || `Employer ${index + 1}`;
      const place = joinParts([
        emptyToNull(stringOf(e.employer_city)),
        emptyToNull(stringOf(e.employer_state)),
      ]);
      const rawRoles = jsonArray(e.roles);
      const titles = (
        rawRoles.length > 0
          ? rawRoles.map((role) => stringOf(jsonObject(role).role_label))
          : [stringOf(e.role_label)]
      )
        .map((title) => title.trim())
        .filter((title) => title !== "")
        .join(", ");
      return `${employer}${place ? ` (${place})` : ""} · ${monthRange(
        stringOf(e.start_ym),
        stringOf(e.end_ym),
      )}${titles ? ` — ${titles}` : ""}`;
    })
    .join("; ");
}

function educationValueSummary(value: unknown): string {
  const rows = parseEducationRows(JSON.stringify(value));
  if (rows.length === 0) return "—";
  return rows
    .map((row) =>
      joinParts([
        row.credential ? displayOption(EDUCATION_CREDENTIAL_OPTIONS, row.credential) : null,
        row.field || null,
        row.council ? displayOption(EDUCATION_COUNCIL_OPTIONS, row.council) : null,
        row.year || null,
        row.institute || null,
      ]),
    )
    .map((line) => line || "—")
    .join("; ");
}

function certificateValueSummary(value: unknown): string {
  const rows = parseCertificateRows(JSON.stringify(value));
  if (rows.length === 0) return "—";
  return rows
    .map((row) =>
      joinParts([
        row.name || null,
        row.issuer || null,
        row.year || null,
        row.licence_number ? "licence on file" : null,
      ]),
    )
    .map((line) => line || "—")
    .join("; ");
}

function trainingValueSummary(value: unknown): string {
  const rows = parseTrainingRows(JSON.stringify(value));
  if (rows.length === 0) return "—";
  return rows
    .map((row) => joinParts([row.name || null, row.provider || null, row.year || null]))
    .map((line) => line || "—")
    .join("; ");
}

function languageValueSummary(value: unknown): string {
  const rows = parseLanguageRows(JSON.stringify(value));
  if (rows.length === 0) return "—";
  return rows
    .map((row) => {
      const abilities = [
        row.can_speak ? "speak" : null,
        row.can_read ? "read" : null,
        row.can_write ? "write" : null,
      ].filter((ability): ability is string => ability !== null);
      return `${displayOption(LANGUAGE_OPTIONS, row.language)} (${abilities.join(", ") || "none"})`;
    })
    .join("; ");
}

function closedListSummary(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: unknown,
): string {
  const values = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  return values.length === 0 ? "—" : values.map((slug) => displayOption(options, slug)).join(", ");
}

/** The fact's value in the review table. */
export function formatFactValue(factKey: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  switch (factKey) {
    case "preferred_locations":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
    case "secondary_roles":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
    case "salary_expected": {
      const band = value as { min: number | null; max: number | null };
      return formatPayBand(band.min, band.max);
    }
    case "salary_period":
      return displayOption(PERIOD_OPTIONS, value as string);
    case "shift":
      return displayOption(SHIFT_OPTIONS, value as string);
    case "job_type":
      return displayOption(JOB_TYPE_OPTIONS, value as string);
    case "relocation":
    case "accommodation":
    case "willing_to_travel":
      return value === true ? "Yes" : value === false ? "No" : "Not answered";
    case "commute_max_km":
      return `${value} km`;
    case "experience":
      return `${value} ${Number(value) === 1 ? "year" : "years"}`;
    case "availability": {
      const a = value as {
        status: string | null;
        available_from: string | null;
        notice_period_days: number | null;
      };
      const parts = [
        a.status === null ? null : displayOption(AVAILABILITY_OPTIONS, a.status),
        a.available_from === null ? null : `from ${a.available_from}`,
        a.notice_period_days === null ? null : `${a.notice_period_days} days notice`,
      ].filter((s): s is string => s !== null);
      return parts.length > 0 ? parts.join(" · ") : "—";
    }
    case "skills":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
    case "work_history":
      return workHistoryValueSummary(value);
    case "education":
      return educationValueSummary(value);
    case "certifications":
      return certificateValueSummary(value);
    case "training":
      return trainingValueSummary(value);
    case "languages":
      return languageValueSummary(value);
    case "work_types":
      return closedListSummary(WORK_TYPE_OPTIONS, value);
    case "documents_ready":
      return closedListSummary(DOCUMENT_OPTIONS, value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

/** The facts in this section that would change, with their before/after values. */
export function editChanges(
  detail: CandidateDetail,
  sectionId: EditSectionId,
  draft: EditDraft,
): EditChange[] {
  const initial = initialEditDraft(detail, sectionId);
  const section = editSection(sectionId);
  const factKeys = [...new Set(section.fields.map((f) => f.factKey))];
  const out: EditChange[] = [];
  for (const factKey of factKeys) {
    const before = draftFactValue(factKey, initial);
    const after = draftFactValue(factKey, draft);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({
        factKey,
        label: FACT_LABELS[factKey] ?? factKey,
        before: formatFactValue(factKey, before),
        after: formatFactValue(factKey, after),
        value: after,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #2728 — validation, at the API's own bounds
// ---------------------------------------------------------------------------

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LICENCE_NUMBER = /^[A-Za-z0-9/\- ]+$/;

function currentYear(): number {
  return new Date().getFullYear();
}

function inOptions(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): boolean {
  return options.some((option) => option.value === value);
}

function creditYearProblem(value: string): string | null {
  if (value.trim() === "") return null;
  const year = Number(value);
  if (!Number.isInteger(year)) return "Enter a whole year.";
  if (year < 1950 || year > currentYear()) {
    return `A year must be between 1950 and ${currentYear()}.`;
  }
  return null;
}

/** A draft's array, or null when the text is not one. An empty draft is an empty list. */
function arrayOrNull(value: string | undefined): unknown[] | null {
  const parsed = jsonValue(value);
  if (parsed === undefined) return (value ?? "").trim() === "" ? [] : null;
  return Array.isArray(parsed) ? parsed : null;
}

function validateWorkHistoryRows(value: string | undefined): string | null {
  const parsed = jsonValue(value);
  if (parsed === undefined)
    return (value ?? "").trim() === "" ? null : "Work history could not be read.";
  const employments = jsonArray(jsonObject(parsed).employments);
  const problems: string[] = [];
  if (employments.length > 4) problems.push("Add at most four employments.");
  const rows = parseWorkHistoryRows(value);
  rows.forEach((row, index) => {
    const at = `Employment ${index + 1}`;
    const raw = jsonObject(employments[index]);
    if (row.employer_name.trim() === "") problems.push(`${at}: employer name is required.`);
    else if (row.employer_name.trim().length > 120)
      problems.push(`${at}: employer name is too long.`);
    if (row.employer_city.trim().length > 80) problems.push(`${at}: city is too long.`);
    if (row.employer_state.trim().length > 80) problems.push(`${at}: state is too long.`);
    if (row.start_ym !== "" && !YEAR_MONTH.test(row.start_ym))
      problems.push(`${at}: start must be YYYY-MM.`);
    if (row.end_ym !== "" && !YEAR_MONTH.test(row.end_ym))
      problems.push(`${at}: end must be YYYY-MM.`);
    if (row.start_ym !== "" && row.end_ym !== "" && row.end_ym < row.start_ym) {
      problems.push(`${at}: end cannot be before start.`);
    }
    const hasShorthand = typeof raw.role_label === "string";
    const hasRoles = raw.roles !== undefined;
    if (hasShorthand === hasRoles) {
      problems.push(`${at}: send either one role or a list of roles, not both and not neither.`);
    }
    if (hasRoles && raw.work_done !== undefined && raw.work_done !== null) {
      problems.push(`${at}: a description belongs on each role when roles are used.`);
    }
    if (raw.work_done_voice_note_id !== undefined && raw.work_done_voice_note_id !== null) {
      problems.push(`${at}: a voice note cannot be attached.`);
    }
    if (hasRoles && jsonArray(raw.roles).length === 0) {
      problems.push(`${at}: add at least one role.`);
    }
    if (row.roles.length === 0) problems.push(`${at}: add at least one role.`);
    if (row.roles.length > 4) problems.push(`${at}: add at most four roles.`);
    row.roles.forEach((role, roleIndex) => {
      const roleAt = `${at}, role ${roleIndex + 1}`;
      const rawRole = jsonObject(jsonArray(raw.roles)[roleIndex]);
      if (role.role_label.trim() === "") problems.push(`${roleAt}: role title is required.`);
      else if (role.role_label.trim().length > 80)
        problems.push(`${roleAt}: role title is too long.`);
      if (role.start_ym !== "" && !YEAR_MONTH.test(role.start_ym))
        problems.push(`${roleAt}: start must be YYYY-MM.`);
      if (role.end_ym !== "" && !YEAR_MONTH.test(role.end_ym))
        problems.push(`${roleAt}: end must be YYYY-MM.`);
      if (role.start_ym !== "" && role.end_ym !== "" && role.end_ym < role.start_ym) {
        problems.push(`${roleAt}: end cannot be before start.`);
      }
      if (role.work_done.trim().length > 300) problems.push(`${roleAt}: description is too long.`);
      if (
        rawRole.work_done_voice_note_id !== undefined &&
        rawRole.work_done_voice_note_id !== null
      ) {
        problems.push(`${roleAt}: a voice note cannot be attached.`);
      }
    });
  });
  return problems.length > 0 ? [...new Set(problems)].join(" ") : null;
}

function validateEducationRows(value: string | undefined): string | null {
  const rows = arrayOrNull(value);
  if (rows === null) return "Education could not be read.";
  if (rows.length > 4) return "Add at most four education entries.";
  const parsed = parseEducationRows(value);
  const problems: string[] = [];
  parsed.forEach((row, index) => {
    const at = `Education ${index + 1}`;
    if (!row.credential && !row.field && !row.council && !row.year && !row.institute) {
      problems.push(`${at}: name at least one thing.`);
    }
    if (row.credential && !inOptions(EDUCATION_CREDENTIAL_OPTIONS, row.credential)) {
      problems.push(`${at}: choose a listed credential.`);
    }
    if (row.council && !inOptions(EDUCATION_COUNCIL_OPTIONS, row.council)) {
      problems.push(`${at}: choose a listed council.`);
    }
    if (row.field.trim().length > 80) problems.push(`${at}: field is too long.`);
    if (row.institute.trim().length > 120) problems.push(`${at}: institute is too long.`);
    const year = creditYearProblem(row.year);
    if (year) problems.push(`${at}: ${year}`);
  });
  return problems.length > 0 ? problems.join(" ") : null;
}

function validateCertificateRows(value: string | undefined): string | null {
  const rows = arrayOrNull(value);
  if (rows === null) return "Certifications could not be read.";
  if (rows.length > 8) return "Add at most eight certificates.";
  const problems: string[] = [];
  parseCertificateRows(value).forEach((row, index) => {
    const at = `Certificate ${index + 1}`;
    if (row.name.trim() === "") problems.push(`${at}: name is required.`);
    else if (row.name.trim().length > 120) problems.push(`${at}: name is too long.`);
    if (row.issuer.trim().length > 120) problems.push(`${at}: issuer is too long.`);
    const year = creditYearProblem(row.year);
    if (year) problems.push(`${at}: ${year}`);
    if (row.licence_number !== "") {
      if (row.licence_number.length > 64) problems.push(`${at}: licence number is too long.`);
      else if (!LICENCE_NUMBER.test(row.licence_number)) {
        problems.push(`${at}: licence number may use letters, digits, /, - and spaces only.`);
      }
    }
    if (row.licence_expiry !== "") {
      if (!CALENDAR_DATE.test(row.licence_expiry))
        problems.push(`${at}: expiry must be YYYY-MM-DD.`);
      else {
        const expiryYear = Number(row.licence_expiry.slice(0, 4));
        if (expiryYear < 1950 || expiryYear > 2100) {
          problems.push(`${at}: expiry year must be between 1950 and 2100.`);
        }
      }
    }
  });
  return problems.length > 0 ? problems.join(" ") : null;
}

function validateTrainingRows(value: string | undefined): string | null {
  const rows = arrayOrNull(value);
  if (rows === null) return "Training could not be read.";
  if (rows.length > 8) return "Add at most eight training entries.";
  const problems: string[] = [];
  parseTrainingRows(value).forEach((row, index) => {
    const at = `Training ${index + 1}`;
    if (row.name.trim() === "") problems.push(`${at}: name is required.`);
    else if (row.name.trim().length > 120) problems.push(`${at}: name is too long.`);
    if (row.provider.trim().length > 120) problems.push(`${at}: provider is too long.`);
    const year = creditYearProblem(row.year);
    if (year) problems.push(`${at}: ${year}`);
  });
  return problems.length > 0 ? problems.join(" ") : null;
}

function validateLanguageRows(value: string | undefined): string | null {
  const rows = arrayOrNull(value);
  if (rows === null) return "Languages could not be read.";
  if (rows.length > 16) return "Add at most sixteen languages.";
  const problems: string[] = [];
  const seen = new Set<string>();
  parseLanguageRows(value).forEach((row, index) => {
    const at = `Language ${index + 1}`;
    if (!inOptions(LANGUAGE_OPTIONS, row.language))
      problems.push(`${at}: choose a listed language.`);
    if (seen.has(row.language)) problems.push(`${at}: a language may appear only once.`);
    seen.add(row.language);
    if (!row.can_speak && !row.can_read && !row.can_write) {
      problems.push(`${at}: tick at least one ability.`);
    }
  });
  return problems.length > 0 ? [...new Set(problems)].join(" ") : null;
}

function validateClosedList(
  value: string | undefined,
  options: ReadonlyArray<{ value: string; label: string }>,
  max: number,
  what: string,
): string | null {
  const values = parseStringList(value);
  if (values.length > max) {
    const word = max === 4 ? "four" : max === 8 ? "eight" : String(max);
    return `Choose at most ${word} ${what}.`;
  }
  if (values.some((value) => !inOptions(options, value))) return `Choose only the listed ${what}.`;
  return null;
}

function validateSkillList(value: string | undefined): string | null {
  const ids = parseStringList(value);
  if (ids.length > 50) return "Choose at most 50 skills.";
  if (ids.some((id) => id.length > 80)) return "A skill id is too long.";
  return null;
}

/** One structured field's error message, or null. */
function validateStructuredField(field: EditFieldSpec, value: string | undefined): string | null {
  switch (field.kind) {
    case "skill-list":
      return validateSkillList(value);
    case "work-history-rows":
      return validateWorkHistoryRows(value);
    case "education-rows":
      return validateEducationRows(value);
    case "certificate-rows":
      return validateCertificateRows(value);
    case "training-rows":
      return validateTrainingRows(value);
    case "language-rows":
      return validateLanguageRows(value);
    case "work-type-list":
      return validateClosedList(value, WORK_TYPE_OPTIONS, 4, "work types");
    case "document-list":
      return validateClosedList(value, DOCUMENT_OPTIONS, 8, "documents");
    default:
      return null;
  }
}

/** Input errors for a section, by form key. */
export function validateEditDraft(
  _detail: CandidateDetail,
  sectionId: EditSectionId,
  draft: EditDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const section = editSection(sectionId);

  for (const field of section.fields) {
    const value = draft[field.formKey]?.trim() ?? "";
    if (field.kind === "number" || field.kind === "int") {
      if (value !== "") {
        const n = Number(value);
        if (!Number.isFinite(n)) errors[field.formKey] = "Enter a number.";
        else if (field.kind === "int" && !Number.isInteger(n))
          errors[field.formKey] = "Enter a whole number.";
        else if (field.formKey === "experience" && (n < 0 || n > 60))
          errors[field.formKey] = "Experience must be between 0 and 60 years.";
        else if (field.formKey === "commute_max_km" && (n < 0 || n > 500))
          errors[field.formKey] = "Commute must be between 0 and 500 km.";
        else if (field.formKey === "notice_period_days" && (n < 0 || n > 180))
          errors[field.formKey] = "Notice must be between 0 and 180 days.";
        else if (
          (field.formKey === "salary_min" || field.formKey === "salary_max") &&
          (n < 1000 || n > 500000)
        )
          errors[field.formKey] = "Salary must be between ₹1,000 and ₹5,00,000.";
      }
    }
    if (field.kind === "date" && value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      errors[field.formKey] = "Choose a date.";
    }
    if (field.kind === "select" && value !== "") {
      if (!field.options?.some((o) => o.value === value))
        errors[field.formKey] = "Choose one of the listed values.";
    }
    if (isStructuredEditKind(field.kind)) {
      const problem = validateStructuredField(field, draft[field.formKey]);
      if (problem) errors[field.formKey] = problem;
    }
  }

  if (sectionId === "location") {
    if ((draft.current_city ?? "").trim() === "") errors.current_city = "Enter a city.";
    const places = cities(draft.preferred_locations);
    if (places.length === 0) errors.preferred_locations = "Enter at least one city.";
    else if (places.length > 5) errors.preferred_locations = "Enter at most five cities.";
  }
  if (sectionId === "trade") {
    const roles = cities(draft.secondary_roles);
    if (roles.length > 4) errors.secondary_roles = "Enter at most four role ids.";
    if (draft.trade && !/^dom_/.test(draft.trade.trim()))
      errors.trade = "A trade id starts with dom_.";
    if (draft.role && !/^role_/.test(draft.role.trim()))
      errors.role = "A role id starts with role_.";
    for (const id of roles) {
      if (!/^role_/.test(id)) {
        errors.secondary_roles = "Each occupation is a role id starting with role_.";
        break;
      }
    }
  }
  if (sectionId === "pay") {
    const min = intOrNull(draft.salary_min);
    const max = intOrNull(draft.salary_max);
    if (min !== null && max !== null && max < min) {
      errors.salary_max = "The upper end cannot be below the lower end.";
    }
  }

  // A section with no changed fact has nothing to save; that is not an input error, but the
  // dialog uses this to disable its Save button.
  return errors;
}
