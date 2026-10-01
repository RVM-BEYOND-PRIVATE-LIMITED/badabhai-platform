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
 * It also names what a card row SHOWS (BUG-CARD-LABELS): the field's label (`cardFieldLabel`,
 * reviewed copy in `companion-replies.ts`) and a closed-set value's display label
 * (`displayValue`, read from the SAME dictionaries the validation checks against).
 *
 * OWNER RULINGS ENCODED HERE (2026-09-29, amended 2026-10-01):
 *   - single-field adds only: `add` exists for skills, languages, occupations and the three list
 *     preferences; qualifications are edit/delete-only;
 *   - "Never from chat" (2026-10-01): chat never deletes a worker's whole job — employment is
 *     EDIT-ONLY here, and a whole-job delete happens only on the Profile screen;
 *   - `expected_salary` is ONE field, written to `salary_expected_max` with `salary_expected_min`
 *     cleared;
 *   - `salary_period`, `commute_max_km` and the four `education_*` preference keys are NOT in the
 *     catalogue;
 *   - list preferences are edited member-by-member (add a city/slug, delete a member), and
 *     `availability` is edited as three scalar sub-fields merged into the stored object.
 */

import { canonicalCity } from "@badabhai/profiling-lexicon";
import { labelForTaxonomyId, ROLES } from "@badabhai/taxonomy";
import { looksLikePii } from "@badabhai/validators";
import type { CompanionV2EditOp, CompanionV2EditSection } from "@badabhai/types";
import {
  AVAILABILITY_STATUSES,
  DOCUMENTS_READY,
  EDUCATION_COUNCILS,
  EDUCATION_QUALIFICATIONS,
  JOB_TYPES,
  LANGUAGES,
  labelFor,
  SHIFTS,
  WORK_TYPES,
  type PreferenceVocabulary,
} from "../../profiles/worker-preferences.vocabulary";
import { CREDENTIAL_YEAR_FLOOR, currentYear } from "../../profiles/credential-year";
import { EDIT_ENTRY_LABELS, EDIT_FIELD_LABELS, EDIT_YES_NO_LABELS } from "../companion-replies";
import { QUALIFICATION_PREFIX } from "./edit-snapshot";

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

/**
 * Scalar preferences — and every employment field: "Never from chat" (owner, 2026-10-01) makes
 * employment EDIT-ONLY, so no field offers `delete` and a whole-job delete is never carded.
 */
const EDIT: readonly CompanionV2EditOp[] = ["edit"];
const ADD_DELETE: readonly CompanionV2EditOp[] = ["add", "delete"];
/**
 * Qualifications are EDIT/DELETE-ONLY (no `add`), and `delete` is legal on every one of their
 * fields: a delete names its ROW, and the field is only the anchor the model points at (the apply
 * ignores it for deletes and uses the row's resolved target).
 */
const EDIT_DELETE: readonly CompanionV2EditOp[] = ["edit", "delete"];

/**
 * The closed catalogue, in the order the AI service receives it. Grouped by section so the
 * prompt's field list reads the way the card does.
 */
export const EDIT_CATALOGUE: readonly CatalogueField[] = [
  // employment — EDIT ONLY. No `add` (a new employment is multi-field; O5 caps a card at 3 rows)
  // and no `delete`: "Never from chat" (owner, 2026-10-01) — a whole job is removed only on the
  // Profile screen. A model row that deletes one is dropped as `job_delete` (the service).
  { section: "employment", field: "employer_name", ops: EDIT },
  { section: "employment", field: "employer_city", ops: EDIT },
  { section: "employment", field: "employer_state", ops: EDIT },
  { section: "employment", field: "start_ym", ops: EDIT },
  { section: "employment", field: "end_ym", ops: EDIT },
  { section: "employment", field: "role_label", ops: EDIT },
  { section: "employment", field: "work_done", ops: EDIT },
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

/**
 * Whether a row would delete a worker's WHOLE JOB — the one change chat may never make ("Never
 * from chat", owner ruling 2026-10-01). Decided from the section and the op alone, so it holds for
 * an untrusted model row (whatever field it anchored on) and for a card stored before the ruling.
 */
export function isWholeJobDelete(row: { readonly section: string; readonly op: string }): boolean {
  return row.section === "employment" && row.op === "delete";
}

// ── value validation ─────────────────────────────────────────────────────────────────────────

/** `YYYY-MM` — the employment DTO's own shape. */
const YEAR_MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
/** `YYYY-MM-DD` — the availability DTO's own shape. */
const YEAR_MONTH_DAY = /^\d{4}-\d{2}-\d{2}$/;

const ROLE_IDS = new Set<string>(ROLES.map((role) => role.id));

/**
 * THE CLOSED-SET FIELDS AND THE DICTIONARY EACH ONE'S VALUES ARE DRAWN FROM — the same
 * dictionaries the section writers' DTOs build their enums from, the options endpoint serves as
 * the form's chip labels, and the résumé prints. ONE TABLE, TWO READERS: `normaliseValue` accepts
 * only a slug the dictionary holds, and `displayValue` labels it with that dictionary's own words,
 * so a value a card can carry always has its label.
 */
const TOKEN_VOCABULARIES: ReadonlyMap<string, PreferenceVocabulary> = new Map([
  ["languages:language", LANGUAGES],
  ["qualifications:education_credential", EDUCATION_QUALIFICATIONS],
  ["qualifications:education_council", EDUCATION_COUNCILS],
  ["preferences:shift", SHIFTS],
  ["preferences:job_type", JOB_TYPES],
  ["preferences:availability_status", AVAILABILITY_STATUSES],
  ["preferences:work_types", WORK_TYPES],
  ["preferences:documents_ready", DOCUMENTS_READY],
]);

/** The three preference scalars stored as `"true"`/`"false"`. */
const YES_NO_KEYS: ReadonlySet<string> = new Set([
  "preferences:willing_to_travel",
  "preferences:willing_to_relocate",
  "preferences:accommodation_needed",
]);

/** A slug the dictionary holds, lower-cased as the stores keep it, or null. */
function slugIn(vocabulary: PreferenceVocabulary, raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return labelFor(vocabulary, value) === null ? null : value;
}

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
  // Languages, the education credential and council, shift, job type, availability status, work
  // types and documents: a slug of the field's own dictionary.
  const vocabulary = TOKEN_VOCABULARIES.get(key);
  if (vocabulary !== undefined) return slugIn(vocabulary, raw);
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
    // ── occupations ──
    case "occupations:role_id": {
      const value = raw.trim();
      return ROLE_IDS.has(value) ? value : null;
    }
    // ── preferences: scalars ──
    case "preferences:willing_to_travel":
    case "preferences:willing_to_relocate":
    case "preferences:accommodation_needed":
      return bool(raw);
    case "preferences:expected_salary":
      return intIn(raw, 1000, 500_000);
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
    default:
      return null;
  }
}

// ── the card's labels (BUG-CARD-LABELS) ──────────────────────────────────────────────────────

/**
 * What a closed-set value SAYS, for the card — or null when there is nothing to translate.
 *
 * `before`/`after` stay the stored tokens (the stale check and the shipped app read them); this
 * is the words beside them. A dictionary slug gets that dictionary's own label — the one the form
 * showed as a chip and the résumé prints ("hindi" → "Hindi", "uan_pf" → "UAN / PF"); a role id
 * its taxonomy label, as `GET /workers/me/occupations` serves it; a yes/no "Haan"/"Nahi".
 *
 * NULL IS THE SAFE ANSWER, never a guess: a free-text field (a name, a city, a date, a number) is
 * the worker's own words and is shown as typed, and a value its dictionary does not hold (a
 * legacy model-written availability, a retired slug) is shown as stored rather than prettified.
 */
export function displayValue(
  section: CompanionV2EditSection,
  field: string | null,
  value: string | null,
): string | null {
  if (field === null || value === null) return null;
  const key = `${section}:${field}`;
  const vocabulary = TOKEN_VOCABULARIES.get(key);
  if (vocabulary !== undefined) return labelFor(vocabulary, value);
  if (YES_NO_KEYS.has(key)) {
    return value === "true" || value === "false" ? EDIT_YES_NO_LABELS[value].latin : null;
  }
  if (key === "occupations:role_id") return ROLE_IDS.has(value) ? labelForTaxonomyId(value) : null;
  return null;
}

/**
 * The entry kind a whole-entry delete removes, read from the row's RESOLVED TARGET — the entry the
 * apply will actually remove (`planQualifications` goes by `target.list`) — never from the anchor
 * field the model chose (EDIT-ROW-KIND). Null when the target names no list: say nothing rather
 * than guess.
 */
function entryOf(
  section: CompanionV2EditSection,
  target: Readonly<Record<string, string | number>> | null,
): keyof typeof EDIT_ENTRY_LABELS | null {
  if (section === "employment") return "employment";
  const list = target?.["list"];
  return list === "certificates" || list === "educations" || list === "trainings"
    ? QUALIFICATION_PREFIX[list]
    : null;
}

/**
 * The row's field label (reviewed copy, `companion-replies.ts`), or null for a pair the catalogue
 * does not hold.
 *
 * A QUALIFICATION DELETE NAMES THE ENTRY. Qualifications are edit/delete-only and a delete removes
 * the whole entry — the field is only the model's anchor — so the label says so ("Yeh poora
 * certificate") instead of naming whichever field the model happened to point at. The kind comes
 * from `target`, the entry being removed; a qualification delete without one has NO label (null),
 * never a field's.
 *
 * AN EMPLOYMENT DELETE IS UNREACHABLE FROM A NEW PROPOSAL ("Never from chat", owner 2026-10-01):
 * the catalogue offers employment `edit` only, and `propose` drops a job delete. Its label ("Yeh
 * poora kaam") stays ONLY so a card stored before the ruling still renders on a retry — and
 * `confirm` refuses to apply such a row (stale), so the label never fronts a write.
 */
export function cardFieldLabel(
  section: CompanionV2EditSection,
  field: string | null,
  op: CompanionV2EditOp,
  target: Readonly<Record<string, string | number>> | null = null,
): string | null {
  if (field === null) return null;
  const entry = catalogueEntry(section, field);
  if (entry === undefined) return null;
  if (op === "delete" && (section === "employment" || section === "qualifications")) {
    const kind = entryOf(section, target);
    return kind === null ? null : EDIT_ENTRY_LABELS[kind].latin;
  }
  return EDIT_FIELD_LABELS[`${section}:${field}`]?.latin ?? null;
}

/**
 * Whether a value still carries a pseudonymization placeholder (`[EMPLOYER_1]`, …).
 *
 * ADR-0046 O17: v2 builds NO token rehydration, so such a row is DROPPED — and when no row
 * survives, the worker is pointed at the Profile screen (`V2_EDIT_PLACEHOLDER`). When masking is
 * removed platform-wide, no tokens appear and these edits simply work — and a hard identifier
 * the model echoes is dropped by the service's `containsHardIdentifier` gate instead (ADR-0047
 * G1).
 */
export function hasPlaceholderToken(value: string): boolean {
  return /\[[A-Z]+_\d+\]/.test(value);
}

/** Every section the catalogue can address — the service's defensive set. */
export const CATALOGUE_SECTIONS: ReadonlySet<CompanionV2EditSection> = new Set(
  EDIT_CATALOGUE.map((e) => e.section),
);
