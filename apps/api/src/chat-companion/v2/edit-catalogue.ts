/**
 * THE EDIT CATALOGUE (ADR-0046 §3) — the ONE place that maps a section and a logical field to
 * its writer, its legal ops and its validation.
 *
 * The model may only name a `(section, field)` pair listed here, with an op this table allows;
 * everything else is dropped before a card is built. The catalogue is also what the API sends to
 * the AI service, so the model is choosing from a closed list rather than guessing field names.
 *
 * `field` is a LOGICAL name (e.g. `expected_salary`, `preferred_cities`); the writer mapping in
 * `CompanionEditService` translates it to its store. Values are NORMALISED here — against the same
 * closed vocabularies and bounds the section writers' own DTOs enforce — and then `propose` parses
 * every row through the writer's REAL schema (`edit-plan.ts`), so the refinements that span
 * fields or screen free text (an end month before the start, a phone number in an issuer) drop a
 * row before a card can show it, rather than failing every Haan.
 *
 * OWNER RULINGS ENCODED HERE (2026-09-29):
 *   - single-field adds only: `add` exists for skills, languages, occupations and the three list
 *     preferences; employment and qualifications are edit/delete-only;
 *   - `expected_salary` is ONE field, written to `salary_expected_max` with `salary_expected_min`
 *     cleared;
 *   - `salary_period`, `commute_max_km` and the four `education_*` preference keys are NOT in the
 *     catalogue;
 *   - list preferences are edited member-by-member (add a city/slug, delete a member), and
 *     `availability` is edited as three scalar sub-fields merged into the stored object.
 */

import { canonicalCity } from "@badabhai/profiling-lexicon";
import { ROLES } from "@badabhai/taxonomy";
import { looksLikePii } from "@badabhai/validators";
import type { CompanionV2EditOp, CompanionV2EditSection } from "@badabhai/types";
import {
  AVAILABILITY_STATUSES,
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  JOB_TYPES,
  LANGUAGES,
  SHIFTS,
} from "../../profiles/worker-preferences.vocabulary";
import { CREDENTIAL_YEAR_FLOOR, currentYear } from "../../profiles/credential-year";

/** The card's display label per section (reviewed copy, shown on every row of the card). */
export const SECTION_LABELS: Readonly<Record<CompanionV2EditSection, string>> = {
  employment: "Kaam",
  skills: "Skills",
  languages: "Bhasha",
  qualifications: "Certificate aur padhai",
  occupations: "Aur kaam",
  preferences: "Pasand",
};

export interface CatalogueField {
  readonly section: CompanionV2EditSection;
  readonly field: string;
  readonly ops: readonly CompanionV2EditOp[];
}

const EDIT: readonly CompanionV2EditOp[] = ["edit"];
const ADD_DELETE: readonly CompanionV2EditOp[] = ["add", "delete"];
/**
 * Employment and qualifications are EDIT/DELETE-ONLY (no `add`), and `delete` is legal on every
 * one of their fields: a delete names its ROW, and the field is only the anchor the model points
 * at (the apply ignores it for deletes and uses the row's resolved target).
 */
const EDIT_DELETE: readonly CompanionV2EditOp[] = ["edit", "delete"];

/**
 * The closed catalogue, in the order the AI service receives it. Grouped by section so the
 * prompt's field list reads the way the card does.
 */
export const EDIT_CATALOGUE: readonly CatalogueField[] = [
  // employment — edit/delete only (a new employment is multi-field; O5 caps a card at 3 rows).
  { section: "employment", field: "employer_name", ops: EDIT_DELETE },
  { section: "employment", field: "employer_city", ops: EDIT_DELETE },
  { section: "employment", field: "employer_state", ops: EDIT_DELETE },
  { section: "employment", field: "start_ym", ops: EDIT_DELETE },
  { section: "employment", field: "end_ym", ops: EDIT_DELETE },
  { section: "employment", field: "role_label", ops: EDIT_DELETE },
  { section: "employment", field: "work_done", ops: EDIT_DELETE },
  // skills — a free-text label on the RÉSUMÉ only (owner ruling; never the matching store).
  { section: "skills", field: "skill", ops: ADD_DELETE },
  // languages — closed dictionary, member add/delete.
  { section: "languages", field: "language", ops: ADD_DELETE },
  // qualifications — edit one field of an existing row, or delete the row.
  { section: "qualifications", field: "certificate_name", ops: EDIT_DELETE },
  { section: "qualifications", field: "certificate_issuer", ops: EDIT_DELETE },
  { section: "qualifications", field: "certificate_year", ops: EDIT_DELETE },
  { section: "qualifications", field: "education_credential", ops: EDIT_DELETE },
  { section: "qualifications", field: "education_field", ops: EDIT_DELETE },
  { section: "qualifications", field: "education_council", ops: EDIT_DELETE },
  { section: "qualifications", field: "education_year", ops: EDIT_DELETE },
  { section: "qualifications", field: "education_institute", ops: EDIT_DELETE },
  { section: "qualifications", field: "training_name", ops: EDIT_DELETE },
  { section: "qualifications", field: "training_provider", ops: EDIT_DELETE },
  { section: "qualifications", field: "training_year", ops: EDIT_DELETE },
  // occupations — closed role ids, member add/delete.
  { section: "occupations", field: "role_id", ops: ADD_DELETE },
  // preferences — scalars edit; the three lists are member add/delete; availability is three
  // scalar sub-fields merged into the stored object.
  { section: "preferences", field: "shift", ops: EDIT },
  { section: "preferences", field: "job_type", ops: EDIT },
  { section: "preferences", field: "willing_to_travel", ops: EDIT },
  { section: "preferences", field: "willing_to_relocate", ops: EDIT },
  { section: "preferences", field: "accommodation_needed", ops: EDIT },
  { section: "preferences", field: "expected_salary", ops: EDIT },
  { section: "preferences", field: "availability_status", ops: EDIT },
  { section: "preferences", field: "availability_available_from", ops: EDIT },
  { section: "preferences", field: "availability_notice_period_days", ops: EDIT },
  { section: "preferences", field: "preferred_cities", ops: ADD_DELETE },
  { section: "preferences", field: "work_types", ops: ADD_DELETE },
  { section: "preferences", field: "documents_ready", ops: ADD_DELETE },
];

/** The catalogue as the AI service receives it. */
export function buildEditableFields(): {
  section: CompanionV2EditSection;
  field: string;
  ops: CompanionV2EditOp[];
}[] {
  return EDIT_CATALOGUE.map((entry) => ({
    section: entry.section,
    field: entry.field,
    ops: [...entry.ops],
  }));
}

/** `(section, field)` → entry, built once. */
const BY_KEY = new Map(EDIT_CATALOGUE.map((e) => [`${e.section}:${e.field}`, e]));

export function catalogueEntry(
  section: string,
  field: string,
): CatalogueField | undefined {
  return BY_KEY.get(`${section}:${field}`);
}

export function opAllowed(entry: CatalogueField, op: CompanionV2EditOp): boolean {
  return entry.ops.includes(op);
}

// ── value validation ─────────────────────────────────────────────────────────────────────────

/** `YYYY-MM` — the employment DTO's own shape. */
const YEAR_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
/** `YYYY-MM-DD` — the availability DTO's own shape. */
const YEAR_MONTH_DAY = /^\d{4}-\d{2}-\d{2}$/;

const ROLE_IDS = new Set<string>(ROLES.map((role) => role.id));
const LANGUAGE_SLUGS = new Set(Object.keys(LANGUAGES));
const SHIFT_SLUGS = new Set(Object.keys(SHIFTS));
const JOB_TYPE_SLUGS = new Set(Object.keys(JOB_TYPES));
const DOCUMENT_SLUGS = new Set(Object.keys(DOCUMENTS_READY));
const AVAILABILITY_SLUGS = new Set(Object.keys(AVAILABILITY_STATUSES));
const EDUCATION_CREDENTIAL_SLUGS = new Set(Object.keys(EDUCATION_QUALIFICATIONS));
const EDUCATION_COUNCIL_SLUGS = new Set(Object.keys(EDUCATION_COUNCILS));

function trimmed(raw: string, min: number, max: number): string | null {
  const value = raw.trim();
  return value.length >= min && value.length <= max ? value : null;
}

function bool(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "haan" || value === "yes") return "true";
  if (value === "false" || value === "nahi" || value === "no") return "false";
  return null;
}

function intIn(raw: string, min: number, max: number): string | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? String(n) : null;
}

/**
 * The credential DTO's own bound, read AT CALL TIME (`credential-year.ts`, #1407): a module-level
 * "this year" would refuse the current year's certificates from 1 January until the next deploy.
 * The writer's schema still has the last word — `propose` parses every row through it.
 */
function credentialYear(raw: string): string | null {
  return intIn(raw, CREDENTIAL_YEAR_FLOOR, currentYear());
}

/**
 * The proposed value, NORMALISED for the store, or null when the field will not accept it.
 *
 * Normalising rather than only checking is what makes the card's `after` and the stored value
 * the same string: a city comes back canonical ("gurgaon" → "Gurugram"), a boolean as
 * "true"/"false", a number without leading zeroes.
 */
export function normaliseValue(
  section: CompanionV2EditSection,
  field: string,
  raw: string,
): string | null {
  const key = `${section}:${field}`;
  switch (key) {
    // ── employment ──
    case "employment:employer_name":
      return trimmed(raw, 1, 120);
    case "employment:employer_city":
    case "employment:employer_state":
      return trimmed(raw, 1, 80);
    case "employment:start_ym":
    case "employment:end_ym": {
      const value = raw.trim();
      return YEAR_MONTH.test(value) ? value : null;
    }
    case "employment:role_label":
      return trimmed(raw, 1, 80);
    case "employment:work_done":
      return trimmed(raw, 1, 300);
    // ── skills ──
    case "skills:skill": {
      // A résumé chip is a skill label; a phone number or an email typed into one is not. The
      // renderer screens labels too, but a card must never SHOW one in the first place.
      const value = trimmed(raw, 1, 80);
      return value !== null && looksLikePii(value) ? null : value;
    }
    // ── languages ──
    case "languages:language": {
      const value = raw.trim().toLowerCase();
      return LANGUAGE_SLUGS.has(value) ? value : null;
    }
    // ── qualifications ──
    case "qualifications:certificate_name":
    case "qualifications:certificate_issuer":
    case "qualifications:education_institute":
    case "qualifications:training_name":
    case "qualifications:training_provider":
      return trimmed(raw, 1, 120);
    case "qualifications:certificate_year":
    case "qualifications:education_year":
    case "qualifications:training_year":
      return credentialYear(raw);
    case "qualifications:education_field":
      return trimmed(raw, 1, 80);
    case "qualifications:education_credential": {
      const value = raw.trim().toLowerCase();
      return EDUCATION_CREDENTIAL_SLUGS.has(value) ? value : null;
    }
    case "qualifications:education_council": {
      const value = raw.trim().toLowerCase();
      return EDUCATION_COUNCIL_SLUGS.has(value) ? value : null;
    }
    // ── occupations ──
    case "occupations:role_id": {
      const value = raw.trim();
      return ROLE_IDS.has(value) ? value : null;
    }
    // ── preferences: scalars ──
    case "preferences:shift": {
      const value = raw.trim().toLowerCase();
      return SHIFT_SLUGS.has(value) ? value : null;
    }
    case "preferences:job_type": {
      const value = raw.trim().toLowerCase();
      return JOB_TYPE_SLUGS.has(value) ? value : null;
    }
    case "preferences:willing_to_travel":
    case "preferences:willing_to_relocate":
    case "preferences:accommodation_needed":
      return bool(raw);
    case "preferences:expected_salary":
      return intIn(raw, 1000, 500_000);
    case "preferences:availability_status": {
      const value = raw.trim().toLowerCase();
      return AVAILABILITY_SLUGS.has(value) ? value : null;
    }
    case "preferences:availability_available_from": {
      const value = raw.trim();
      return YEAR_MONTH_DAY.test(value) ? value : null;
    }
    case "preferences:availability_notice_period_days":
      return intIn(raw, 0, 180);
    // ── preferences: list members ──
    case "preferences:preferred_cities": {
      const city = canonicalCity(raw.trim())?.value ?? null;
      return city === null ? null : trimmed(city, 1, 80);
    }
    case "preferences:work_types": {
      const value = raw.trim().toLowerCase();
      return JOB_TYPE_SLUGS.has(value) ? value : null;
    }
    case "preferences:documents_ready": {
      const value = raw.trim().toLowerCase();
      return DOCUMENT_SLUGS.has(value) ? value : null;
    }
    default:
      return null;
  }
}

/**
 * Whether a value still carries a pseudonymization placeholder (`[EMPLOYER_1]`, …).
 *
 * ADR-0046 O17: v2 builds NO token rehydration, so such a row is DROPPED — and when no row
 * survives, the worker is pointed at the Profile screen (`V2_EDIT_PLACEHOLDER`). When masking is
 * removed platform-wide, no tokens appear and these edits simply work.
 */
export function hasPlaceholderToken(value: string): boolean {
  return /\[[A-Z]+_\d+\]/.test(value);
}

/** Every section the catalogue can address — the service's defensive set. */
export const CATALOGUE_SECTIONS: ReadonlySet<CompanionV2EditSection> = new Set(
  EDIT_CATALOGUE.map((e) => e.section),
);
