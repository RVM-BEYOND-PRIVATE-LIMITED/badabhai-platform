import { resumeProfileCarriesValues } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import type { CompanionV2EditSection } from "@badabhai/types";
import {
  projectEmploymentForPut,
  SetMyEmploymentSchema,
  type SetMyEmploymentDto,
} from "../../profiles/worker-employment.dto";
import { SetMyLanguagesSchema, type SetMyLanguagesDto } from "../../profiles/worker-languages.dto";
import {
  SetMyOccupationsSchema,
  type SetMyOccupationsDto,
} from "../../profiles/worker-occupations.dto";
import {
  SetMyPreferencesSchema,
  type SetMyPreferencesDto,
} from "../../profiles/worker-preferences.dto";
import {
  SetMyQualificationsSchema,
  type SetMyQualificationsDto,
} from "../../profiles/worker-qualifications.dto";
import type { StoredEditProposalRow } from "./edit-proposal.store";
import {
  qualificationFingerprint,
  qualificationListOfField,
  type EditState,
  type QualificationList,
  type SnapshotRow,
} from "./edit-snapshot";

/**
 * FROM CARD ROWS TO EACH SECTION WRITER'S OWN INPUT — pure, and the ONE place that knows how a
 * row changes a section (ADR-0046 O4/O5).
 *
 * THE SAME PLAN, TWICE. `propose` builds it against the state it snapshotted and drops any row
 * whose plan the writer's REAL schema refuses (P1-EDIT-DROP-DTO: a phone number in an issuer,
 * an end month before the start, a fifth occupation) — so a card never shows a row that can only
 * fail on Haan. `confirm` builds it again against the fresh state it just stale-checked and hands
 * the parsed DTO to the writer on the transaction. A plan that cannot be built THROWS; the caller
 * decides whether that is a dropped row or a rolled-back confirm.
 *
 * Skills have no DTO of their own: the résumé-only writer re-validates the merged draft through
 * `DraftProfileSchema` itself, whose label bound (120) is wider than the catalogue's (80).
 */

/** The résumé-only skills writer's input (`ProfilesRepository.setResumeSkillLabels`). */
export type ResumeSkillLists =
  | { readonly resumeProfileSkills: readonly string[] }
  | { readonly skills: readonly string[]; readonly skillLabels: readonly string[] };

export type SectionPlan =
  | { readonly section: "employment"; readonly dto: SetMyEmploymentDto }
  | { readonly section: "skills"; readonly next: ResumeSkillLists }
  | { readonly section: "languages"; readonly dto: SetMyLanguagesDto }
  | { readonly section: "qualifications"; readonly dto: SetMyQualificationsDto }
  | { readonly section: "occupations"; readonly dto: SetMyOccupationsDto }
  | { readonly section: "preferences"; readonly dto: SetMyPreferencesDto };

/** One section's rows applied to its current state, parsed by its writer's schema. Throws. */
export function planSection(
  section: CompanionV2EditSection,
  state: EditState,
  rows: readonly StoredEditProposalRow[],
): SectionPlan {
  switch (section) {
    case "employment":
      return { section, dto: planEmployment(required(state.employment), rows) };
    case "skills":
      return { section, next: planSkills(required(state.draft), rows) };
    case "languages":
      return { section, dto: planLanguages(required(state.languages), rows) };
    case "qualifications":
      return { section, dto: planQualifications(required(state.qualifications), rows) };
    case "occupations":
      return { section, dto: planOccupations(required(state.occupations), rows) };
    case "preferences":
      return { section, dto: planPreferences(required(state.preferences), rows) };
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("section unreadable");
  return value;
}

function planEmployment(
  current: NonNullable<EditState["employment"]>,
  rows: readonly StoredEditProposalRow[],
): SetMyEmploymentDto {
  let views = current.employments.map((view) => ({
    ...view,
    roles: view.roles.map((role) => ({ ...role })),
  }));
  for (const row of rows) {
    const id = row.target?.["employment_id"];
    if (typeof id !== "string") throw new Error("employment row without a target");
    const at = views.findIndex((view) => view.employment_id === id);
    if (at === -1) throw new Error("employment row vanished under the card");
    if (row.op === "delete") {
      views = views.filter((_, index) => index !== at);
      continue;
    }
    const view = views[at]!;
    const role = view.roles[0];
    const field = row.field ?? "";
    if (field === "employer_name") view.employer_name = row.value!;
    else if (field === "employer_city") view.employer_city = row.value;
    else if (field === "employer_state") view.employer_state = row.value;
    else if (field === "start_ym") view.start_ym = row.value;
    else if (field === "end_ym") view.end_ym = row.value;
    else if (field === "role_label" && role !== undefined) role.role_label = row.value!;
    else if (field === "work_done" && role !== undefined) role.work_done = row.value;
    else throw new Error(`unmapped employment field ${field}`);
  }
  return SetMyEmploymentSchema.parse({
    employments: views.map(projectEmploymentForPut),
    expected_existing_count: current.employments.length + current.unreadable_count,
  });
}

/**
 * Deletes by label, then the adds that are not ALREADY there — compared case-insensitively
 * against every label the résumé prints, so a skill can never be printed twice (P1-EDIT-NOOP),
 * even when a second Haan reads a profile the first one already changed.
 */
function planSkills(
  draft: NonNullable<EditState["draft"]>,
  rows: readonly StoredEditProposalRow[],
): ResumeSkillLists {
  const adds = rows.filter((row) => row.op === "add").map((row) => row.value!);
  const deletes = new Set(
    rows.filter((row) => row.op === "delete").map((row) => String(row.target?.["skill_label"] ?? "")),
  );

  // The same branch `skillLabelsOf` takes, so the write lands in the list the card was read from.
  const container = draft.resume_profile;
  if (resumeProfileCarriesValues(container) && container !== null) {
    const kept = container.skills.filter((label) => !deletes.has(label));
    return { resumeProfileSkills: [...kept, ...newLabels(kept, adds)] };
  }
  // A label is carded as `skillLabelsOf` prints it, so a delete matches that form too.
  const keptLabels = draft.skill_labels.filter(
    (label) => !deletes.has(label) && !deletes.has(labelForTaxonomyId(label)),
  );
  const keptIds = draft.skills.filter((id) => !deletes.has(labelForTaxonomyId(id)));
  const printed = [...keptIds.map(labelForTaxonomyId), ...keptLabels.map(labelForTaxonomyId)];
  return { skills: keptIds, skillLabels: [...keptLabels, ...newLabels(printed, adds)] };
}

/** The adds not already present (case-insensitive), each once. */
function newLabels(existing: readonly string[], adds: readonly string[]): string[] {
  const seen = new Set(existing.map((label) => label.toLowerCase()));
  const out: string[] = [];
  for (const label of adds) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function planLanguages(
  current: NonNullable<EditState["languages"]>,
  rows: readonly StoredEditProposalRow[],
): SetMyLanguagesDto {
  let entries = current.languages.map((entry) => ({ ...entry }));
  for (const row of rows) {
    if (row.op === "delete") {
      const language = String(row.target?.["language"] ?? "");
      entries = entries.filter((entry) => entry.language !== language);
    } else if (row.op === "add") {
      if (entries.some((entry) => entry.language === row.value)) continue;
      // A newly added language needs at least one ability (the writer's own rule): speaking is
      // the only honest default — the worker said they know it, not that they read or write it.
      entries.push({ language: row.value!, can_speak: true, can_read: false, can_write: false });
    }
  }
  return SetMyLanguagesSchema.parse({
    languages: entries.map((entry) => ({
      language: entry.language,
      can_speak: entry.can_speak,
      can_read: entry.can_read,
      can_write: entry.can_write,
    })),
  });
}

/**
 * Qualification rows resolved to their ENTRIES before anything moves (contracts-privacy BUG-2),
 * and only the lists the card touched are re-sent (BUG-PARTIAL-LISTS).
 *
 * BY IDENTITY, NEVER BY POSITION. Each row's target is resolved to the entry object whose
 * fingerprint matches — the one at the recorded index when it still matches there, else the first
 * unclaimed match — so "delete A + fix B's year" edits B however the deletes shift the list, a
 * double delete of one entry removes one entry, and an edit to an entry also being deleted is moot.
 *
 * ONLY THE TOUCHED LISTS. The PUT treats an absent list as "stored rows survive", and a list the
 * GET withheld a row from (`partial`) must not be re-sent unless the worker edits it — so a chat
 * edit to one certificate never re-saves, and never erases, the educations or trainings.
 */
function planQualifications(
  current: NonNullable<EditState["qualifications"]>,
  rows: readonly StoredEditProposalRow[],
): SetMyQualificationsDto {
  const lists: Record<QualificationList, Record<string, unknown>[]> = {
    certificates: current.certificates.map((entry) => ({ ...entry })),
    educations: current.educations.map((entry) => ({ ...entry })),
    trainings: current.trainings.map((entry) => ({ ...entry })),
  };
  const entryOf = resolveQualificationEntries(lists, rows);

  const touched = new Set<QualificationList>();
  const deleted = new Set<Record<string, unknown>>();
  for (const row of rows) {
    touched.add(qualificationListOf(row));
    if (row.op === "delete") deleted.add(entryOf.get(row.row_id)!);
  }
  for (const row of rows) {
    if (row.op !== "edit") continue;
    const entry = entryOf.get(row.row_id)!;
    if (deleted.has(entry)) continue;
    const field = row.field ?? "";
    entry[field.replace(/^(certificate|education|training)_/, "")] = field.endsWith("_year")
      ? Number(row.value)
      : row.value;
  }

  const body: Partial<Record<QualificationList, Record<string, unknown>[]>> = {};
  for (const list of touched) body[list] = lists[list].filter((entry) => !deleted.has(entry));
  return SetMyQualificationsSchema.parse(body);
}

/**
 * The list a row applies to — its target's — and only when its field names that same list
 * (EDIT-ROW-KIND). `propose` never cards such a row; this refuses one stored before that gate, so
 * an education can never be removed under a row that says "certificate".
 */
function qualificationListOf(row: StoredEditProposalRow): QualificationList {
  const list = row.target?.["list"];
  if (list !== "certificates" && list !== "educations" && list !== "trainings") {
    throw new Error("qualification row without a list");
  }
  if (qualificationListOfField(row.field ?? "") !== list) {
    throw new Error("qualification row's field names another list");
  }
  return list;
}

/** row_id → the entry object it names, resolved on the untouched lists (see planQualifications). */
function resolveQualificationEntries(
  lists: Readonly<Record<QualificationList, Record<string, unknown>[]>>,
  rows: readonly StoredEditProposalRow[],
): Map<string, Record<string, unknown>> {
  const targets = new Map<string, { list: QualificationList; index: number; fp: string }>();
  for (const row of rows) {
    const fp = row.target?.["fp"];
    const index = row.target?.["index"];
    if (typeof fp !== "string" || typeof index !== "number") {
      throw new Error("qualification row without an identity");
    }
    targets.set(JSON.stringify(row.target), { list: qualificationListOf(row), index, fp });
  }

  const taken = new Map<QualificationList, Set<number>>();
  const byTarget = new Map<string, Record<string, unknown>>();
  // Lowest recorded index first, so two identical entries resolve to themselves in order.
  for (const [key, target] of [...targets].sort(([, a], [, b]) => a.index - b.index)) {
    const list = lists[target.list];
    const used = taken.get(target.list) ?? new Set<number>();
    const matches = list
      .map((_, index) => index)
      .filter((index) => !used.has(index) && qualificationFingerprint(target.list, list[index]!) === target.fp);
    const pick = matches.includes(target.index) ? target.index : matches[0];
    if (pick === undefined) throw new Error("qualification row vanished under the card");
    used.add(pick);
    taken.set(target.list, used);
    byTarget.set(key, list[pick]!);
  }

  const entryOf = new Map<string, Record<string, unknown>>();
  for (const row of rows) entryOf.set(row.row_id, byTarget.get(JSON.stringify(row.target))!);
  return entryOf;
}

function planOccupations(
  current: NonNullable<EditState["occupations"]>,
  rows: readonly StoredEditProposalRow[],
): SetMyOccupationsDto {
  let ids = current.occupations.map((entry) => entry.role_id as string);
  for (const row of rows) {
    if (row.op === "delete") {
      ids = ids.filter((id) => id !== String(row.target?.["role_id"] ?? ""));
    } else if (row.op === "add" && !ids.includes(row.value!)) {
      ids.push(row.value!);
    }
  }
  return SetMyOccupationsSchema.parse({ occupations: ids.map((role_id) => ({ role_id })) });
}

/**
 * The touched preference keys only, with `touched_only: true` (BUG-PREFS-TOUCHED-ONLY).
 *
 * WHY THE FLAG. Without it the writer takes a `false` or a `[]` for an old build's untouched
 * default wherever a value is stored (#1504) and silently keeps the old answer — so "travel nahi
 * kar sakta" or removing the last city would be reported done and change nothing. The companion
 * sends exactly the keys the card touched, which is what the flag means.
 *
 * List rows FOLD: each starts from the list the previous row on the same field produced, so two
 * rows on one list (add Pune, add Mumbai) both land (contracts-privacy BUG-1).
 */
function planPreferences(
  current: NonNullable<EditState["preferences"]>,
  rows: readonly StoredEditProposalRow[],
): SetMyPreferencesDto {
  const values = current.values;
  const touched: Record<string, unknown> = { touched_only: true };
  const availability = { ...(values.availability ?? {}) };

  for (const row of rows) {
    const field = row.field ?? "";
    if (field === "expected_salary") {
      touched.salary_expected_max = Number(row.value);
      touched.salary_expected_min = null;
    } else if (field === "willing_to_travel" || field === "willing_to_relocate" || field === "accommodation_needed") {
      touched[field] = row.value === "true";
    } else if (field === "availability_status") {
      availability.status = row.value as never;
      touched.availability = availability;
    } else if (field === "availability_available_from") {
      availability.available_from = row.value;
      touched.availability = availability;
    } else if (field === "availability_notice_period_days") {
      availability.notice_period_days = Number(row.value);
      touched.availability = availability;
    } else if (field === "preferred_cities" || field === "work_types" || field === "documents_ready") {
      const sofar = (touched[field] as string[] | undefined) ?? values[field] ?? [];
      touched[field] = applyToList(sofar, row);
    } else {
      touched[field] = row.value;
    }
  }
  return SetMyPreferencesSchema.parse(touched);
}

function applyToList(list: readonly string[], row: StoredEditProposalRow): string[] {
  if (row.op === "delete") {
    const member = String(row.target?.["member"] ?? "");
    return list.filter((value) => value !== member);
  }
  return list.includes(row.value!) ? [...list] : [...list, row.value!];
}

// ── row-set rules (propose) ──────────────────────────────────────────────────────────────────

/** A row's entry: section, resolved target and — for preferences, whose members share a shape — the field. */
function entryKey(row: StoredEditProposalRow): string {
  return `${row.section}|${JSON.stringify(row.target)}|${row.section === "preferences" ? row.field : ""}`;
}

/**
 * One card row per change, in the model's order (P1-EDIT-NOOP, contracts-privacy BUG-2):
 *   - a second delete of the same entry is dropped (a delete names its ROW; the field is only its
 *     anchor, so `delete c1/name` and `delete c1/year` are one delete);
 *   - an edit of an entry the same card deletes is dropped — the delete says it all;
 *   - a second edit of the same field of the same entry is dropped (the first wins);
 *   - a second add of the same value (case-insensitive) is dropped.
 */
export function dedupeRows(rows: readonly StoredEditProposalRow[]): StoredEditProposalRow[] {
  const deleted = new Set(rows.filter((row) => row.op === "delete").map(entryKey));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.op === "edit" && deleted.has(entryKey(row))) return false;
    const key =
      row.op === "add"
        ? `add|${row.section}|${row.field}|${(row.value ?? "").toLowerCase()}`
        : `${row.op}|${entryKey(row)}|${row.op === "edit" ? row.field : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * An add of something the worker already has (P1-EDIT-NOOP): "Hindi add karo" when Hindi is
 * stored would show a card, write nothing and still spend a regeneration. Compared against the
 * FULL snapshot (not the trimmed one the model saw), case-insensitively — a skill label is free
 * text, and the other members are slugs or canonical cities already.
 */
export function isNoopAdd(row: StoredEditProposalRow, snapshot: readonly SnapshotRow[]): boolean {
  if (row.op !== "add" || row.value === null) return false;
  const field = row.field ?? "";
  const value = row.value.toLowerCase();
  return snapshot.some(
    (current) =>
      current.section === row.section &&
      current.target !== null &&
      (current.fields[field] ?? null)?.toLowerCase() === value,
  );
}
