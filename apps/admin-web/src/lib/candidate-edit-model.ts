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
 */
export const UNEDITABLE_FACT_KEYS = [
  "skills",
  "work_history",
  "education",
  "certifications",
  "training",
  "languages",
  "work_types",
  "documents_ready",
] as const;

/** One input in an edit section. Several inputs may feed ONE fact (salary ends, availability). */
export interface EditFieldSpec {
  /** The input's name in the draft. */
  formKey: string;
  /** The correction fact the input feeds. */
  factKey: string;
  label: string;
  kind: "text" | "city-list" | "id" | "id-list" | "number" | "int" | "date" | "select" | "tri";
  /** `select` options. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
}

export type EditSectionId = "location" | "trade" | "work" | "pay";

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
