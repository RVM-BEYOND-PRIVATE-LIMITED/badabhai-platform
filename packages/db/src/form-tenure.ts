/**
 * #2753 item 2 — A TRADE FORM'S EXPERIENCE BAND, READ FOR `worker_skill.months_bucketed`.
 *
 * THE GAP. Every trade form asks an experience band first (`turning_experience`,
 * `sheet_metal_experience`, … — the role descriptor's `tenureQuestionKey`). The worker's tap is
 * stored, and used only for the form's own gates. `deriveWorkerSkills` takes months from
 * `worker_profiles.experience.total_years`, and a form worker has no profile row by design, so
 * every skill he derives reads 0 months — "not recorded" to search.
 *
 * WHAT THIS MODULE DOES, behind `FORM_TENURE_MONTHS_ENABLED` (default off). For a batch of workers it
 * reads each one's SETTLED answer to each trade form's tenure question — ONE query for N workers —
 * and resolves the years it states:
 *   - a tapped band → its `value_number`, which the form stores as `answer_number`
 *     (fresher 0, under one year 0, 1–3 years 2, 3–5 years 4, 5–10 years 7, over 10 years 12);
 *   - a typed "Koi aur" answer → {@link typedTenureYears}, only when
 *     `FORM_TYPED_TENURE_DERIVE_ENABLED` is ALSO on (the form's own Q10 reading, one function);
 *   - a decline, an unanswered row, or anything else → nothing.
 * The years go to `workerSkillDeriveInput` (`@badabhai/match-engine`), which gives them to the
 * skills THAT form's answers derive, through the existing `bucketMonths` — as a FILL, never an
 * override: a skill whose profile tenure already buckets above 0 keeps exactly today's months.
 *
 * WHY IT LIVES HERE. Both writers of `worker_skill` call it — the live rebuild
 * (`WorkerSkillsRepository` in `apps/api`) and `db:backfill:worker-skills` — so the SQL, the
 * pack → question table and the band/typed rule exist once. A writer that read the band its own way
 * is the TD120 shape: the nightly repair writes one month count and the next live rebuild another.
 *
 * NOT A RÉSUMÉ FIGURE. Owner ruling 2026-09-09b still stands for the sheet: the band sized a form
 * and is never printed as a career length. This is a RANK INPUT only — the search order, the snapshot
 * of a new application, the `tier_floor_months` promotion. The 36-month line of #2750 falls between
 * two bands: 3–5 years gives 48 months and 1–3 years gives 24, so with a 36-month line only the first
 * counts as "3 or more years" (a worker with exactly 3 years may have picked either). No rule for
 * that line lives here.
 *
 * PRIVACY. Reads ids, a status, a number and — only with the typed switch on — the worker's own typed
 * words, which are parsed for one figure and never logged, stored or returned. Nothing here touches
 * a name or a phone.
 */
import { and, inArray } from "drizzle-orm";

import type { FormTenureFill } from "@badabhai/match-engine";

import type { Database } from "./client";
import { workerPackAnswers } from "./schema";
import { typedTenureYears, TENURE_YEARS_RANGE } from "./typed-tenure";

/**
 * Each trade form's tenure question, by the pack the form is built from.
 *
 * A MIRROR OF THE ROLE REGISTRY (`apps/api/src/profiling/roles/*.role.ts`, each descriptor's
 * `packId` → `tenureQuestionKey`), restated because this package cannot import `apps/api`.
 * `form-tenure-keys.parity.test.ts` there fails the moment a role is added, removed or re-keyed
 * without this table following. Every declared role is here, form-enabled or not: a structured
 * chat on a role pack stores the same answer under the same key.
 */
export const FORM_TENURE_QUESTION_KEYS: Readonly<Record<string, string>> = {
  qp_assembly_line: "assembly_experience",
  qp_blow_moulding: "extrusion_experience",
  qp_cad_design_3d: "design_experience",
  qp_cad_drafting: "drafting_experience",
  qp_cam_programming: "programming_experience",
  qp_cnc_grinding: "grinding_experience",
  qp_cnc_turning: "turning_experience",
  qp_conventional_machining: "machining_experience",
  qp_edm_wirecut: "edm_experience",
  qp_fitter: "fitting_experience",
  qp_foundry_forging: "foundry_experience",
  qp_heat_treatment: "heat_experience",
  qp_industrial_electrician: "electrical_experience",
  qp_injection_moulding: "moulding_experience",
  qp_maintenance_tech: "maintenance_experience",
  qp_mould_making: "mould_making_experience",
  qp_plastic_process: "process_experience",
  qp_plc_automation: "plc_experience",
  qp_powder_coating: "coating_experience",
  qp_press_operation: "press_experience",
  qp_production_supervisor: "supervision_experience",
  qp_quality_inspection: "inspection_experience",
  qp_rubber_moulding: "rubber_experience",
  qp_sheet_metal_fab: "sheet_metal_experience",
  qp_tool_die_making: "toolroom_experience",
  qp_vmc_milling: "milling_experience",
  qp_welding_trade: "welding_experience",
};

/** The two switches the reading obeys, as both writers resolve them. */
export interface FormTenureSwitches {
  /** `FORM_TENURE_MONTHS_ENABLED` — off: nothing is read and the derivation is byte-identical. */
  readonly months: boolean;
  /** `FORM_TYPED_TENURE_DERIVE_ENABLED` — a typed tenure counts only with BOTH on. */
  readonly typed: boolean;
}

/** One stored answer to a trade form's tenure question — the columns the rule reads, no more. */
export interface FormTenureAnswerRow {
  readonly workerId: string;
  readonly packId: string;
  readonly questionKey: string;
  readonly status: string;
  readonly answerNumber: number | null;
  readonly answerOtherText: string | null;
}

/**
 * Every stored answer these workers gave to a trade form's tenure question. ONE QUERY for the whole
 * batch, however many workers and forms — never a query per worker or per skill.
 *
 * `worker_id IN (...)` leads `wpa_worker_question_uq (worker_id, pack_id, question_key)`, so this is
 * an index scan, like `loadPackAnswers` beside the backfill. The (pack, question) PAIR is checked here rather than in SQL: the two
 * `IN` lists over-select only a row whose key belongs to a different form's pack, which the filter
 * drops, and the statement stays one shape for every batch.
 */
export async function loadFormTenureAnswers(
  db: Database,
  workerIds: readonly string[],
): Promise<FormTenureAnswerRow[]> {
  const ids = [...new Set(workerIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      workerId: workerPackAnswers.workerId,
      packId: workerPackAnswers.packId,
      questionKey: workerPackAnswers.questionKey,
      status: workerPackAnswers.status,
      answerNumber: workerPackAnswers.answerNumber,
      answerOtherText: workerPackAnswers.answerOtherText,
    })
    .from(workerPackAnswers)
    .where(
      and(
        inArray(workerPackAnswers.workerId, ids),
        inArray(workerPackAnswers.packId, Object.keys(FORM_TENURE_QUESTION_KEYS)),
        inArray(workerPackAnswers.questionKey, [
          ...new Set(Object.values(FORM_TENURE_QUESTION_KEYS)),
        ]),
      ),
    );
  return rows.filter((row) => FORM_TENURE_QUESTION_KEYS[row.packId] === row.questionKey);
}

/**
 * The years one stored tenure answer states, or null when it states none.
 *
 *   - ANSWERED WITH A NUMBER — a tapped band. The form stores the option's `value_number` in
 *     `answer_number` (form-eligibility.ts: the gate options carry `value_number` and nothing
 *     else). Held to the same 0–60 bound as every other years figure.
 *   - ANSWERED WITH TYPED WORDS — only with `typed` on, read by {@link typedTenureYears}, exactly as
 *     the form's own gate reads it. Ambiguous text (two figures, a negated one, none) gives null.
 *   - DECLINED, UNANSWERED, or any other shape — null. "Pata nahi" tells us nothing about years.
 */
export function formTenureYearsOf(
  row: Pick<FormTenureAnswerRow, "status" | "answerNumber" | "answerOtherText">,
  switches: Pick<FormTenureSwitches, "typed">,
): number | null {
  if (row.status !== "answered") return null;
  if (typeof row.answerNumber === "number") {
    return Number.isFinite(row.answerNumber) &&
      row.answerNumber >= TENURE_YEARS_RANGE.min &&
      row.answerNumber <= TENURE_YEARS_RANGE.max
      ? row.answerNumber
      : null;
  }
  if (!switches.typed || typeof row.answerOtherText !== "string") return null;
  const typed = row.answerOtherText.trim();
  return typed.length === 0 ? null : typedTenureYears(typed);
}

/**
 * The form-tenure fills for a batch of workers, keyed by worker: one {@link loadFormTenureAnswers}
 * query, then {@link formTenureYearsOf} per row. A worker with no answer that states years is
 * ABSENT from the map — the same as "no fill" to `workerSkillDeriveInput`.
 *
 * With `months` off this reads NOTHING and returns an empty map, so a caller that forgets to check
 * the switch still derives today's months.
 */
export async function loadFormTenureFills(
  db: Database,
  workerIds: readonly string[],
  switches: FormTenureSwitches,
): Promise<Map<string, FormTenureFill[]>> {
  const byWorker = new Map<string, FormTenureFill[]>();
  if (!switches.months) return byWorker;
  for (const row of await loadFormTenureAnswers(db, workerIds)) {
    const years = formTenureYearsOf(row, switches);
    if (years === null) continue;
    const fill: FormTenureFill = { packId: row.packId, years };
    const list = byWorker.get(row.workerId);
    if (list) list.push(fill);
    else byWorker.set(row.workerId, [fill]);
  }
  return byWorker;
}

export const FORM_TENURE_MONTHS_ENV = "FORM_TENURE_MONTHS_ENABLED";
export const FORM_TYPED_TENURE_ENV = "FORM_TYPED_TENURE_DERIVE_ENABLED";

/** The switches one backfill run uses, and which of them a DRY RUN assumed because they were unset. */
export interface FormTenureRunSwitches {
  readonly switches: FormTenureSwitches;
  /** Variable names read as `false` only because they were unset or empty. Always empty on --apply. */
  readonly assumed: readonly string[];
}

/**
 * The switches as `db:backfill:worker-skills` reads them: the SAME variable names the api reads.
 *
 * THE BATCH CANNOT SEE PRODUCTION'S VALUE. It runs from an operator's shell, not from the api's
 * container. Once production has `FORM_TENURE_MONTHS_ENABLED=true`, a run whose shell simply lacks
 * the variable would read it as off and write 0 months back over every form worker — silently, with
 * a green exit. So unset is not a value here:
 *   - `--apply` REFUSES unless `FORM_TENURE_MONTHS_ENABLED` is set explicitly (`true`/`false`, or
 *     `1`/`0`), and, when that is on, `FORM_TYPED_TENURE_DERIVE_ENABLED` too. Unset or empty throws
 *     one line naming the variable; nothing has been read or written yet.
 *   - A DRY RUN writes nothing, so it may proceed: an unset switch reads as `false` and is listed in
 *     `assumed`, which the runner prints.
 * A value outside `true`/`false`/`1`/`0` throws in either mode rather than guessing. The typed
 * switch is only demanded when the fill runs: with the months switch off it changes nothing.
 */
export function formTenureSwitchesForRun(
  env: Readonly<Record<string, string | undefined>>,
  mode: { readonly apply: boolean },
): FormTenureRunSwitches {
  const assumed: string[] = [];
  const read = (name: string): boolean => {
    const value = explicitBoolean(env, name);
    if (value !== undefined) return value;
    if (mode.apply) {
      throw new Error(
        `${name} is unset or empty: --apply needs it set to true or false, matching production ` +
          `(an unset run would write 0 months over every form worker once production has it on).`,
      );
    }
    assumed.push(name);
    return false;
  };
  const months = read(FORM_TENURE_MONTHS_ENV);
  const typed = months
    ? read(FORM_TYPED_TENURE_ENV)
    : (explicitBoolean(env, FORM_TYPED_TENURE_ENV) ?? false);
  return { switches: { months, typed }, assumed };
}

/** `true`/`1` → true, `false`/`0` → false, unset or empty → undefined; anything else throws. */
function explicitBoolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be exactly true, false, 1 or 0 (lowercase).`);
}
