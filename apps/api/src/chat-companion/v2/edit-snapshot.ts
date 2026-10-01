import { createHash } from "node:crypto";
import { resumeProfileCarriesValues, type DraftProfile } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import type { CompanionV2EditSection } from "@badabhai/types";
import type { MyEmploymentResponse } from "../../profiles/worker-employment.dto";
import type { MyLanguagesResponse } from "../../profiles/worker-languages.dto";
import type { MyOccupationsResponse } from "../../profiles/worker-occupations.dto";
import type { MyQualificationsResponse } from "../../profiles/worker-qualifications.dto";
import type { WorkPreferencesResponse } from "../../profiles/worker-preferences.dto";
import type { StoredEditProposalRow } from "./edit-proposal.store";

/**
 * THE EDIT PATH'S VIEW OF A WORKER (ADR-0046 O4) — pure, so propose, the stale check and the
 * apply all read the SAME state the same way.
 *
 * `EditState` is what each section writer's own GET returned, read once per request; a section
 * whose read failed is `undefined` and is simply absent from the snapshot (propose) or refuses
 * the confirm (see `CompanionEditService.confirm`). Nothing here reads a database or logs.
 */
export interface EditState {
  readonly employment: MyEmploymentResponse | undefined;
  /** The confirmed profile's draft, parsed — the skills section's only source. */
  readonly draft: DraftProfile | undefined;
  readonly languages: MyLanguagesResponse | undefined;
  readonly qualifications: MyQualificationsResponse | undefined;
  readonly occupations: MyOccupationsResponse | undefined;
  readonly preferences: WorkPreferencesResponse | undefined;
}

/** One current row, server-side: what the model sees plus the identity the writer needs. */
export interface SnapshotRow {
  readonly ref: string;
  readonly section: CompanionV2EditSection;
  readonly fields: Record<string, string | null>;
  readonly target: Record<string, string | number> | null;
}

export type QualificationList = "certificates" | "educations" | "trainings";

/**
 * The catalogue's field prefix per qualification list (`certificate_name`, `education_year`, …) —
 * also the entry kind a whole-entry delete names on the card (`EDIT_ENTRY_LABELS`).
 */
export const QUALIFICATION_PREFIX = {
  certificates: "certificate",
  educations: "education",
  trainings: "training",
} as const satisfies Readonly<Record<QualificationList, string>>;

/** The list a catalogue qualification field belongs to, by its prefix; null for any other name. */
export function qualificationListOfField(field: string): QualificationList | null {
  for (const list of Object.keys(QUALIFICATION_PREFIX) as QualificationList[]) {
    if (field.startsWith(`${QUALIFICATION_PREFIX[list]}_`)) return list;
  }
  return null;
}

/**
 * Whether a model row may address this snapshot row with this field — i.e. whether the field is
 * one the addressed ENTRY actually has (EDIT-ROW-KIND).
 *
 * The section matching is not enough: `q1` is an education and `certificate_name` is a
 * qualifications field, yet a delete anchored so would remove the education while the card named
 * a certificate with no value. A qualification field must name the list the ref points into; any
 * other section's field must be one of the row's own keys — a scalar preference lives on `pref`,
 * a city only on its `pcN` member, never the other way round.
 */
export function rowCarriesField(source: SnapshotRow, field: string): boolean {
  if (source.section === "qualifications") {
    const list = source.target?.["list"];
    return typeof list === "string" && qualificationListOfField(field) === list;
  }
  return Object.hasOwn(source.fields, field);
}

/** Whether the section's read succeeded, i.e. whether it can be carded, checked and applied. */
export function sectionReadable(state: EditState, section: CompanionV2EditSection): boolean {
  switch (section) {
    case "employment":
      return state.employment !== undefined;
    case "skills":
      return state.draft !== undefined;
    case "languages":
      return state.languages !== undefined;
    case "qualifications":
      return state.qualifications !== undefined;
    case "occupations":
      return state.occupations !== undefined;
    case "preferences":
      return state.preferences !== undefined;
  }
}

/** The résumé's skill labels, as the renderer prints them, deduplicated in order. */
export function skillLabelsOf(draft: DraftProfile): string[] {
  const container = draft.resume_profile;
  const labels =
    resumeProfileCarriesValues(container) && container !== null
      ? container.skills
      : [...draft.skills.map(labelForTaxonomyId), ...draft.skill_labels.map(labelForTaxonomyId)];
  return [...new Set(labels)];
}

/**
 * One qualification entry's carded fields, keyed by the CATALOGUE's names. The licence number
 * and expiry are never carded (O3-adjacent), so they are never here either.
 */
export function qualificationFields(
  list: QualificationList,
  entry: Readonly<Record<string, unknown>>,
): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "licence_number" || key === "licence_expiry") continue;
    fields[`${QUALIFICATION_PREFIX[list]}_${key}`] =
      value === null || value === undefined ? null : String(value);
  }
  return fields;
}

/**
 * WHO a qualification entry is, independent of where it sits in its list.
 *
 * Qualifications have no stored id on the wire, and a list position moves the moment anything
 * before it is deleted or the worker reorders the page elsewhere — so a card row that named an
 * entry by index alone could land on a different certificate (P1-CONF-STALE). The fingerprint is
 * a hash of every carded field: the stale check finds the entry wherever it now sits, and an entry
 * edited elsewhere no longer matches. The hash covers carded fields only — never the licence.
 */
export function qualificationFingerprint(
  list: QualificationList,
  entry: Readonly<Record<string, unknown>>,
): string {
  const fields = qualificationFields(list, entry);
  const basis = JSON.stringify(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** The worker's current values as snapshot rows, refs minted per row, in a fixed section order. */
export function snapshotRows(state: EditState): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  state.employment?.employments.forEach((view, index) => {
    const role = view.roles[0];
    rows.push({
      ref: `e${index + 1}`,
      section: "employment",
      fields: {
        employer_name: view.employer_name,
        employer_city: view.employer_city,
        employer_state: view.employer_state,
        start_ym: view.start_ym,
        end_ym: view.end_ym,
        role_label: role?.role_label ?? null,
        work_done: role?.work_done ?? null,
      },
      target: { employment_id: view.employment_id },
    });
  });
  if (state.draft !== undefined) {
    skillLabelsOf(state.draft).forEach((label, index) => {
      rows.push({
        ref: `s${index + 1}`,
        section: "skills",
        fields: { skill: label },
        target: { skill_label: label },
      });
    });
  }
  state.languages?.languages.forEach((entry, index) => {
    rows.push({
      ref: `l${index + 1}`,
      section: "languages",
      fields: { language: entry.language },
      target: { language: entry.language },
    });
  });
  if (state.qualifications !== undefined) {
    pushQualificationRows(rows, "certificates", "c", state.qualifications.certificates);
    pushQualificationRows(rows, "educations", "q", state.qualifications.educations);
    pushQualificationRows(rows, "trainings", "t", state.qualifications.trainings);
  }
  state.occupations?.occupations.forEach((entry, index) => {
    rows.push({
      ref: `o${index + 1}`,
      section: "occupations",
      fields: { role_id: entry.role_id },
      target: { role_id: entry.role_id },
    });
  });
  if (state.preferences !== undefined) {
    const values = state.preferences.values;
    rows.push({
      ref: "pref",
      section: "preferences",
      fields: {
        shift: values.shift,
        job_type: values.job_type,
        willing_to_travel: boolText(values.willing_to_travel),
        willing_to_relocate: boolText(values.willing_to_relocate),
        accommodation_needed: boolText(values.accommodation_needed),
        expected_salary: values.salary_expected_max === null ? null : String(values.salary_expected_max),
        availability_status: values.availability?.status ?? null,
        availability_available_from: values.availability?.available_from ?? null,
        availability_notice_period_days:
          values.availability?.notice_period_days == null
            ? null
            : String(values.availability.notice_period_days),
      },
      target: null,
    });
    for (const [field, prefix] of [
      ["preferred_cities", "pc"],
      ["work_types", "wt"],
      ["documents_ready", "dr"],
    ] as const) {
      (values[field] ?? []).forEach((member, index) => {
        rows.push({
          ref: `${prefix}${index + 1}`,
          section: "preferences",
          fields: { [field]: member },
          target: { member },
        });
      });
    }
  }
  return rows;
}

function pushQualificationRows(
  rows: SnapshotRow[],
  list: QualificationList,
  prefix: string,
  entries: readonly Readonly<Record<string, unknown>>[],
): void {
  entries.forEach((entry, index) => {
    rows.push({
      ref: `${prefix}${index + 1}`,
      section: "qualifications",
      fields: qualificationFields(list, entry),
      target: { list, index, fp: qualificationFingerprint(list, entry) },
    });
  });
}

function boolText(value: boolean | null | undefined): string | null {
  return value === null || value === undefined ? null : value ? "true" : "false";
}

// ── trimming (BUG-SNAPSHOT-CAP) ─────────────────────────────────────────────────────────────

/** A value this short is too common to count as "the message names this row". */
const MENTION_MIN_LENGTH = 3;

/**
 * The snapshot cut to the edit-parse contract's row cap — DETERMINISTIC, so the same profile and
 * the same message always send the same rows.
 *
 * FAIR SHARE PER FAMILY. Rows are grouped by their ref family (`e`, `s`, `l`, `c`, `q`, `t`, `o`,
 * `pref`, `pc`, `wt`, `dr`) and the cap is water-filled across the families, smallest first: a
 * family that fits keeps every row, and the slots it leaves go to the larger ones. So a worker
 * with forty skills still sends every language and every certificate, and loses only skill rows.
 *
 * WITHIN A FAMILY, the rows the message NAMES go first (a current value that appears verbatim,
 * case-insensitively, in the worker's text), then the rest in stored order. That is a substring
 * test, not a guess: a row it keeps is one the worker typed. Every row keeps its own ref, and
 * the rows that go out do so in the snapshot's own order.
 */
export function trimSnapshot(
  rows: readonly SnapshotRow[],
  text: string,
  cap: number,
): SnapshotRow[] {
  if (rows.length <= cap) return [...rows];

  const families = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const family = row.ref.replace(/\d+$/, "");
    families.set(family, [...(families.get(family) ?? []), index]);
  });

  const haystack = text.toLowerCase();
  const mentioned = (row: SnapshotRow): boolean =>
    Object.values(row.fields).some(
      (value) =>
        value !== null && value.length >= MENTION_MIN_LENGTH && haystack.includes(value.toLowerCase()),
    );

  // Smallest family first; ties keep their snapshot order (Array.prototype.sort is stable).
  const bySize = [...families.values()].sort((a, b) => a.length - b.length);
  const keep = new Set<number>();
  let left = cap;
  bySize.forEach((members, position) => {
    const share = Math.floor(left / (bySize.length - position));
    const take = Math.min(members.length, share);
    const ordered = [
      ...members.filter((index) => mentioned(rows[index]!)),
      ...members.filter((index) => !mentioned(rows[index]!)),
    ];
    for (const index of ordered.slice(0, take)) keep.add(index);
    left -= take;
  });
  return rows.filter((_, index) => keep.has(index));
}

// ── the stale check (P1-CONF-STALE) ─────────────────────────────────────────────────────────

/**
 * Whether a fresh snapshot row IS the entry a card row was built against.
 *
 * Qualifications match by list and FINGERPRINT, never by index, so a reordered or shortened list
 * still finds the entry — and an entry edited elsewhere no longer does. A stored row without a
 * fingerprint predates the rule and matches nothing (fail closed: stale). Every other section's
 * target is already a stable identity (an employment id, a slug, a role id, a list member).
 */
function sameEntry(candidate: SnapshotRow, row: StoredEditProposalRow): boolean {
  if (candidate.section !== row.section) return false;
  if (row.section === "qualifications") {
    const fp = row.target?.["fp"];
    return (
      typeof fp === "string" &&
      candidate.target?.["list"] === row.target?.["list"] &&
      candidate.target?.["fp"] === fp
    );
  }
  return JSON.stringify(candidate.target) === JSON.stringify(row.target);
}

/**
 * A card whose captured values no longer match the profile cannot be applied. Adds are never
 * stale: an add names no current row, and one that became a duplicate meanwhile is a no-op at
 * apply time by construction.
 *
 * The field must be one the entry HAS (`rowCarriesField`): a row whose field the entry lacks
 * would otherwise read `undefined` as a matching `before: null` and pass. `propose` no longer
 * cards such a row (EDIT-ROW-KIND); one stored before that gate is stale here, never applied.
 */
export function isStale(
  fresh: readonly SnapshotRow[],
  rows: readonly StoredEditProposalRow[],
): boolean {
  return rows.some((row) => {
    if (row.op === "add") return false;
    const field = row.field ?? "";
    return !fresh.some(
      (candidate) =>
        sameEntry(candidate, row) &&
        rowCarriesField(candidate, field) &&
        (candidate.fields[field] ?? null) === row.before,
    );
  });
}
