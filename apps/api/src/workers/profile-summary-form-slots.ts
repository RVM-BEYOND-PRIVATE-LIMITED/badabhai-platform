import { packAnswerEvidence, packAnswerFromStoredRow } from "@badabhai/taxonomy";

import { AVAILABILITY_STATUSES } from "../profiles/worker-preferences.vocabulary";
import { descriptorForPack } from "../profiling/roles/role-registry";
import { tradeResumeMapFor } from "../resume/trade-resume-map";

/**
 * #2257 — WHICH PROFILE-STRENGTH SLOTS THE WORKER'S OWN FORM ANSWERS FILL.
 *
 * THE DEFECT. `GET /workers/me/profile-summary` scored its nine slots off the `worker_profiles`
 * row alone, and the form never writes that row: the trade form writes `worker_pack_answer` +
 * `worker_attributes`, and the preferences page (`PUT /workers/me/work-preferences`) writes
 * `worker_attributes`. A worker who completed both kept a low strength and a `missing_fields`
 * list naming things the résumé right above it already printed ("Exp: Fanuc & Siemens", with
 * `skills` and `machines` reported missing).
 *
 * A READ-SIDE FOLD, NOT A SECOND WRITER (owner decision on #2257). Nothing here writes
 * `worker_profiles`: its `skills` / `machines` columns are match-engine inputs, and projecting
 * form answers into them would change matching to fix a display number. The summary instead
 * reads the records the form already writes, and a slot counts when EITHER source has it.
 *
 * PRESENTATION ONLY. Strength and `missing_fields` drive the Profile tab's card and nothing
 * else — no rank input reads them — so widening what fills a slot moves no business decision.
 *
 * PURE — no I/O, no clock, no DI. Every rule reads closed-set values only (option slugs, numbers,
 * a closed availability status), never free text, so no worker sentence is ever inspected here.
 */

/**
 * The slots a form answer can fill. `role` / `trade` are not here — they mean "no canonical id",
 * which #2202 fills on form completion — and neither is `photo`, which only an upload clears.
 */
export const FORM_FILLABLE_SLOTS = [
  "skills",
  "machines",
  "experience",
  "salary",
  "location",
  "availability",
] as const;

export type FormFillableSlot = (typeof FORM_FILLABLE_SLOTS)[number];

/** The `worker_attributes` columns the fold reads — the shape `WorkersRepository` selects. */
export interface SummaryAttributeRow {
  readonly packId: string | null;
  readonly attributeKey: string;
  readonly valueNumber: string | null;
  readonly valueText: string | null;
  readonly valueTextList: readonly string[] | null;
  readonly valueJson: unknown;
}

/**
 * The machine / controller / equipment question of every role pack with a résumé map — the rows
 * the sheet prints as Machines, Controllers, Equipment or Tools.
 *
 * AN EXPLICIT, REVIEWED TABLE (owner decision on #2257), not a label match: the sheet's labels
 * vary by trade ("Equipment maintained", "Machines programmed for") and a label is copy, not a
 * contract. `profile-summary-form-slots.test.ts` holds every key to a real pack question and a
 * real résumé row, and holds the table exhaustive over `TRADE_RESUME_MAPS`.
 *
 * PACK-SCOPED, because `controller_brand` and friends recur across packs: a row counts only under
 * the pack it was answered in.
 */
export const PACK_MACHINE_KEYS: Readonly<Record<string, readonly string[]>> = {
  qp_cnc_turning: ["turning_machine", "controller_brand"],
  qp_vmc_milling: ["milling_machine", "controller_brand"],
  qp_cnc_grinding: ["grinding_machine", "controller_brand"],
  qp_cam_programming: ["machine_programmed", "controller_brand"],
  qp_conventional_machining: ["machining_machine"],
  qp_tool_die_making: ["toolroom_machine"],
  qp_welding_trade: ["welding_equipment"],
  qp_powder_coating: ["coating_equipment"],
  qp_sheet_metal_fab: ["sheet_metal_machine"],
  qp_industrial_electrician: ["electrical_equipment"],
  qp_press_operation: ["press_machine"],
  qp_assembly_line: ["assembly_tool"],
  qp_fitter: ["fitter_equipment"],
  qp_maintenance_tech: ["maintenance_equipment"],
};

/**
 * Role packs that ask no machine question. Their `machines` slot stays open on the form road,
 * exactly as before #2257 — whether it should be "not applicable" instead is a separate ruling.
 */
export const PACKS_WITHOUT_MACHINE_QUESTION: readonly string[] = [
  "qp_cad_drafting",
  "qp_quality_inspection",
];

/** The salary band's two ends as the preferences page stores them (`PREFERENCE_KEYS`). */
const SALARY_KEYS: readonly string[] = ["salary_expected_min", "salary_expected_max"];
const LOCATION_KEY = "preferred_locations";
const AVAILABILITY_KEY = "availability";

/** One row's selected slugs: a multi-select's list, or a single-select's bare value. */
function slugsOf(row: SummaryAttributeRow): string[] {
  if (Array.isArray(row.valueTextList)) {
    return row.valueTextList.filter((v) => typeof v === "string" && v.trim().length > 0);
  }
  return typeof row.valueText === "string" && row.valueText.trim().length > 0
    ? [row.valueText]
    : [];
}

/** `numeric` arrives as a string from pg; a band end counts only as a positive finite number. */
function isPositiveAmount(value: string | null): boolean {
  if (value === null) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * A machine row counts only for a slug its résumé row would PRINT. The dictionary is the
 * sheet's own drop rule: a none-of-above chip ("Pata nahi", stored as `unknown`) has no entry, so
 * it fills nothing here either — a non-answer is never scored as an answer.
 */
function fillsMachines(row: SummaryAttributeRow): boolean {
  if (row.packId === null) return false;
  if (!(PACK_MACHINE_KEYS[row.packId] ?? []).includes(row.attributeKey)) return false;
  const spec = tradeResumeMapFor(row.packId)?.capability.find((s) => s.from === row.attributeKey);
  const printable = spec?.values;
  if (printable === undefined) return false;
  return slugsOf(row).some((slug) => Object.hasOwn(printable, slug));
}

/**
 * The role's tier question (`turning_experience`, …) answered under its own pack. A band is an
 * experience answer even though it is not a number: this slot asks only WHETHER the worker told
 * us, and turning a band into years is a range ruling this read does not make.
 */
function fillsExperience(row: SummaryAttributeRow): boolean {
  const tenureKey = descriptorForPack(row.packId)?.tenureQuestionKey;
  return tenureKey !== undefined && row.attributeKey === tenureKey && slugsOf(row).length > 0;
}

/** The worker's own closed availability status — the slot the model's `status` fills. */
function fillsAvailability(row: SummaryAttributeRow): boolean {
  if (row.attributeKey !== AVAILABILITY_KEY) return false;
  const json = row.valueJson;
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
  const status = (json as Record<string, unknown>).status;
  return typeof status === "string" && Object.hasOwn(AVAILABILITY_STATUSES, status);
}

/**
 * The slots one worker's stored attribute rows fill.
 *
 * SKILLS ARE THE MATCHER'S OWN READING. `packAnswerEvidence` is the one table both the live
 * rebuild and the nightly repair turn pack answers into taxonomy ids with, so "the form filled
 * skills" means exactly "these answers give the worker a match skill" — never a parallel opinion.
 *
 * Salary, location and availability are read under any pack (or none): the preferences page
 * writes them with a null pack, and the trade form writes universal answers under its own.
 */
export function formFilledSlots(
  rows: readonly SummaryAttributeRow[],
): ReadonlySet<FormFillableSlot> {
  const filled = new Set<FormFillableSlot>();

  const evidence = packAnswerEvidence(
    rows.flatMap((row) => {
      const answer = packAnswerFromStoredRow(row);
      return answer === null ? [] : [answer];
    }),
  );
  if (
    evidence.corpusSkillIds.length > 0 ||
    evidence.roleIds.length > 0 ||
    evidence.matchSkillIds.length > 0
  ) {
    filled.add("skills");
  }

  for (const row of rows) {
    if (fillsMachines(row)) filled.add("machines");
    if (fillsExperience(row)) filled.add("experience");
    if (SALARY_KEYS.includes(row.attributeKey) && isPositiveAmount(row.valueNumber)) {
      filled.add("salary");
    }
    if (row.attributeKey === LOCATION_KEY && slugsOf(row).length > 0) filled.add("location");
    if (fillsAvailability(row)) filled.add("availability");
  }
  return filled;
}
