import type { CandidateDetail } from "./candidate-detail";
import { formatPayBand } from "./format";

/**
 * The candidate correction form's pure model (A7, #2577; API #2561).
 *
 * ── WHAT IS EDITABLE, AND WHAT DELIBERATELY IS NOT ────────────────────────────────────
 * The API accepts 23 fact keys, but the #2560 record does not expose every value in the shape a
 * correction takes: skills, languages, documents, work types, education, certifications,
 * training and work history arrive as LABELS or flattened summaries, while the correction
 * expects slugs or the worker's structured rows. Editing those from what this screen can see
 * would either be refused or would replace good data with a wrong shape, so this build offers
 * edit controls only for facts whose current value it can read back exactly. The remaining keys
 * are listed in {@link UNEDITABLE_FACT_KEYS} and the drawer says where the values come from.
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
  job_type: "Job type",
  work_types: "Work types",
  commute_max_km: "Longest commute",
  willing_to_travel: "Willing to travel",
  documents_ready: "Documents ready",
};

/**
 * Keys whose current value the record cannot hand back in the correction's own shape. The
 * drawer still shows their value and source; it just cannot offer a safe pre-filled form.
 *
 * EMPTY since A7's structured-edit follow-up (#2577): every correctable fact now has a
 * prefill from the record's `editable` block (or starts from an empty form where the
 * record holds nothing to prefill).
 */
export const UNEDITABLE_FACT_KEYS = [] as const;

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
    | "multi"
    | "entries";
  /** `select` and `multi` options. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  /** `entries`: the row columns. */
  columns?: ReadonlyArray<EntryColumnSpec>;
  /** `entries`: at most this many rows (the API's caps). */
  maxRows?: number;
  /** `entries`: the blank row Add appends. */
  emptyRow?: Readonly<EntryRow>;
  /** `entries`: one nested row list (work history roles). */
  children?: EntryChildSpec;
}

/** One cell of a structured row. Values are strings, except `check` (boolean). */
export interface EntryColumnSpec {
  key: string;
  label: string;
  kind: "text" | "int" | "date" | "select" | "check";
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

/** One nested row list inside an entries row (an employment's roles). */
export interface EntryChildSpec {
  key: string;
  title: string;
  addLabel: string;
  columns: ReadonlyArray<EntryColumnSpec>;
  maxRows?: number;
  emptyRow: Readonly<EntryRow>;
}

/** One structured row: cell values by column key, plus the nested rows. */
export type EntryRow = Record<string, string | boolean | EntryRow[]>;

export type EditSectionId =
  | "location"
  | "trade"
  | "work"
  | "pay"
  | "skills"
  | "languages"
  | "schooling"
  | "history";

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

/**
 * Closed vocabularies for the structured editors, mirrored from the API
 * (`worker-preferences.vocabulary.ts` — LANGUAGES, WORK_TYPES, DOCUMENTS_READY,
 * EDUCATION_QUALIFICATIONS, EDUCATION_COUNCILS). Mirrored, never re-authored: the API
 * validates every value against its own closed sets, so a slug added there must appear here
 * before an admin can pick it — and until it does the dialog surfaces the API's own 400 in
 * the result banner rather than silently dropping the choice.
 */
export const EDIT_LANGUAGES = [
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

export const EDIT_WORK_TYPES = [
  { value: "permanent", label: "Permanent" },
  { value: "contract", label: "Contract" },
  { value: "apprentice", label: "Apprenticeship" },
  { value: "daily_wage", label: "Daily wage" },
] as const;

export const EDIT_DOCUMENTS_READY = [
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

export const EDIT_EDUCATION_QUALIFICATIONS = [
  { value: "below_10", label: "Below 10th" },
  { value: "class_10", label: "10th pass" },
  { value: "class_12", label: "12th pass" },
  { value: "iti", label: "ITI" },
  { value: "diploma", label: "Diploma" },
  { value: "graduate", label: "Graduate" },
  { value: "postgraduate", label: "Postgraduate" },
  { value: "doctorate", label: "Doctorate" },
] as const;

export const EDIT_EDUCATION_COUNCILS = [
  { value: "ncvt", label: "NCVT" },
  { value: "scvt", label: "SCVT" },
  { value: "nsqf", label: "NSQF" },
  { value: "aicte", label: "AICTE" },
  { value: "state_board", label: "State board" },
  { value: "cbse", label: "CBSE" },
  { value: "icse", label: "ICSE" },
  { value: "open_school", label: "NIOS / Open school" },
] as const;

/** A credential year is never before living memory and never in the future. */
export const EDIT_YEAR_MIN = 1950;
/** Language rows per worker (the API's LANGUAGES_MAX). */
export const EDIT_LANGUAGES_MAX = 16;
/** Schooling rows per worker (the API's EDUCATIONS_MAX / CERTIFICATES_MAX / TRAININGS_MAX). */
export const EDIT_EDUCATIONS_MAX = 4;
export const EDIT_CERTIFICATES_MAX = 8;
export const EDIT_TRAININGS_MAX = 8;
/** Employments, and roles per employment, per save (the API's bounds). */
export const EDIT_EMPLOYMENTS_MAX = 4;
export const EDIT_ROLES_MAX = 4;

/** `YYYY-MM` — a month, never a date. */
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

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
    title: "Work history",
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
        label: "Job type",
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
      {
        formKey: "work_types",
        factKey: "work_types",
        label: "Work types",
        kind: "multi",
        options: EDIT_WORK_TYPES,
        help: "The kinds of work the worker will take.",
      },
      {
        formKey: "documents_ready",
        factKey: "documents_ready",
        label: "Documents ready",
        kind: "multi",
        options: EDIT_DOCUMENTS_READY,
        help: "Documents the worker says they can produce at a gate.",
      },
    ],
  },
  {
    id: "skills",
    title: "Skills",
    fields: [
      {
        formKey: "skills",
        factKey: "skills",
        label: "Skill ids",
        kind: "id-list",
        placeholder: "skill_tig_welding, skill_arc_welding",
        help: "Up to fifty skill ids, separated by commas. The correction is refused for an id the skill corpus does not know.",
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
        kind: "entries",
        maxRows: EDIT_LANGUAGES_MAX,
        emptyRow: { language: "", can_speak: false, can_read: false, can_write: false },
        columns: [
          {
            key: "language",
            label: "Language",
            kind: "select",
            options: EDIT_LANGUAGES,
            required: true,
          },
          { key: "can_speak", label: "Speaks", kind: "check" },
          { key: "can_read", label: "Reads", kind: "check" },
          { key: "can_write", label: "Writes", kind: "check" },
        ],
      },
    ],
  },
  {
    id: "schooling",
    title: "Schooling",
    fields: [
      {
        formKey: "education",
        factKey: "education",
        label: "Education",
        kind: "entries",
        maxRows: EDIT_EDUCATIONS_MAX,
        emptyRow: { credential: "", field: "", council: "", year: "", institute: "" },
        columns: [
          {
            key: "credential",
            label: "Credential",
            kind: "select",
            options: EDIT_EDUCATION_QUALIFICATIONS,
          },
          { key: "field", label: "Field", kind: "text", placeholder: "Machinist", maxLength: 80 },
          {
            key: "council",
            label: "Council",
            kind: "select",
            options: EDIT_EDUCATION_COUNCILS,
          },
          { key: "year", label: "Year", kind: "int", min: EDIT_YEAR_MIN },
          { key: "institute", label: "Institute", kind: "text", maxLength: 120 },
        ],
      },
      {
        formKey: "certifications",
        factKey: "certifications",
        label: "Certifications",
        kind: "entries",
        maxRows: EDIT_CERTIFICATES_MAX,
        emptyRow: {
          name: "",
          issuer: "",
          year: "",
          licence_number: "",
          licence_expiry: "",
        },
        columns: [
          { key: "name", label: "Name", kind: "text", required: true, maxLength: 120 },
          { key: "issuer", label: "Issuer", kind: "text", maxLength: 120 },
          { key: "year", label: "Year", kind: "int", min: EDIT_YEAR_MIN },
          {
            key: "licence_number",
            label: "Licence number",
            kind: "text",
            maxLength: 64,
            help: "Only for a licence; prefilled from the record.",
          },
          {
            key: "licence_expiry",
            label: "Licence expiry",
            kind: "date",
            maxLength: 10,
            help: "YYYY-MM-DD, only for a licence.",
          },
        ],
      },
      {
        formKey: "training",
        factKey: "training",
        label: "Training",
        kind: "entries",
        maxRows: EDIT_TRAININGS_MAX,
        emptyRow: { name: "", provider: "", year: "" },
        columns: [
          { key: "name", label: "Name", kind: "text", required: true, maxLength: 120 },
          { key: "provider", label: "Provider", kind: "text", maxLength: 120 },
          { key: "year", label: "Year", kind: "int", min: EDIT_YEAR_MIN },
        ],
      },
    ],
  },
  {
    id: "history",
    title: "Work history",
    fields: [
      {
        formKey: "work_history",
        factKey: "work_history",
        label: "Employments",
        kind: "entries",
        maxRows: EDIT_EMPLOYMENTS_MAX,
        emptyRow: {
          employer_name: "",
          employer_city: "",
          employer_state: "",
          start_ym: "",
          end_ym: "",
          roles: [],
        },
        columns: [
          {
            key: "employer_name",
            label: "Employer name",
            kind: "text",
            required: true,
            maxLength: 120,
            help: "Type the name the worker gave — it is never shown on this screen.",
          },
          { key: "employer_city", label: "City", kind: "text", maxLength: 80 },
          { key: "employer_state", label: "State", kind: "text", maxLength: 80 },
          { key: "start_ym", label: "From (YYYY-MM)", kind: "text", placeholder: "2021-04" },
          { key: "end_ym", label: "To (YYYY-MM)", kind: "text", placeholder: "2023-08" },
        ],
        children: {
          key: "roles",
          title: "Roles",
          addLabel: "Add role",
          maxRows: EDIT_ROLES_MAX,
          emptyRow: { role_label: "", start_ym: "", end_ym: "", work_done: "" },
          columns: [
            { key: "role_label", label: "Title", kind: "text", required: true, maxLength: 80 },
            { key: "start_ym", label: "From (YYYY-MM)", kind: "text", placeholder: "2021-04" },
            { key: "end_ym", label: "To (YYYY-MM)", kind: "text", placeholder: "2023-08" },
            { key: "work_done", label: "Work done", kind: "text", maxLength: 300 },
          ],
        },
      },
    ],
  },
];

export function editSection(id: EditSectionId): EditSection {
  return EDIT_SECTIONS.find((s) => s.id === id)!;
}

/** The draft: an input value per form key. Entries live here as JSON. */
export type EditDraft = Readonly<Record<string, string>>;

/** Parse an entries draft, defensively — a corrupt value reads as no rows, never a throw. */
export function parseEntries(value: string | undefined): EntryRow[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is EntryRow => typeof r === "object" && r !== null && !Array.isArray(r),
    );
  } catch {
    return [];
  }
}

/** Serialize entries for the draft. */
function serializeEntries(rows: readonly EntryRow[]): string {
  return JSON.stringify(rows);
}

/** One entries row as strings, from a correction-shaped value. */
function entryRow(value: Record<string, unknown>, stringKeys: readonly string[]): EntryRow {
  const row: EntryRow = {};
  for (const key of stringKeys) {
    const v = value[key];
    row[key] = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  }
  return row;
}

function entryYear(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) ? String(value) : "";
}

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
      case "skills":
        draft[field.formKey] = (detail.editable.skills ?? []).join(", ");
        break;
      case "languages":
        draft[field.formKey] = serializeEntries(
          (detail.editable.languages ?? []).map((l) => ({
            language: l.language,
            can_speak: l.can_speak,
            can_read: l.can_read,
            can_write: l.can_write,
          })),
        );
        break;
      case "work_types":
        draft[field.formKey] = (detail.editable.work_types ?? []).join(", ");
        break;
      case "documents_ready":
        draft[field.formKey] = (detail.editable.documents_ready ?? []).join(", ");
        break;
      case "education":
        draft[field.formKey] = serializeEntries(
          (detail.editable.education ?? []).map((e) => ({
            ...entryRow(e as unknown as Record<string, unknown>, [
              "credential",
              "field",
              "council",
              "institute",
            ]),
            year: entryYear(e.year),
          })),
        );
        break;
      case "certifications":
        draft[field.formKey] = serializeEntries(
          (detail.editable.certifications ?? []).map((c) => ({
            ...entryRow(c as unknown as Record<string, unknown>, [
              "name",
              "issuer",
              "licence_number",
              "licence_expiry",
            ]),
            year: entryYear(c.year),
          })),
        );
        break;
      case "training":
        draft[field.formKey] = serializeEntries(
          (detail.editable.training ?? []).map((t) => ({
            ...entryRow(t as unknown as Record<string, unknown>, ["name", "provider"]),
            year: entryYear(t.year),
          })),
        );
        break;
      case "work_history":
        draft[field.formKey] = serializeEntries(
          (detail.editable.work_history ?? []).map((job) => ({
            employer_name: "",
            ...entryRow(job as unknown as Record<string, unknown>, [
              "employer_city",
              "employer_state",
              "start_ym",
              "end_ym",
            ]),
            roles: (job.roles ?? []).map((r) => ({
              ...entryRow(r as unknown as Record<string, unknown>, ["role_label", "start_ym", "end_ym", "work_done"]),
            })),
          })),
        );
        break;
      case "experience":
        draft[field.formKey] = detail.experience.total_years.value?.toString() ?? "";
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

/** A draft cell as text — entries store every cell as a string or a boolean. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The nested rows of an entries cell, defensively. */
function childRows(value: unknown): EntryRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is EntryRow => typeof r === "object" && r !== null && !Array.isArray(r),
  );
}

/** An entries year cell as an integer, or null when blank. */
function entryInt(value: unknown): number | null {
  const t = asText(value).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : Number.NaN;
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
    case "skills":
      return cities(draft.skills);
    case "work_types":
      return cities(draft.work_types);
    case "documents_ready":
      return cities(draft.documents_ready);
    case "languages":
      return parseEntries(draft.languages).map((row) => ({
        language: asText(row.language).trim(),
        can_speak: row.can_speak === true,
        can_read: row.can_read === true,
        can_write: row.can_write === true,
      }));
    case "education":
      return parseEntries(draft.education).map((row) => ({
        credential: textOrNull(asText(row.credential)),
        field: textOrNull(asText(row.field)),
        council: textOrNull(asText(row.council)),
        year: entryInt(row.year),
        institute: textOrNull(asText(row.institute)),
      }));
    case "certifications":
      return parseEntries(draft.certifications).map((row) => ({
        name: asText(row.name).trim(),
        issuer: textOrNull(asText(row.issuer)),
        year: entryInt(row.year),
        licence_number: textOrNull(asText(row.licence_number)),
        licence_expiry: textOrNull(asText(row.licence_expiry)),
      }));
    case "training":
      return parseEntries(draft.training).map((row) => ({
        name: asText(row.name).trim(),
        provider: textOrNull(asText(row.provider)),
        year: entryInt(row.year),
      }));
    case "work_history":
      return parseEntries(draft.work_history).map((job) => ({
        employer_name: asText(job.employer_name).trim(),
        employer_city: textOrNull(asText(job.employer_city)),
        employer_state: textOrNull(asText(job.employer_state)),
        start_ym: textOrNull(asText(job.start_ym)),
        end_ym: textOrNull(asText(job.end_ym)),
        roles: childRows(job.roles).map((role) => ({
          role_label: asText(role.role_label).trim(),
          start_ym: textOrNull(asText(role.start_ym)),
          end_ym: textOrNull(asText(role.end_ym)),
          work_done: textOrNull(asText(role.work_done)),
        })),
      }));
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

/** A draft cell as printable text, or null when blank. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/** A draft year cell as text, or null when blank. */
function yearOf(value: unknown): string | null {
  return typeof value === "number" && Number.isInteger(value) ? String(value) : null;
}

/** A closed option's label, or the raw value when the build was not taught it. */
function lookUp(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: unknown,
): string | null {
  if (typeof value !== "string" || value === "") return null;
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Slug lists in words ("Contract, Daily wage"), or the honest dash. */
function formatSlugs(
  value: unknown,
  options: ReadonlyArray<{ value: string; label: string }>,
): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  return value.map((v) => lookUp(options, v) ?? String(v)).join(", ");
}

/** Non-blank parts joined, or null when there is nothing to print. */
function joinParts(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Languages in words: "Hindi (speaks, reads); English (speaks)". */
function formatLanguages(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  return value
    .map((row) => {
      const r = row as { language?: unknown; can_speak?: unknown; can_read?: unknown; can_write?: unknown };
      const name = lookUp(EDIT_LANGUAGES, r.language) ?? String(r.language ?? "?");
      const abilities = [
        r.can_speak === true ? "speaks" : null,
        r.can_read === true ? "reads" : null,
        r.can_write === true ? "writes" : null,
      ].filter((a): a is string => a !== null);
      return abilities.length > 0 ? `${name} (${abilities.join(", ")})` : name;
    })
    .join("; ");
}

/** Structured rows in words: a count plus the first two rows' one-line summaries. */
function formatEntries(
  value: unknown,
  unit: string,
  summarize: (row: Record<string, unknown>) => string | null,
): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  const rows = value as Record<string, unknown>[];
  const shown = rows
    .slice(0, 2)
    .map(summarize)
    .filter((s): s is string => s !== null);
  const head = `${rows.length} ${unit}${rows.length === 1 ? "" : "s"}`;
  return shown.length > 0 ? `${head}: ${shown.join("; ")}` : head;
}

/** "Not answered", a comma list, or a closed option's label. */
function displayOption(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string | null,
): string {
  if (value === null || value === "") return "Not answered";
  return options.find((o) => o.value === value)?.label ?? value;
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
    case "skills":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
    case "work_types":
      return formatSlugs(value, EDIT_WORK_TYPES);
    case "documents_ready":
      return formatSlugs(value, EDIT_DOCUMENTS_READY);
    case "languages":
      return formatLanguages(value);
    case "education":
      return formatEntries(value, "schooling", (row) =>
        joinParts([
          lookUp(EDIT_EDUCATION_QUALIFICATIONS, row.credential),
          textOf(row.field),
          lookUp(EDIT_EDUCATION_COUNCILS, row.council),
          yearOf(row.year),
          textOf(row.institute),
        ]),
      );
    case "certifications":
      return formatEntries(value, "certificate", (row) =>
        joinParts([textOf(row.name), textOf(row.issuer), yearOf(row.year)]) ?? "—",
      );
    case "training":
      return formatEntries(value, "course", (row) =>
        joinParts([textOf(row.name), textOf(row.provider), yearOf(row.year)]) ?? "—",
      );
    case "work_history":
      return formatEntries(value, "employment", (row) => {
        const roles = Array.isArray(row.roles) ? row.roles : [];
        const place = joinParts([textOf(row.employer_city), textOf(row.employer_state)]);
        const first = roles[0] as Record<string, unknown> | undefined;
        const title =
          roles.length === 1 ? textOf(first?.role_label) : `${roles.length} roles`;
        return joinParts([place, title]);
      });
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
    if (field.kind === "multi" && value !== "") {
      const unknown = cities(value).filter(
        (v) => !field.options?.some((o) => o.value === v),
      );
      if (unknown.length > 0) errors[field.formKey] = "Choose only the listed values.";
    }
    if (field.kind === "id-list" && field.formKey === "skills") {
      if (cities(value).length > 50) errors[field.formKey] = "Enter at most fifty skill ids.";
    }
    if (field.kind === "entries") {
      const problem = validateEntries(field, parseEntries(draft[field.formKey]));
      if (problem) errors[field.formKey] = problem;
      if (field.formKey === "certifications" && !problem) {
        const licenceProblem = validateCertificateLicences(parseEntries(draft[field.formKey]));
        if (licenceProblem) errors[field.formKey] = licenceProblem;
      }
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

/**
 * An entries field's first problem, in words ("Row 2: enter a title."). Null when every row
 * is shaped the way the correction API takes it.
 */
function validateEntries(field: EditFieldSpec, rows: EntryRow[]): string | null {
  if (field.maxRows !== undefined && rows.length > field.maxRows) {
    return `Enter at most ${field.maxRows} ${field.label.toLowerCase()}.`;
  }
  const nowYear = new Date().getFullYear();
  for (let i = 0; i < rows.length; i++) {
    const at = `Row ${i + 1}`;
    const problem = validateEntryRow(field.columns ?? [], rows[i]!, at, nowYear);
    if (problem) return problem;
    if (field.children) {
      const kids = childRows(rows[i]![field.children.key]);
      if (kids.length === 0) return `${at}: add at least one ${field.children.title.toLowerCase().replace(/s$/, "")}.`;
      if (
        field.children.maxRows !== undefined &&
        kids.length > field.children.maxRows
      ) {
        return `${at}: at most ${field.children.maxRows} ${field.children.title.toLowerCase()}.`;
      }
      for (let j = 0; j < kids.length; j++) {
        const childProblem = validateEntryRow(
          field.children.columns,
          kids[j]!,
          `${at}, ${field.children.title.toLowerCase().replace(/s$/, "")} ${j + 1}`,
          nowYear,
        );
        if (childProblem) return childProblem;
      }
      if (field.factKey === "work_history") {
        const span = validateSpan(
          asText(rows[i]!.start_ym),
          asText(rows[i]!.end_ym),
        );
        if (span) return `${at}: ${span}`;
        for (let j = 0; j < kids.length; j++) {
          const roleSpan = validateSpan(
            asText(kids[j]!.start_ym),
            asText(kids[j]!.end_ym),
          );
          if (roleSpan) return `${at}, role ${j + 1}: ${roleSpan}`;
        }
      }
    }
  }
  if (field.factKey === "languages") {
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const slug = asText(rows[i]!.language).trim();
      if (slug === "") continue;
      if (seen.has(slug)) return `Row ${i + 1}: this language is already listed.`;
      seen.add(slug);
      const row = rows[i]!;
      if (row.can_speak !== true && row.can_read !== true && row.can_write !== true) {
        return `Row ${i + 1}: tick at least one of speaks, reads or writes.`;
      }
    }
  }
  return null;
}

/** #2728 — the API's licence-expiry era bound, checked beside the YYYY-MM-DD shape. */
function validateCertificateLicences(rows: EntryRow[]): string | null {
  for (let i = 0; i < rows.length; i++) {
    const expiry = asText(rows[i]!.licence_expiry).trim();
    if (expiry === "") continue;
    const year = Number(expiry.slice(0, 4));
    if (year < 1950 || year > 2100) {
      return `Row ${i + 1}: licence expiry year must be between 1950 and 2100.`;
    }
  }
  return null;
}

/** One entries row's first problem, or null. */
function validateEntryRow(
  columns: ReadonlyArray<EntryColumnSpec>,
  row: EntryRow,
  at: string,
  nowYear: number,
): string | null {
  for (const col of columns) {
    if (col.kind === "check") continue;
    const text = asText(row[col.key]).trim();
    if (col.required && text === "") return `${at}: enter ${col.label.toLowerCase()}.`;
    if (text === "") continue;
    if (col.kind === "select" && !col.options?.some((o) => o.value === text)) {
      return `${at}: choose one of the listed ${col.label.toLowerCase()} values.`;
    }
    if (col.kind === "int") {
      const n = Number(text);
      if (!Number.isInteger(n)) return `${at}: ${col.label.toLowerCase()} must be a whole number.`;
      const min = col.key === "year" ? EDIT_YEAR_MIN : (col.min ?? 0);
      const max = col.key === "year" ? nowYear : (col.max ?? Number.MAX_SAFE_INTEGER);
      if (n < min || n > max) {
        return col.key === "year"
          ? `${at}: year must be between ${EDIT_YEAR_MIN} and ${nowYear}.`
          : `${at}: ${col.label.toLowerCase()} must be between ${min} and ${max}.`;
      }
    }
    if (col.key.endsWith("_ym") && !YEAR_MONTH_RE.test(text)) {
      return `${at}: use YYYY-MM for ${col.label.toLowerCase()}.`;
    }
    if (col.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return `${at}: use YYYY-MM-DD for ${col.label.toLowerCase()}.`;
    }
    if (col.key === "licence_number" && !/^[A-Za-z0-9/\- ]+$/.test(text)) {
      return `${at}: licence number may contain letters, digits, /, - and spaces only.`;
    }
    if (col.maxLength !== undefined && text.length > col.maxLength) {
      return `${at}: keep ${col.label.toLowerCase()} under ${col.maxLength} characters.`;
    }
  }
  return null;
}

/** An end that precedes its start is a typo, whichever level states it. */
function validateSpan(startYm: string, endYm: string): string | null {
  const from = startYm.trim();
  const to = endYm.trim();
  if (from !== "" && to !== "" && to < from) return "the end must not come before the start.";
  return null;
}
