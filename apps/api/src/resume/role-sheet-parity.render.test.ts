import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";
import {
  COMPRESSING_LADDER,
  SHEET_LINE_BUDGET,
  sheetContentLines,
  type DegradableSheet,
} from "./resume-degradation";
import { CAPABILITY_ROW_BUDGET, tradeResumeMapFor, type TradeRowSpec } from "./trade-resume-map";
import { ResumeRenderer } from "./resume-renderer.service";
import type { ResumeFactRow, ResumeListRow, ResumeRenderInput } from "./resume-renderer.service";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE SIX SHIPPED ROLES, RENDERED — the ratified reference sheets as the expectation.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS. `trade-form.service.test.ts` proves an answer is STORED and
 * `trade-resume-map.test.ts` proves a dictionary entry EXISTS. Neither walks a role from a
 * fully-answered form to a rendered sheet, so four of the five Batch 1 roles had never been
 * driven end to end by anything, and the one failure mode this programme has already shipped
 * TWICE — a `values` table keyed by `option_key` where the pipeline stores `value_text` —
 * renders NOTHING, with no error, on exactly that path.
 *
 * BATCH 2 IS WHY THERE IS A SIXTH CASE. `qp_welding_trade` shipped with a nine-row Section B
 * read off page 15 of the corpus and NOTHING drove it — not this file, which hand-authored the
 * five Batch 1 personas, and not the pack or map unit tests, which never meet. The welder below
 * is the first Batch 2 role here, and it earned its place on its first run: it found a row the
 * shipped map cannot print in full, which no test that stops at "the dictionary entry exists"
 * can see. See `qp_welding_trade`'s `Equipment` entry in {@link ReferenceSheet.captureGaps} and
 * item 5 of the unresolved list below.
 *
 * WHAT IS REAL HERE, and it is the whole point:
 *   · the REAL pack JSON in `packages/db/data/question-packs/packs` — every option key below is
 *     resolved through it, so a pack that renames an option fails this file rather than silently
 *     rendering an empty row;
 *   · the STORED VALUE, not the option key. `storedValue` reproduces
 *     `pack-registry.service.ts::toOption` (`value_text ?? value_number ?? value_bool`) followed
 *     by `answer-capture.ts`'s label fallback. Handing the renderer option KEYS would make this
 *     file pass while production printed a blank section — the exact grinding defect;
 *   · the shipped mapper (`buildResumeRenderInput`, degradation ladder inside it) and the
 *     shipped `bb_trade.v1` template through `ResumeRenderer.buildResumeHtml`.
 *
 * WHAT IS NOT REAL. No Nest container, no Postgres, no queue: the attribute bag is handed in
 * directly, exactly as `resume-render.processor.ts` hands it in after loading it.
 *
 * ── THE EXPECTATION IS THE RATIFIED PAGE, NEVER THE CODE ───────────────────────────────
 *
 * `REFERENCE_SECTION_B` below is transcribed from `BadaBhai_21_Role_Resumes.pdf` (pdftotext
 * -layout -enc UTF-8), row for row and in the page's own order. Where a rendered row disagrees
 * with it, THE TEST IS LEFT RED and the diff quotes both strings. Relaxing an assertion here
 * would delete the only evidence that the shipped sheet is not the ratified one.
 *
 * A ROW WHOSE RENDERING HAS BEEN RULED ON is the one exception, and it is not a relaxation: see
 * {@link ReferenceSheet.divergences}, where the page string, the agreed rendering and the REASON
 * are asserted together. A row with no ruling stays red.
 *
 * ── WHAT IS STILL UNRESOLVED, AND WHY — READ THIS BEFORE "FIXING" ANYTHING BELOW ───────
 *
 * Ten rows and one headline cannot be reproduced. Each is a question nobody has answered, not an
 * oversight, and each would be answered WRONGLY by adjusting the expectation to match what the
 * renderer prints.
 *
 * THEY ARE RECORDED RATHER THAN LEFT RED, and the distinction matters because the alternative was
 * tried first. An earlier draft of this file simply failed on every one. A suite that is expected to
 * be red is one every reader learns to skip — it cannot be a merge gate, and the next real
 * regression lands inside the noise. So each is recorded as data: ten as {@link
 * ReferenceSheet.captureGaps} entries naming the pack option that is missing (nine of them) or
 * the map rule that drops the value (the tenth, welding's `Equipment`), one as {@link
 * RoleCase.headlineConflict}. NOTHING WAS RELAXED TO GET THERE. `REFERENCE[...].rows` still holds
 * the ratified page's own string as the only authority, the green value assertion still compares
 * every OTHER row exactly against it, and an `it.fails` tripwire re-runs the full untouched
 * comparison so that closing a gap turns the suite RED until its record is deleted.
 *
 * 1. grinding — "Wheels dressed". The page prints "Aluminium oxide and CBN · single-point diamond
 *    dressing": wheel type AND dressing method in ONE cell. The map carries `dressing_method` as
 *    its own rank-64 "Dressing" row, and no ratified page prints such a row. Merging them needs a
 *    trailing-clause seam a fact row does not have, and "single-point diamond dressing" is prose
 *    built from a label plus a word the pack never says. OWNER QUESTION, written out in full on
 *    the `dressing_method` entry in `trade-resume-map.ts`.
 *
 * 2. vmc — the HEADLINE. TWO RATIFIED REFERENCES DISAGREE, which is the one thing this file has
 *    no way to adjudicate. The R9 sample (`Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator…pdf`, quoted
 *    in `docs/profiling/yadav-parity-gap.md`) ends "… · Fanuc, Siemens, Mitsubishi · 3 & 4-axis";
 *    the 21-role page ends "… · Fanuc, Siemens, Mitsubishi" with no axis segment. The renderer
 *    prints the axis segment, `yadav-parity.contract.test.ts` pins it as a shipped rule (R16 §1),
 *    and `trade-resume-map.ts` cites the older sample by name as the reason the flag exists.
 *    Deleting the segment would break a rule someone signed; keeping it fails this page. ASK.
 *
 * 3. vmc — two VALUES the pack cannot produce. The page prints "HMC · pallet changer" (a SECOND
 *    chip carrying a SECOND configuration, where `appendConfiguration` qualifies the first chip
 *    only — a documented design decision, not an oversight) and "Tombstone loading" in Setting
 *    (`qp_vmc_milling.setting_operation` offers `tool_change`, not a tombstone). Both are CAPTURE
 *    GAPS: no answer in the pack produces the string, so this is a pack question and a seam
 *    question, not a dictionary one.
 *
 * 4. turner — six VALUES, mostly the same capture gap. The page prints a twin-spindle lathe and a
 *    bar-fed lathe (`turning_machine` offers neither), "Jaw boring", "Bar feeder setup" and "Live
 *    tooling setup" in Setting (`setting_operation` offers none of the three; bar feeder and live
 *    tooling are `advanced_capability`, a different row), a snap gauge and a thread ring gauge
 *    (`TURNING_MEASURING_TOOLS` deliberately excludes the snap gauge as a MILLER's instrument —
 *    and the ratified turner page prints one, which contradicts that reasoning and is worth a
 *    ruling), "Writes and edits programs" where the ladder's top rung is "Writes programs", and
 *    EN8 and EN31 as two chips where the pack has one `alloy_steel` option. Its "Sector worked"
 *    also renders "Automotive components, General engineering / job shop": this map alone sets
 *    `join: ", "`, so the file already carries two separators for sector rows — which the CAM
 *    divergence's recorded reason does not account for. All of it needs the pack and the
 *    dictionaries ruled on together, and none of it is a renderer bug this file may invent a fix
 *    for.
 *
 * 5. welder — TWO MAP DEFECTS, FOUND BY DRIVING THIS PERSONA AND SINCE FIXED. Both are recorded
 *    here rather than forgotten, because "the welder reproduces its page" means something
 *    different depending on which of the two ways it came to be true.
 *      · `Equipment` carried `maxValues: 3` against a page that prints FOUR and a pack that
 *        stores all four, so "Oxy-acetylene cutting set" was dropped before the sheet was
 *        composed — a gas cutter reading as a man with no torch. The painter's map in the same
 *        file had already settled the identical tension the other way ("the cap follows the page,
 *        not the row's position"); the welder's row now agrees with it.
 *      · `Positions` printed the pack's shop-floor label "1G flat" where the page prints
 *        "1G — flat". The map dictionary is exactly the seam where a worker's chip becomes the
 *        sheet's English, so the page's dash now lives in the value.
 *    NEITHER WAS RELAXED INTO A RECORD. The expectation still carries the page's own strings.
 *
 * ── WHAT THIS FILE DOES NOT MEASURE: ZONE 5 ───────────────────────────────────────────
 *
 * SECTION B ONLY. `REFERENCE[...].rows` and every assertion built on it read `capChipRows`,
 * `capTickRows` and `capFactRows` — the capability block. Zone 5 (Education, Certificates,
 * Languages spoken, Documents ready) is NOT compared against the ratified page here, and the
 * gap is worth naming because it is exactly the zone the 2026-09-03 ruling exists to protect.
 *
 * IT IS A PIPELINE BOUNDARY, NOT AN OVERSIGHT. This file drives a role from a fully-answered
 * FORM, and Zone 5 is not built from form answers: `Certificates` is fed by `facts.certifications`
 * (`resume-sheet-rows.ts`), a DB credential source these fixtures deliberately do not supply, so
 * all six personas render Zone 5 as [Education, Languages spoken, Documents ready] while pages
 * 1-5 and page 15 of the corpus each print a Certificates row too. Handing the personas invented
 * certificate strings would make the row appear without exercising one line of the path that
 * produces it. The welder's page carries TWO of them ("Welder Qualification Test — 3G, MS plate"
 * and a site safety induction), which is the strongest case in the corpus for that row and still
 * not a reason to fake it here.
 *
 * TWO ZONE 5 VALUES ON PAGE 15 HAVE NO SLUG AT ALL, and they are recorded here rather than in
 * `captureGaps` because that record is keyed by a Section B row and these are neither. The page
 * lists "Arabic" among the languages and "ESIC" among the documents; `LANGUAGES` and
 * `DOCUMENTS_READY` in `worker-preferences.vocabulary.ts` carry neither, so a Gulf-returned
 * welder — which is what page 15 describes, and a large share of this trade — silently loses both.
 * The persona below therefore answers only slugs that exist, and the loss is named here.
 *
 * WHERE ZONE 5 IS ACTUALLY ASSERTED, so this is a stated boundary rather than a hole:
 *   · `yadav-parity.emit.test.ts` — the turner keeps "Languages spoken" and an NCVT Education
 *     row on the maximal persona; that is the ruling's own acceptance test;
 *   · `resume-degradation.test.ts` — no permitted ladder step may remove any Zone 5 row, on a
 *     sheet built far past every budget;
 *   · `sheet-shape-matrix.test.ts` — Zone 5 survives on all fourteen shapes, both audiences;
 *   · `resume-sheet-rows.test.ts` / `resume-preference-facts.test.ts` — how each row is composed.
 *
 * ── WHAT WAS RED AND IS NOW GREEN, AND WHY IT TOOK AN OWNER RULING ────────────────────
 *
 * This file was held back from its own PR because three further grinding assertions were red for
 * a reason it could not resolve on its own. `CAPABILITY_ROW_BUDGET` was 9, measured from three
 * sheets; the ratified grinding page prints TEN capability rows, so "Sector worked" was shed
 * before the ladder ever ran and the ROW, VALUE and divergence assertions all failed on it.
 * Raising the budget to the re-measured 10 admitted the row — and immediately pushed the sheet to
 * 41.19 lines against a `SHEET_LINE_BUDGET` of 41, whereupon the degradation ladder's third step
 * deleted the very same row again. The budget could not be raised and the ladder could not be
 * left alone, which is what the 2026-09-03 ruling settled: the ladder compresses as hard as it
 * can and then SPILLS rather than shedding a ratified row. All three are green on the row a human
 * signed off, not on a relaxed expectation.
 */

/** Where the seeded packs live, relative to this file. Same hop the persona harness makes. */
const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

interface PackOption {
  readonly option_key: string;
  readonly label_text: string;
  readonly value_text?: string;
  readonly value_number?: number;
  readonly value_bool?: boolean;
  readonly is_none_of_above?: boolean;
}

/** The only `ask_if` shape these six packs use — asserted rather than assumed by `isVisible`. */
interface PackGate {
  readonly op: string;
  readonly left: { readonly field: string };
  readonly right: { readonly const: number };
}

interface PackItem {
  readonly question_key: string;
  readonly answer_type: "single_select" | "multi_select" | "boolean" | "number" | "text";
  readonly options?: readonly PackOption[];
  readonly ask_if?: PackGate | null;
}

interface Pack {
  readonly pack_id: string;
  readonly items: readonly PackItem[];
}

function loadPack(packId: string): Pack {
  return JSON.parse(readFileSync(join(PACK_DIR, `${packId}.json`), "utf8")) as Pack;
}

function itemOf(pack: Pack, questionKey: string): PackItem {
  const item = pack.items.find((candidate) => candidate.question_key === questionKey);
  // THROW RATHER THAN SKIP. A question this pack no longer asks is a persona that no longer
  // describes a real worker, and silently dropping it would turn a pack rename into a green run.
  if (!item) throw new Error(`${pack.pack_id} has no question ${questionKey}`);
  return item;
}

/**
 * What the pipeline actually STORES for one tapped chip.
 *
 * `pack-registry.service.ts::toOption` resolves `value_text ?? value_number ?? value_bool`, and
 * `answer-capture.ts` falls back to the chip's own label when all three are null. Reproduced
 * here rather than short-circuited to `option_key`, because the difference between those two is
 * the defect this file exists to catch: `trade-resume-map`'s `values` tables are keyed by the
 * STORED VALUE, and a mismatch renders nothing at all with no error.
 */
function storedValue(
  pack: Pack,
  questionKey: string,
  optionKey: string,
): string | number | boolean {
  const item = itemOf(pack, questionKey);
  const option = (item.options ?? []).find((candidate) => candidate.option_key === optionKey);
  if (!option) throw new Error(`${pack.pack_id}/${questionKey} has no option ${optionKey}`);
  return option.value_text ?? option.value_number ?? option.value_bool ?? option.label_text;
}

/** Is this question on screen for a worker who answered the tier question with `tier`? */
function isVisible(item: PackItem, tierField: string, tier: number): boolean {
  const gate = item.ask_if;
  if (!gate) return true;
  // ASSERTED, NOT ASSUMED. Every gate in these six packs is a numeric comparison against the
  // tier question; a pack that grows a different shape must fail here rather than be evaluated
  // wrongly and quietly change which questions this file thinks a worker was asked.
  if (gate.left.field !== tierField) {
    throw new Error(`${item.question_key} gates on ${gate.left.field}, not ${tierField}`);
  }
  if (gate.op === "gte") return tier >= gate.right.const;
  if (gate.op === "lte") return tier <= gate.right.const;
  throw new Error(`${item.question_key} uses unsupported gate op ${gate.op}`);
}

/** Option keys, resolved to the values `worker_attributes` would hold after the form is filled. */
function attributesFrom(
  pack: Pack,
  answers: Readonly<Record<string, string | readonly string[]>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [questionKey, answer] of Object.entries(answers)) {
    const item = itemOf(pack, questionKey);
    if (item.answer_type === "text") {
      if (typeof answer !== "string") throw new Error(`${questionKey} takes free text`);
      out[questionKey] = answer;
      continue;
    }
    out[questionKey] = Array.isArray(answer)
      ? answer.map((key) => storedValue(pack, questionKey, key))
      : storedValue(pack, questionKey, answer as string);
  }
  return out;
}

/**
 * Every visible question answered as widely as it can be — the widest sheet a worker can produce.
 *
 * Multi-selects take every option that is not `is_none_of_above` ("Pata nahi" is a non-answer and
 * a résumé must never print one); single-selects take the LAST non-none option, which on every
 * ladder in these packs is the strongest claim and therefore the one whose label must survive.
 */
function maximalAnswers(
  pack: Pack,
  tierField: string,
  tier: number,
  tierOptionKey: string,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = { [tierField]: tierOptionKey };
  for (const item of pack.items) {
    if (item.question_key === tierField) continue;
    if (!isVisible(item, tierField, tier)) continue;
    const usable = (item.options ?? []).filter((option) => option.is_none_of_above !== true);
    if (item.answer_type === "multi_select") {
      answers[item.question_key] = usable.map((option) => option.option_key);
    } else if (item.answer_type === "single_select") {
      const last = usable[usable.length - 1];
      if (last) answers[item.question_key] = last.option_key;
    }
    // `text` and `number` questions contribute no capability row and are left out deliberately:
    // this helper exists to maximise the CAPABILITY section, not to invent worker prose.
  }
  return answers;
}

// ── THE RENDER ────────────────────────────────────────────────────────────────────────

const renderer = new ResumeRenderer(null as never);

/** One ratified page, as the mapper's non-pack inputs. Everything else comes from the pack. */
interface Persona {
  readonly id: string;
  readonly packId: string;
  readonly displayName: string;
  /** The model's job title. No pack question produces it — it rides `draft.role_label`. */
  readonly roleLabel: string;
  readonly city: string;
  /** `experience.total_years`, the mandatory universal ask. */
  readonly totalYears: number | null;
  readonly availability: { status: string; notice_period_days: number | null };
  readonly salaryMin: number;
  readonly salaryMax: number;
  /** The universal/finishing-form answers, already in their stored slugs. */
  readonly formAttributes: Readonly<Record<string, unknown>>;
  readonly educationLevel: string | null;
  readonly educationField: string | null;
}

function snapshotFor(persona: Persona): Record<string, unknown> {
  return {
    // NO `resume_profile`. A form-first worker never runs extraction (`trade-form.service.ts`
    // switches it off on handover), so the LEGACY branch of the mapper is the one their sheet
    // actually takes — and it is the branch four of the five Batch 1 roles reach in production.
    role_label: persona.roleLabel,
    education_level: persona.educationLevel,
    education_field: persona.educationField,
    experience: { total_years: persona.totalYears },
    salary_expectation: { amount_min: persona.salaryMin, amount_max: persona.salaryMax },
    location_preference: { current_city: persona.city, preferred_cities: [] },
    availability: persona.availability,
  };
}

function renderSheet(
  persona: Persona,
  packAttributes: Record<string, unknown>,
  employments: readonly WorkerEmploymentRecord[] = [],
): { input: ResumeRenderInput; html: string } {
  const tradeSheet: TradeSheetContext = {
    packId: persona.packId,
    attributes: { ...persona.formAttributes, ...packAttributes },
    employments,
    // A FIXED CLOCK, so an open-ended employment's months tail is the same on every run.
    asOf: new Date("2026-08-27T00:00:00Z"),
  };
  const input = buildResumeRenderInput(
    snapshotFor(persona),
    persona.displayName,
    "bb_trade",
    null,
    false,
    "worker",
    tradeSheet,
  );
  return { input, html: renderer.buildResumeHtml(input) };
}

/**
 * Section B as the PAGE reads it: label + printed value, in render order.
 *
 * `bb_trade.v1.html` emits all chip rows, then all tick rows, then all fact rows, so this is the
 * order the reader sees — NOT the map's declared array order. Reading it back this way is what
 * makes a re-ordered row visible instead of being hidden by a set comparison.
 */
function sectionB(input: ResumeRenderInput): [string, string][] {
  const list = (rows: readonly ResumeListRow[] | undefined): [string, string][] =>
    (rows ?? []).map((row) => [row.label, row.values.join(" · ")]);
  const facts = (rows: readonly ResumeFactRow[] | undefined): [string, string][] =>
    (rows ?? []).map((row) => [row.label, row.value]);
  return [...list(input.capChipRows), ...list(input.capTickRows), ...facts(input.capFactRows)];
}

/** Every capability row's label, whatever bucket it rendered into. */
function sectionBLabels(input: ResumeRenderInput): string[] {
  return sectionB(input).map(([label]) => label);
}

/**
 * Would this row print anything at all for these answers?
 *
 * The same question `buildTradeCapabilityRows` asks AFTER it has already spent a budget slot on
 * the row — see the assertion that uses this. Asked here from the map's own dictionary, so a
 * value the map deliberately leaves unlabelled is counted as unprintable rather than as a bug.
 */
function hasPrintableValue(spec: TradeRowSpec, attributes: Record<string, unknown>): boolean {
  const raw = attributes[spec.from];
  const chosen = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return chosen.some((value) => (spec.values ?? {})[String(value)] !== undefined);
}

// ── THE RATIFIED PAGES ────────────────────────────────────────────────────────────────

/**
 * One ratified reference sheet's Section B, transcribed verbatim.
 *
 * `unaskable` names the rows the page prints that NO pack question can produce, so the parity
 * assertion measures the map rather than re-reporting a known capture gap on every run. A row is
 * listed there only when no item in the pack targets it at all.
 */
interface ReferenceSheet {
  /** [label, printed value] in the page's own top-to-bottom order. */
  readonly rows: readonly (readonly [string, string])[];
  readonly unaskable: readonly string[];
  /** The Verdict Line's first line, verbatim (§6.2). */
  readonly headline: string;
  /**
   * Rows the sheet DELIBERATELY does not reproduce verbatim, keyed by the page's own label.
   *
   * ═══ WHY A RULING NEEDS A SLOT AND NOT A RELAXED ASSERTION ═══
   *
   * Four of these were already decided, with their reasons, in `trade-resume-map.test.ts`. This
   * file re-measured the same rows against the page and reported them as failures, so one
   * decision was green in one file and red in another — and a red test that is expected to be red
   * teaches the next reader to skip the file. Loosening the assertion instead would have deleted
   * the page string, which is the only evidence anyone has of what was decided against.
   *
   * So the page string STAYS in {@link rows} — the authority is untouched — and the divergence
   * carries the rendering that was chosen and the reason it was chosen. The value assertion
   * compares against the agreed rendering; `records every divergence` below asserts all three
   * facts together, so a renderer that quietly starts matching the page fails just as loudly as
   * one that drifts further from it.
   *
   * ═══ WHAT MAY BE ENTERED HERE, AND WHAT MAY NOT ═══
   *
   * A row belongs here only when the RENDERER IS RIGHT and the page is unreproducible under §8 —
   * the page's cell is hand-set prose, or reproducing it would need a compound label that
   * over-claims. A row whose rendering is merely UNDECIDED does NOT belong here: it stays red.
   * Grinding's "Wheels dressed" is the live example — see `dressing_method` in
   * `trade-resume-map.ts`, where the open question is written out.
   *
   * ═══ THE ONE CAUSE BEHIND MOST OF THEM ═══
   *
   * THE RATIFIED PAGES' SECTOR CELLS ARE DESIGN COPY, NOT RENDERABLE LABELS. Across the
   * twenty-one pages they read "Passenger vehicle assembly", "Manufacturing plant electrical",
   * "Enclosures, panels and general fabrication", "Plastics tooling for auto and consumer goods",
   * "Automotive tier-1 supply" — not one of which is an option in any pack. No closed-vocabulary
   * dictionary can produce them, and §8 permits a printed string to be a closed-vocabulary label,
   * a number the worker stated, or the worker's own words, with no fourth source. Three of the
   * entries below are that one fact, and so is the turner's still-failing sector row.
   */
  readonly divergences?: Readonly<Record<string, RecordedDivergence>>;
  /**
   * Rows the sheet CANNOT yet reproduce because the PACK cannot produce the answer, keyed by the
   * page's own label.
   *
   * ═══ NOT A DIVERGENCE, AND THE DIFFERENCE IS THE WHOLE REASON FOR A SECOND FIELD ═══
   *
   * A {@link RecordedDivergence} is CLOSED: somebody ruled that the renderer is right and the
   * page is unreproducible under §8. A capture gap is OPEN. No option in the shipped pack stores
   * the value the page prints, so nothing here has been decided, nothing is agreed, and nobody
   * should read this list as acceptance. It is the pack backlog, written where the measurement
   * that found it lives.
   *
   * ═══ WHY THEY ARE RECORDED AT ALL, WHEN THE FILE'S RULE IS "AN UNDECIDED ROW STAYS RED" ═══
   *
   * Because that rule, taken literally, ships a suite that is red forever — and a test file that
   * is expected to be red is one every reader learns to skip, which costs more than the six rows
   * it was protecting. The gaps are therefore recorded, and asserted TWICE, in opposite
   * directions:
   *
   *   · the green VALUE assertion skips them, so it still guards every other row exactly against
   *     the page — a regression in `Controllers` or `Tolerance held` fails immediately;
   *   · `it.fails` re-runs the FULL comparison including them, so the moment a pack gains the
   *     option that closes a gap, that test goes RED and whoever closed it is told to delete the
   *     entry here.
   *
   * Neither assertion was loosened to reach green and no expectation was moved: {@link rows}
   * still carries the page's own string, and `rendered` below records what the pipeline actually
   * produces today so the gap's SIZE is on the record rather than in a reviewer's memory.
   *
   * NONE OF THESE IS A RENDERER BUG, and none may be "fixed" here. Closing one means adding an
   * option to a pack in `packages/db/data/question-packs/packs` or ruling on a seam — pack and
   * dictionary work, owned elsewhere and listed in this file's header.
   *
   * ═══ A MAP DEFECT IS NOT A CAPTURE GAP — FIX IT, DO NOT FILE IT ═══
   *
   * This record is for a page row the PACK cannot store. `qp_welding_trade`'s `Equipment` row was
   * briefly filed here and should not have been: the pack stored all four values the page prints,
   * and it was the MAP's own `maxValues: 3` that dropped the fourth. Nothing about that is a
   * capture gap — no answer was missing, and the fix was two characters in a file this repo owns.
   *
   * The distinction is worth keeping sharp, because filing a fixable defect as a recorded gap is
   * how a defect acquires tenure: the row goes green, the record reads like a decision somebody
   * made, and the next author inherits it as context rather than as a bug. If a row cannot be
   * reproduced because of something in `trade-resume-map.ts`, change the map.
   */
  readonly captureGaps?: Readonly<Record<string, RecordedCaptureGap>>;
}

interface RecordedDivergence {
  /** Verbatim from the ratified page — the same string {@link ReferenceSheet.rows} carries. */
  readonly page: string;
  /** What the shipped renderer prints instead, and is agreed to print. */
  readonly rendered: string;
  /** WHY the renderer is right and the page is unreproducible. Cite the rule. */
  readonly why: string;
}

interface RecordedCaptureGap {
  /** Verbatim from the ratified page — the same string {@link ReferenceSheet.rows} carries. */
  readonly page: string;
  /** What the pipeline produces today. NOT an agreed rendering — see {@link ReferenceSheet.captureGaps}. */
  readonly rendered: string;
  /**
   * WHICH answer the pack cannot store. Name the attribute and the missing option.
   *
   * This field names the thing to change; a sentence that only regrets the difference is an
   * excuse, and the assertion below rejects one too short to be anything else. If what it would
   * name is a rule in `trade-resume-map.ts` rather than a missing pack option, this is the wrong
   * record — see {@link ReferenceSheet.captureGaps}.
   */
  readonly missing: string;
}

const REFERENCE: Readonly<Record<string, ReferenceSheet>> = {
  // Vinod Sharma — "CNC Turner — Setter-cum-Programmer · 9 yrs 6 mo · Fanuc, Siemens, Haas".
  qp_cnc_turning: {
    headline: "CNC Turner — Setter-cum-Programmer · 9 yrs 6 mo · Fanuc, Siemens, Haas",
    rows: [
      ["Machines", "CNC turning centre · Twin-spindle lathe · Bar-fed lathe · Conventional lathe"],
      ["Controllers", "Fanuc · Siemens · Haas"],
      ["Materials", "EN8 · EN31 · MS · Brass"],
      [
        "Setting",
        "Tool offset · Work offset · Tool nose radius comp · Jaw boring · Tailstock setting · Bar feeder setup · Live tooling setup",
      ],
      [
        "Measuring instruments",
        "Vernier · Micrometer · Bore dial gauge · Snap gauge · Thread ring gauge · Height gauge",
      ],
      ["Programming", "Writes and edits programs (G-code / M-code)"],
      ["Drawings", "Reads 2D drawings and GD&T"],
      ["Turning capacity", "Up to 250 mm dia, 500 mm between centres"],
      ["Tolerance held", "±0.02 mm"],
      ["Sector worked", "Automotive components · job shop"],
    ],
    // `qp_cnc_turning` asks no swing/between-centres question.
    unaskable: ["Turning capacity"],
    captureGaps: {
      Machines: {
        page: "CNC turning centre · Twin-spindle lathe · Bar-fed lathe · Conventional lathe",
        rendered: "CNC lathe / turning centre · Conventional lathe",
        missing:
          "`turning_machine` offers neither a twin-spindle nor a bar-fed lathe. Both are real " +
          "turner machines and a shop advertising for either scans this row first.",
      },
      Materials: {
        page: "EN8 · EN31 · MS · Brass",
        rendered: "MS · EN8 / EN31 · Brass",
        missing:
          "`material_worked` carries ONE `alloy_steel` option labelled 'EN8 / EN31'. The page " +
          "prints them as two chips, so the pack would need them split — a pack question, since " +
          "splitting a shipped option key rewrites stored answers.",
      },
      Setting: {
        page:
          "Tool offset · Work offset · Tool nose radius comp · Jaw boring · Tailstock setting · " +
          "Bar feeder setup · Live tooling setup",
        rendered:
          "Tool offset · Work offset · Tool nose radius compensation · Chuck / jaw change · " +
          "Tailstock setting",
        missing:
          "`setting_operation` offers no jaw boring, no bar feeder setup and no live tooling " +
          "setup. The last two exist as `advanced_capability` — a DIFFERENT row — so printing " +
          "them here would move an answer between rows rather than reproduce the page. The " +
          "page also abbreviates 'compensation' to 'comp', which a dictionary label does not.",
      },
      "Measuring instruments": {
        page: "Vernier · Micrometer · Bore dial gauge · Snap gauge · Thread ring gauge · Height gauge",
        rendered: "Vernier · Micrometer · Bore dial gauge · Height gauge",
        missing:
          "`TURNING_MEASURING_TOOLS` deliberately excludes the snap gauge as a MILLER's " +
          "instrument, and offers no thread ring gauge. The ratified TURNER page prints a snap " +
          "gauge, which contradicts that reasoning outright and is worth a ruling on its own.",
      },
      Programming: {
        page: "Writes and edits programs (G-code / M-code)",
        rendered: "Writes programs (G-code / M-code)",
        missing:
          "`programming_ability`'s top rung is 'Writes programs'. The page's 'writes AND edits' " +
          "is a wider claim than any single option makes, and composing it from two rungs would " +
          "state a capability the worker was never asked about (§8).",
      },
      "Sector worked": {
        page: "Automotive components · job shop",
        rendered: "Automotive components, General engineering / job shop",
        missing:
          "`sector_worked` has no 'job shop' option; the nearest is 'General engineering / job " +
          'shop\'. This map ALSO sets `join: ", "` where every other map uses the middot, so ' +
          "the file already carries two separators for sector rows — which the CAM and grinding " +
          "sector divergences do not account for, and which must be ruled before either can be " +
          "extended to cover this row.",
      },
    },
  },

  // Ramesh Kumar Yadav — "CNC Machining Centre Operator — Setter · 8 yrs · Fanuc, Siemens, Mitsubishi".
  qp_vmc_milling: {
    headline: "CNC Machining Centre Operator — Setter · 8 yrs · Fanuc, Siemens, Mitsubishi",
    rows: [
      ["Machines", "VMC · 3-axis · VMC · 4-axis · HMC · pallet changer · SPM"],
      ["Controllers", "Fanuc · Siemens · Mitsubishi"],
      ["Materials", "EN8 · EN31 · MS · Aluminium"],
      [
        "Setting",
        "Tool offset · Work offset · Tool length compensation · Fixture setting · First-piece setup · Tombstone loading",
      ],
      [
        "Measuring instruments",
        "Vernier · Micrometer · Bore dial gauge · Height gauge · Snap gauge",
      ],
      ["Programming", "Edits programs (G-code / M-code)"],
      ["Drawings", "Reads 2D drawings and GD&T"],
      ["Table & travel", "800 x 500 mm table · 3 & 4-axis"],
      ["Tolerance held", "±0.02 mm"],
      ["Sector worked", "Automotive components"],
    ],
    // `qp_vmc_milling` asks no table-size question.
    unaskable: ["Table & travel"],
    captureGaps: {
      Machines: {
        page: "VMC · 3-axis · VMC · 4-axis · HMC · pallet changer · SPM",
        rendered: "VMC · 3-axis · VMC · 4-axis · HMC · SPM",
        missing:
          "A SEAM GAP RATHER THAN A MISSING OPTION, and the only one in this record. The page " +
          "carries a SECOND configuration on a SECOND chip ('HMC · pallet changer'), while " +
          "`appendConfiguration` qualifies the FIRST chip only — a documented design decision " +
          "(R10 §2.5 rule 3), taken because one config per chip is what stops two machines and " +
          "two configurations printing four chips the worker never claimed.",
      },
      Setting: {
        page:
          "Tool offset · Work offset · Tool length compensation · Fixture setting · " +
          "First-piece setup · Tombstone loading",
        rendered:
          "Tool offset · Work offset · Tool length compensation · Fixture setting · " +
          "First-piece setup",
        missing:
          "`qp_vmc_milling.setting_operation` offers `tool_change`, not a tombstone. Tombstone " +
          "loading is horizontal-machining work and the pack has no option for it.",
      },
    },
  },

  // Sanjay Kamble — "CNC Grinding Operator — Setter · 8 yrs · CNC cylindrical grinder, …".
  qp_cnc_grinding: {
    headline:
      "CNC Grinding Operator — Setter · 8 yrs · CNC cylindrical grinder, Surface grinder, Centreless grinder",
    rows: [
      [
        "Machines",
        "CNC cylindrical grinder · Surface grinder · Centreless grinder · Internal grinder",
      ],
      ["Controllers", "Fanuc · Siemens"],
      ["Materials", "EN31 · Case-hardened steel · HCHCr · Cast iron"],
      [
        "Setting",
        "Wheel mounting & balancing · Diamond dressing · Work-head alignment · Steady rest setting · Coolant setting · Magnetic chuck setup",
      ],
      [
        "Measuring instruments",
        "Micrometer · Bore dial gauge · Slip gauges · Dial gauge · Surface roughness tester",
      ],
      ["Wheels dressed", "Aluminium oxide and CBN · single-point diamond dressing"],
      ["Drawings", "Reads 2D drawings and GD&T"],
      ["Tolerance held", "±0.005 mm"],
      ["Surface finish held", "Ra 0.4 µm"],
      ["Sector worked", "Bearings and transmission components"],
    ],
    unaskable: [],
    divergences: {
      "Sector worked": {
        page: "Bearings and transmission components",
        rendered: "Bearings · Transmission components",
        why:
          "The page's sector cell is hand-set prose. A fact row joins closed-vocabulary labels " +
          "with this file's one separator, and the CAM sheet's sector row is already ruled the " +
          "same way — an 'and' join would give the file three separators for one kind of " +
          "row and still not match, because the page also lower-cases the second label (§8).",
      },
    },
    // "Wheels dressed" IS DELIBERATELY NOT A `divergence`. Nothing about it has been ruled, so
    // it is recorded as the OPEN gap it is and the full-comparison `it.fails` below keeps it red.
    captureGaps: {
      "Wheels dressed": {
        page: "Aluminium oxide and CBN · single-point diamond dressing",
        rendered: "Aluminium oxide · CBN",
        missing:
          "The page puts wheel type AND dressing method in ONE cell, while the map carries " +
          "`dressing_method` as its own rank-64 'Dressing' row that no ratified page shows. " +
          "Merging them needs a trailing-clause seam a fact row does not have, and " +
          "'single-point diamond dressing' is prose built from the label plus a word the pack " +
          "never says (§8). OWNER QUESTION, written out in full on the `dressing_method` entry " +
          "in `trade-resume-map.ts`.",
      },
    },
  },

  // Nitin Deshmukh — "CAM Programmer — Programmer · 7 yrs · Mastercam, PowerMill, SolidCAM".
  qp_cam_programming: {
    headline: "CAM Programmer — Programmer · 7 yrs · Mastercam, PowerMill, SolidCAM",
    rows: [
      ["CAM software", "Mastercam · PowerMill · SolidCAM · EdgeCAM"],
      ["Machines programmed for", "VMC · 3-axis · VMC · 4-axis · 5-axis trunnion · Turn-mill"],
      ["Controllers posted to", "Fanuc · Heidenhain · Siemens"],
      [
        "Programming work",
        "2D & 3D toolpath · Multi-axis toolpath · Tool library management · Cycle-time optimisation · Machining strategy selection · Shop-floor tryout support",
      ],
      [
        "CAD model handling",
        "STEP / IGES import · Parasolid import · Model repair · Fixture modelling",
      ],
      ["Post-processors", "Edits and tests post-processors · Fanuc and Heidenhain"],
      ["Simulation", "Vericut and in-CAM collision check before release"],
      ["Drawings", "Reads 2D drawings and GD&T"],
      ["Sector worked", "Auto components and tool room"],
    ],
    unaskable: [],
    divergences: {
      "Post-processors": {
        page: "Edits and tests post-processors · Fanuc and Heidenhain",
        rendered: "Edits and tests post-processors",
        why:
          "The controller half of that sentence is the Controllers row's own answer and is not " +
          "re-composed here. `post_processor_work` asks what he does to a post; " +
          "`controller_brand` asks which control is ON THE MACHINE. Joining the two would print " +
          "which controller he has POSTED FOR — a pairing no question asked and nobody stated, " +
          "which is the fabrication §8 forbids.",
      },
      "Sector worked": {
        page: "Auto components and tool room",
        rendered: "Auto components · Tool room",
        why:
          "The page's sector cell is hand-set prose. A fact row joins closed-vocabulary labels " +
          "with this file's one separator, and the two other maps that print a multi-value " +
          "sector row use the same one; matching the page would also mean lower-casing a " +
          "label (§8).",
      },
    },
  },

  // Pooja Chaudhary — the FRESHER page. No work-history section at all, and "Sector STUDIED".
  qp_cad_drafting: {
    headline:
      "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD, SolidWorks, Fusion 360",
    rows: [
      ["Software", "AutoCAD · SolidWorks · Fusion 360"],
      ["Modules", "2D drafting · 3D modelling · Assembly · Sheet-metal module"],
      [
        "Drawing work",
        "Part modelling · Assembly mating · Drawing views & sections · Sheet-metal flat pattern · Dimensioning · Revision control",
      ],
      [
        "Standards & detailing",
        "GD&T symbols · ISO drawing standard · Title block & BOM · Tolerance stack basics",
      ],
      ["Drawing type", "Prepares 2D production drawings from 3D models"],
      ["Output produced", "Part and assembly drawings · BOM · DXF for laser cutting"],
      ["Sector studied", "General engineering · course projects"],
    ],
    unaskable: [],
    divergences: {
      "Output produced": {
        page: "Part and assembly drawings · BOM · DXF for laser cutting",
        rendered: "Part drawings · Assembly drawings · BOM · DXF for laser cutting",
        why:
          "The page folds two chips into one English phrase. `output_produced` is a multi_select " +
          "whose `part_drawing` and `assembly_drawing` options are independent, so a compound " +
          "label 'Part and assembly drawings' would print a claim the worker never made every " +
          "time she taps only one of them (§8). A fact row joins whole dictionary labels; no " +
          "separator reproduces a fold.",
      },
      "Sector studied": {
        page: "General engineering · course projects",
        rendered: "General engineering · Course projects",
        why:
          "Capitalisation only, and the page's lower-case 'c' is real — verified in the raw " +
          "extraction, not an artefact. The ratified pages sentence-case the CONTINUATION of a " +
          "cell the designer wrote as prose; cells built from labels keep their capitals " +
          "('Shift General shift · Permanent'). A dictionary entry is a LABEL and is capitalised " +
          "because it is one, and down-casing a joined label by position would corrupt the first " +
          "proper noun a sector dictionary acquires.",
      },
    },
  },

  // Page 15, the first BATCH 2 role in this file — "Welder — Certified Welder · 11 yrs · MIG /
  // MAG (GMAW), Arc / rod (SMAW), TIG (GTAW)". Nine rows, which is what `qp_welding_trade`'s
  // `_sheet` note says it was authored from, and they arrive in the page's own order without the
  // map having to declare them in it: `bb_trade.v1.html` emits chips, then ticks, then facts, and
  // page 15 prints four chip rows, two tick rows and three fact rows in exactly that sequence.
  qp_welding_trade: {
    headline: "Welder — Certified Welder · 11 yrs · MIG / MAG (GMAW), Arc / rod (SMAW), TIG (GTAW)",
    rows: [
      ["Processes", "MIG / MAG (GMAW) · Arc / rod (SMAW) · TIG (GTAW) · Gas cutting"],
      // "CO2", NOT "CO". `pdftotext -layout` drops the subscript 2 the page sets, so the naive
      // transcription reads "CO / MIG machine" — a gas that is not the one in the bottle.
      ["Equipment", "Inverter arc set · CO2 / MIG machine · TIG set · Oxy-acetylene cutting set"],
      ["Electrodes / wire", "E6013 · E7018 · ER70S-6"],
      ["Materials", "MS · Stainless steel · Aluminium"],
      ["Positions", "1G — flat · 2G — horizontal · 3G — vertical"],
      ["Inspection", "Visual inspection · Fillet / weld gauge · Dye-penetrant (DPT) witness"],
      ["Plate thickness", "3 mm - 25 mm plate"],
      ["Drawings", "Reads 2D drawings and weld symbols"],
      ["Sector worked", "Structural fabrication — general engineering"],
    ],
    // NOTHING IS UNASKABLE ON THIS PAGE. Only the two oldest packs carry an `unaskable` row at
    // all — the turner's swing/between-centres and the miller's table size, neither of which any
    // question anywhere in their packs targets. `qp_welding_trade` was authored FROM this page,
    // row by row (its `_sheet` note says so), and the nine labels below are the nine `from`s in
    // its map: that is what writing the pack after the reference is supposed to buy.
    unaskable: [],
    divergences: {
      "Sector worked": {
        page: "Structural fabrication — general engineering",
        rendered: "Structural fabrication · General engineering",
        why:
          "THE SAME RULING THE GRINDING AND CAM SHEETS ALREADY CARRY, and this map's own " +
          "`sector_worked` comment predicts this row verbatim before anyone ran it. The ratified " +
          "sector cells are hand-set prose: a fact row joins closed-vocabulary labels with this " +
          "file's one separator, and matching the page would need both a second separator and a " +
          "down-cased label ('general engineering'), neither of which §8 permits a dictionary to " +
          "produce. Three pages now diverge here for one cause, which is an argument about the " +
          "sector CELL and not about this trade.",
      },
    },
    // NO CAPTURE GAPS, AND THE TWO THIS PAGE FOUND WERE BOTH FIXED RATHER THAN RECORDED.
    //
    // Driving this persona for the first time surfaced two real defects in the shipped map, and
    // neither belonged in a `captureGaps` record — that field is for a page row the PACK cannot
    // store, and both of these were the map's own doing:
    //
    //   · `Equipment` carried `maxValues: 3` against a page that prints FOUR and a pack that
    //     stores all four, so "Oxy-acetylene cutting set" was dropped before the sheet was
    //     composed and a gas cutter read as a man with no torch. Now 4, matching the painter's
    //     row, which had already settled the identical tension the other way.
    //   · `Positions` printed the pack's shop-floor label "1G flat" where the page prints
    //     "1G — flat". The dictionary is exactly the seam where the worker's chip becomes the
    //     sheet's English, so the page's dash now lives in the value.
    //
    // Recorded here rather than deleted silently: a reviewer reading this file later should see
    // that the row list below is reproduced because the map was CORRECTED, not because the
    // expectation was relaxed to meet it.
  },
};

// ── THE SIX PERSONAS, ANSWERED AGAINST THE REAL PACKS ──────────────────────────────────

/**
 * The option keys behind each ratified page, chosen to reproduce it as closely as the shipped
 * pack allows — never wider. A wider answer set would push a role over
 * `CAPABILITY_ROW_BUDGET` and shed a row for a reason that has nothing to do with the map's
 * dictionaries, which is the measurement this parity test is for. The budget itself is measured
 * separately, on `maximalAnswers`, below.
 */
interface RoleCase {
  readonly persona: Persona;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  /** The tier question and the numeric value its chosen option stores. */
  readonly tier: Tier;
  /**
   * The tier to use when measuring the BUDGET, when it differs from the persona's.
   *
   * `qp_cad_drafting` is the only role that needs one: its ratified page is a FRESHER's, and a
   * fresher's `lte 1` branch reaches seven capability rows against a budget of ten — so the
   * persona's own tier can never exercise shedding at all. The senior branch defines eleven.
   */
  readonly budgetTier?: Tier;
  /**
   * Set ONLY where two ratified references disagree about this role's Verdict Line.
   *
   * NOT A DIVERGENCE AND NOT A CAPTURE GAP. Both of those are disagreements between the renderer
   * and ONE page. This is a disagreement between TWO signed-off pages, which no reasoning inside
   * this file can settle: whichever it asserted, it would be asserting against a document a human
   * approved. So it asserts both — the page's string stays in `REFERENCE[...].headline`, the
   * other reference's string sits here, and the test pins that the two still differ.
   */
  readonly headlineConflict?: {
    /** What the shipped renderer prints, matching the OTHER ratified reference. */
    readonly rendered: string;
    /** Which two references disagree, and which rule pins the shipped behaviour. */
    readonly why: string;
  };
  readonly employments: readonly WorkerEmploymentRecord[];
}

interface Tier {
  readonly field: string;
  readonly value: number;
  readonly option: string;
}

const FORM_NCR = {
  languages: ["hindi", "haryanvi", "english"],
  documents_ready: ["aadhaar", "pan", "bank_account", "uan_pf", "experience_letter"],
  preferred_locations: ["Faridabad", "Gurugram", "Manesar"],
  shift_preference: "rotational",
  job_type: "permanent",
  relocation_willingness: true,
} as const;

const FORM_PUNE = {
  languages: ["marathi", "hindi", "english"],
  documents_ready: ["aadhaar", "pan", "bank_account", "uan_pf", "experience_letter"],
  preferred_locations: ["Pune", "Pimpri-Chinchwad", "Chakan"],
  shift_preference: "rotational",
  job_type: "permanent",
} as const;

const CASES: readonly RoleCase[] = [
  {
    persona: {
      id: "turner",
      packId: "qp_cnc_turning",
      displayName: "Vinod Sharma",
      roleLabel: "CNC Turner — Setter-cum-Programmer",
      city: "Faridabad",
      totalYears: 9.5,
      availability: { status: "notice_period", notice_period_days: 30 },
      salaryMin: 30000,
      salaryMax: 36000,
      formAttributes: {
        ...FORM_NCR,
        education_credential: "iti",
        education_council: "ncvt",
        education_year: 2016,
        education_institute: "Govt. ITI, Faridabad",
      },
      educationLevel: "iti_diploma",
      educationField: "Turner",
    },
    tier: { field: "turning_experience", value: 10, option: "over_seven" },
    answers: {
      turning_experience: "over_seven",
      turning_machine: ["cnc_lathe", "conventional_lathe"],
      controller_brand: ["fanuc", "siemens", "haas"],
      material_worked: ["alloy_steel", "mild_steel", "brass"],
      setting_operation: [
        "tool_offset",
        "work_offset",
        "nose_radius",
        "jaw_change",
        "tailstock_set",
      ],
      measuring_tools: ["vernier", "micrometer", "bore_gauge", "height_gauge"],
      drawing_reading: "gdt",
      programming_level: "write_program",
      tolerance_band: "point_zero_two",
      sector_worked: ["automotive", "general_engg"],
    },
    employments: [
      {
        employer: "Bharat Precision Turning Pvt Ltd",
        employerCity: "Faridabad",
        employerState: "Haryana",
        startYm: "2021-04",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "CNC Turner — Setter-cum-Programmer",
            startYm: "2021-04",
            endYm: null,
            workDone: "Fanuc twin-spindle, bar feeder, EN8 aur EN31, first-piece approval",
          },
        ],
      },
    ],
  },
  {
    persona: {
      id: "vmc",
      packId: "qp_vmc_milling",
      displayName: "Ramesh Kumar Yadav",
      roleLabel: "CNC Machining Centre Operator — Setter",
      city: "Faridabad",
      totalYears: 8,
      availability: { status: "notice_period", notice_period_days: 15 },
      salaryMin: 24000,
      salaryMax: 28000,
      formAttributes: {
        ...FORM_NCR,
        education_credential: "iti",
        education_council: "ncvt",
        education_year: 2018,
        education_institute: "Govt. ITI, Faridabad",
      },
      educationLevel: "iti_diploma",
      educationField: "Machinist",
    },
    tier: { field: "milling_experience", value: 10, option: "over_seven" },
    headlineConflict: {
      rendered:
        "CNC Machining Centre Operator — Setter · 8 yrs · Fanuc, Siemens, Mitsubishi · 3 & 4-axis",
      why:
        "TWO RATIFIED REFERENCES DISAGREE about the axis segment. The R9 sample " +
        "(`Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator….pdf`, quoted in " +
        "`docs/profiling/yadav-parity-gap.md`) ends '… · Fanuc, Siemens, Mitsubishi · 3 & 4-axis'; " +
        "page 3 of `BadaBhai_21_Role_Resumes.pdf` ends '… · Fanuc, Siemens, Mitsubishi' with no " +
        "axis segment. The renderer follows the R9 sample: `configInHeadline` was built for this " +
        "exact row, `yadav-parity.contract.test.ts` pins the segment as a shipped rule (R16 §1), " +
        "and `trade-resume-map.ts` cites that sample BY NAME as the reason the flag exists. " +
        "Deleting the segment breaks a rule someone signed; keeping it fails page 3. ASK.",
    },
    answers: {
      milling_experience: "over_seven",
      milling_machine: ["vmc", "hmc", "spm"],
      axis_capability: ["three_axis", "four_axis"],
      controller_brand: ["fanuc", "siemens", "mitsubishi"],
      material_worked: ["en_eight", "en_thirty_one", "mild_steel", "aluminium"],
      setting_operation: [
        "tool_offset",
        "work_offset",
        "tool_length",
        "fixture_setting",
        "first_piece",
      ],
      measuring_tools: ["vernier", "micrometer", "bore_gauge", "height_gauge", "snap_gauge"],
      drawing_reading: "gdt",
      programming_level: "edit_program",
      tolerance_band: "point_zero_two",
      sector_worked: ["automotive"],
    },
    employments: [
      {
        employer: "Sandhar Technologies Ltd",
        employerCity: "Gurugram",
        employerState: "Haryana",
        startYm: "2023-01",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "CNC Machining Centre — Setter",
            startYm: "2024-07",
            endYm: null,
            workDone: "VMC 3 aur 4-axis, Fanuc, EN8 EN31, automotive components",
          },
        ],
      },
    ],
  },
  {
    persona: {
      id: "grinding",
      packId: "qp_cnc_grinding",
      displayName: "Sanjay Kamble",
      roleLabel: "CNC Grinding Operator — Setter",
      city: "Pimpri-Chinchwad",
      totalYears: 8,
      availability: { status: "immediate", notice_period_days: null },
      salaryMin: 28000,
      salaryMax: 33000,
      formAttributes: {
        ...FORM_PUNE,
        education_credential: "iti",
        education_council: "ncvt",
        education_year: 2017,
        education_institute: "Govt. ITI, Nashik",
      },
      educationLevel: "iti_diploma",
      educationField: "Grinder",
    },
    tier: { field: "grinding_experience", value: 10, option: "over_seven" },
    answers: {
      grinding_experience: "over_seven",
      grinding_machine: ["cylindrical", "surface", "centreless", "internal"],
      controller_brand: ["fanuc", "siemens"],
      material_worked: ["en_thirty_one", "case_hardened", "hchcr", "cast_iron"],
      setting_work: [
        "wheel_mounting",
        "diamond_dressing",
        "workhead_alignment",
        "steady_rest",
        "coolant_setting",
        "magnetic_chuck",
      ],
      measuring_tools: [
        "micrometer",
        "bore_gauge",
        "slip_gauge",
        "dial_indicator",
        "roughness_tester",
      ],
      wheel_type: ["aluminium_oxide", "cbn"],
      drawing_reading: "gdt",
      tolerance_band: "point_zero_zero_five",
      surface_finish: "ra_fine",
      sector_worked: ["bearings", "transmission"],
    },
    employments: [
      {
        employer: "Shivneri Precision Grinding",
        employerCity: "Pimpri-Chinchwad",
        employerState: "Pune",
        startYm: "2022-06",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "CNC Grinding — Setter",
            startYm: "2022-06",
            endYm: null,
            workDone: "CNC cylindrical aur centreless, EN31 bearing races, Ra 0.4",
          },
        ],
      },
    ],
  },
  {
    persona: {
      id: "cam",
      packId: "qp_cam_programming",
      displayName: "Nitin Deshmukh",
      roleLabel: "CAM Programmer — Programmer",
      city: "Chakan",
      totalYears: 7,
      availability: { status: "notice_period", notice_period_days: 60 },
      salaryMin: 42000,
      salaryMax: 50000,
      formAttributes: {
        ...FORM_PUNE,
        preferred_locations: ["Pune", "Chakan", "Talegaon"],
        shift_preference: "day",
        relocation_willingness: true,
        education_credential: "diploma",
        education_council: "aicte",
        education_year: 2019,
        education_institute: "MSBTE, Pune",
      },
      educationLevel: "iti_diploma",
      educationField: null,
    },
    tier: { field: "programming_experience", value: 10, option: "over_seven" },
    answers: {
      programming_experience: "over_seven",
      programming_mode: "cam_software",
      cam_software: ["mastercam", "powermill", "solidcam", "edgecam"],
      machine_programmed: ["vmc_three_axis", "vmc_four_axis", "five_axis_trunnion", "turn_mill"],
      controller_brand: ["fanuc", "heidenhain", "siemens"],
      programming_work: [
        "two_d_three_d_toolpath",
        "multi_axis_toolpath",
        "tool_library",
        "cycle_time",
        "strategy_selection",
        "tryout_support",
      ],
      cad_model_handling: [
        "step_iges_import",
        "parasolid_import",
        "model_repair",
        "fixture_modelling",
      ],
      post_processor_work: "edit_and_test",
      simulation_work: "both_checks",
      drawing_reading: "gdt",
      sector_worked: ["automotive", "tool_room"],
    },
    employments: [
      {
        employer: "Ranjangaon Precision Systems Pvt Ltd",
        employerCity: "Ranjangaon",
        employerState: "Pune",
        startYm: "2020-05",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "CAM Programmer",
            startYm: "2021-11",
            endYm: null,
            workDone: "Mastercam aur PowerMill, 5-axis impeller aur die work",
          },
        ],
      },
    ],
  },
  {
    /**
     * THE FRESHER PATH, AND THE RISKIEST OF THE SIX. `qp_cad_drafting`'s tier question offers
     * `fresher_course` (stored `0`), which closes every `gte` gate and opens the four `lte 1`
     * ones — so this persona's Zone 4 is the training block, not employment, and the page has no
     * work-history section at all. NO EMPLOYMENTS is therefore load-bearing, not an omission.
     */
    persona: {
      id: "cad-fresher",
      packId: "qp_cad_drafting",
      displayName: "Pooja Chaudhary",
      roleLabel: "CAD Designer / Draughtsman — Draughtsman",
      city: "Faridabad",
      totalYears: null,
      availability: { status: "immediate", notice_period_days: null },
      salaryMin: 14000,
      salaryMax: 18000,
      formAttributes: {
        languages: ["hindi", "english"],
        documents_ready: ["aadhaar", "pan", "bank_account", "passport_photos"],
        preferred_locations: ["Faridabad", "Gurugram", "Noida"],
        shift_preference: "day",
        job_type: "permanent",
      },
      educationLevel: "12",
      educationField: "Science",
    },
    tier: { field: "drafting_experience", value: 0, option: "fresher_course" },
    budgetTier: { field: "drafting_experience", value: 10, option: "over_seven" },
    answers: {
      drafting_experience: "fresher_course",
      cad_software: ["autocad", "solidworks", "fusion"],
      cad_modules: ["two_d_drafting", "three_d_modelling", "assembly_module", "sheet_metal"],
      drawing_work: [
        "part_modelling",
        "assembly_mating",
        "views_sections",
        "flat_pattern",
        "dimensioning",
        "revision_control",
      ],
      drawing_standards: ["gdt_symbols", "iso_standard", "title_block", "tolerance_stack"],
      drawing_type: "model_to_drawing",
      output_produced: ["part_drawing", "assembly_drawing", "bom", "dxf_cutting"],
      sector_studied: ["general_engg", "course_project"],
      // The `lte 1` block — what fills Zone 4 when there is no employment (§11 #1).
      cad_training_source: "private_institute",
      iti_workshop_machines: ["drawing_board", "cad_lab", "plotter_print", "machine_shop"],
      trade_test_status: "not_yet",
      iti_project_work: "Sheet metal enclosure ka 3D model aur flat pattern banaya",
    },
    employments: [],
  },
  {
    /**
     * THE FIRST BATCH 2 ROLE IN THIS FILE, and the first whose pack was authored FROM its ratified
     * page rather than beside it — `qp_welding_trade`'s `_sheet` note names the nine rows of page
     * 15 and says every one of them has a question. That claim had never been executed: nothing
     * drove this role from a form to a sheet, so "there is a question for it" and "the sheet
     * prints it" were the same sentence to everyone reading. They are not. SIX of the nine rows
     * reproduce the page character for character, two carry a recorded divergence, and the ninth
     * — `Equipment` — is a capture gap no test that stops at the pack or at the dictionary could
     * have seen: both halves are individually correct and the row is still short a chip.
     *
     * WHAT IS ANSWERED HERE AND WHAT IS DELIBERATELY NOT — the turner's and grinder's precedent,
     * followed rather than re-derived. Both of those cases answer exactly the questions whose map
     * row their page prints, and leave the rest of the pack unanswered: the grinder never answers
     * `dressing_method` (a rank-64 row no ratified page shows) or `grinding_type` (no row at all),
     * because a wider answer set adds rows the page does not print and sheds a ratified one to pay
     * for them. So `joint_type`, `machine_setting`, `weld_defect` and `fabrication_work` — the
     * four `gte 5` questions a senior welder really is asked — are NOT answered below. They carry
     * no capability row BY DESIGN (`trade-resume-map.ts` writes out why: page 15 prints none, and
     * they are matching data in `worker_attributes`), so answering them would change NOTHING on
     * this sheet — there is no row for them to fill — and the only thing it could do is blur WHERE
     * that was decided. It is the map's decision, not this persona's answer set, and a reader who
     * saw them answered and unprinted would have to re-derive that from the map to find out.
     *
     * `welder_level` IS ANSWERED, and it is the one answer here that prints no capability row. The
     * rung rides the HEADLINE ("Welder — Certified Welder") through `role_label`, which this file
     * hands in directly — so nothing in this render depends on it, and it is answered anyway
     * because a form-first welder answers it (it is `is_core`) and because leaving the level out
     * of the one persona this role has would make the ladder look optional to the next reader.
     *
     * THE DISPLAY NAME IS NOT THE PAGE'S. Page 15's name was not part of the transcription this
     * case was built from; `displayName` reaches Zone 1, which this file does not measure, and
     * every string that IS measured — the headline and all nine Section B rows — comes from the
     * page or from the pack.
     */
    persona: {
      id: "welder",
      packId: "qp_welding_trade",
      displayName: "Mohammad Aslam",
      roleLabel: "Welder — Certified Welder",
      city: "Faridabad",
      totalYears: 11,
      // "available immediately" on the page's terms line — no notice period to serve, which is
      // what a contract welder between site postings actually has.
      availability: { status: "immediate", notice_period_days: null },
      salaryMin: 26000,
      salaryMax: 30000,
      formAttributes: {
        ...FORM_NCR,
        // NOT `FORM_NCR`'s LANGUAGES. Page 15 lists Hindi · Urdu · English · Arabic, and `arabic`
        // has no slug in `LANGUAGES` — see the Zone 5 note in this file's header. The three that
        // exist are answered; the fourth is recorded there rather than silently handed in as a
        // slug that renders nothing, which is the failure this whole file is built to catch.
        languages: ["hindi", "urdu", "english"],
        // The page's document row, less "ESIC", which `DOCUMENTS_READY` also has no slug for.
        documents_ready: [
          "aadhaar",
          "pan",
          "bank_account",
          "uan_pf",
          "experience_letter",
          "passport_photos",
        ],
      },
      // NO ITI, AND NO `education_credential`. Page 15's qualification block reads "10th standard"
      // and names no trade certificate — this trade is learned at the arc, not at a council — so
      // the credential/council/year/institute quartet the four Batch 1 seniors carry is absent
      // here rather than invented. His certificates are a Welder Qualification Test and a site
      // safety induction, which are `facts.certifications` and out of this file's scope.
      educationLevel: "10",
      educationField: null,
    },
    tier: { field: "welding_experience", value: 10, option: "over_seven" },
    answers: {
      welding_experience: "over_seven",
      // FOUR PROCESSES, WHICH IS ALSO THE ROW'S CAP. `spot` is left untapped because the page
      // does not print it — and because with it the cap, not the page, would decide the row.
      welding_process: ["mig_mag", "arc", "tig", "gas_cutting"],
      welder_level: "certified_welder",
      // ALL FOUR, THOUGH ONLY THREE SURVIVE THE MAP'S `maxValues: 3`. Answering three instead
      // would render the identical row and hide the cap — the gap has to be visible as a LOSS,
      // not disguised as a persona who never owned a cutting set. See `captureGaps.Equipment`.
      welding_equipment: ["inverter_arc", "co_two_mig", "tig_machine", "gas_cutting_set"],
      electrode_type: ["e_six_zero_one_three", "e_seven_zero_one_eight", "er_seventy_s_six"],
      material_worked: ["mild_steel", "stainless", "aluminium"],
      // 1G, 2G, 3G — NOT 4G. The page stops at vertical, and overhead is the rung that separates
      // two pay bands in this trade, so tapping it to fill the row would be the one over-claim a
      // welder's sheet must never make.
      welding_position: ["flat", "horizontal", "vertical"],
      // `gte 2` — on screen for this tier, and the page prints all three.
      inspection_work: ["visual", "weld_gauge", "dye_penetrant"],
      plate_thickness: "upto_twentyfive",
      drawing_reading: "weld_symbol",
      sector_worked: ["structural", "general_engg"],
    },
    // THE PAGE'S OWN WORK HISTORY, three blocks of it, where the four Batch 1 seniors carry one
    // apiece and the fresher carries none.
    // Employments feed the BUDGET block below (the parity render passes none), and this role is
    // the first with a Gulf stint and a contract posting — `employerState` carrying a COUNTRY is
    // §11 #15's interim shape and had no case in this file until now.
    //
    // THE FOURTH LINE OF THE PAGE'S HISTORY IS NOT REPRODUCIBLE HERE AND IS NOT MEANT TO BE.
    // "2 earlier employers — 44 months total — 2015-2019" is `employmentsMore`, which
    // `buildEmploymentBlock` emits from records BEYOND `EMPLOYMENT_BLOCK_BUDGET` (4). Two more
    // records would print a FOURTH named block and summarise one employer, not two. Zone 4 is not
    // what this file measures — `resume-employment-rows.test.ts` owns that line.
    employments: [
      {
        // §11 #4 — the literal "Contract work", with the plant it was served at.
        employer: "Contract work — Escorts Kubota plant",
        employerCity: "Faridabad",
        employerState: "Haryana",
        startYm: "2025-08",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "Welder",
            startYm: "2025-08",
            endYm: null,
            workDone: "Sheet-metal sub-assembly aur jig ka kaam, MS 3-12 mm",
          },
        ],
      },
      {
        employer: "Al Barsha Steel Fabrication LLC",
        employerCity: "Dubai",
        // THE COUNTRY IN THE STATE COLUMN (§11 #15). There is no `country` column and the Gulf
        // stint is the differentiator on this page, so capture writes it here and the suffix
        // prints it verbatim. This is the interim shape, recorded in the journal, not a typo.
        employerState: "United Arab Emirates",
        startYm: "2022-03",
        endYm: "2025-06",
        durationStated: true,
        roles: [
          {
            roleLabel: "MIG and TIG Welder",
            startYm: "2022-03",
            endYm: "2025-06",
            workDone: "Structural steel aur stainless pipe spool, 3G vertical, DPT ke samay",
          },
        ],
      },
      {
        employer: "Jindal Fabricators Pvt Ltd",
        employerCity: "Faridabad",
        employerState: "Haryana",
        startYm: "2019-04",
        endYm: "2022-02",
        durationStated: true,
        roles: [
          {
            roleLabel: "Arc and MIG Welder",
            startYm: "2019-04",
            endYm: "2022-02",
            workDone: "Structural section, grating aur platform, E7018 rod",
          },
        ],
      },
    ],
  },
];

function caseFor(id: string): RoleCase {
  const found = CASES.find((candidate) => candidate.persona.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

// ── THE ASSERTIONS ────────────────────────────────────────────────────────────────────

describe("the six shipped roles render their ratified Section B", () => {
  for (const roleCase of CASES) {
    const { persona } = roleCase;
    const pack = loadPack(persona.packId);
    const reference = REFERENCE[persona.packId];
    if (!reference) throw new Error(`no reference sheet for ${persona.packId}`);
    const askable = reference.rows.filter(([label]) => !reference.unaskable.includes(label));
    const divergences = reference.divergences ?? {};
    const captureGaps = reference.captureGaps ?? {};
    // WHAT THE SHEET IS AGREED TO PRINT: the page, except on the rows where a divergence has been
    // ruled — and there the RULED string, not a wildcard. See {@link ReferenceSheet.divergences}.
    //
    // CAPTURE GAPS ARE NOT FOLDED IN HERE, deliberately: `agreed` means "someone signed this
    // off", and a gap is signed off by nobody. They are excluded from the green assertion by
    // label and re-asserted in full by the `it.fails` tripwire beside it.
    const agreed = askable.map(
      ([label, value]) => [label, divergences[label]?.rendered ?? value] as const,
    );
    const attributes = attributesFrom(pack, roleCase.answers);
    const { input, html } = renderSheet(persona, attributes);
    const rendered = sectionB(input);

    describe(`${persona.id} (${persona.packId})`, () => {
      it("prints every Section B ROW the ratified page prints, in the page's order", () => {
        // ROWS BEFORE VALUES, AS TWO ASSERTIONS. A row that vanishes is the `value_text` defect
        // — it renders nothing, with no error — and it must not be buried inside a value diff.
        expect(sectionBLabels(input)).toEqual(askable.map(([label]) => label));
      });

      it("prints every Section B row's VALUE as the page prints it, bar the recorded gaps", () => {
        // EXACT AGAINST THE PAGE ON EVERY ROW THE PACK CAN ACTUALLY ANSWER. Only the labels named
        // in `captureGaps` are held out, and each of those carries the missing pack option beside
        // it, so this stays a parity assertion rather than a filtered one.
        const guarded = agreed.filter(([label]) => captureGaps[label] === undefined);
        const renderedByLabel = new Map(rendered);
        expect(guarded.map(([label]) => [label, renderedByLabel.get(label)])).toEqual(
          guarded.map(([label, value]) => [label, value]),
        );
      });

      // ONLY WHERE THERE ARE GAPS. A role that reproduces its page in full has nothing for this
      // tripwire to watch, and `it.fails` over a passing comparison would itself fail — which is
      // how CAM and the CAD fresher say, structurally, that they have no open gaps at all.
      it.runIf(Object.keys(captureGaps).length > 0).fails(
        "STILL cannot reproduce the page's VALUES — the recorded capture gaps",
        () => {
          // THE TRIPWIRE, AND IT IS MARKED `fails` BECAUSE IT DOES FAIL. This is the untouched
          // full-page comparison the file was written around: every askable row, against the
          // page's own string. It is red today for the gaps recorded above and nothing else.
          //
          // WHEN THIS GOES GREEN, VITEST FAILS THE RUN — which is the point. A pack that gains
          // the twin-spindle option, or a seam that carries a second configuration, closes a gap
          // and must delete its entry from `captureGaps`. Marking it `fails` keeps the suite
          // honest without keeping it red: nothing here was relaxed, and `REFERENCE.rows` still
          // holds the ratified string as the sole authority.
          expect(rendered).toEqual(agreed.map(([label, value]) => [label, value]));
        },
      );

      it("records a missing PACK OPTION for every capture gap, and the gap is still open", () => {
        // THE SAME THREE FACTS THE DIVERGENCE RECORD ASSERTS, for the other kind of entry: the
        // page still says what the record claims, the pipeline still produces what the record
        // claims, and the two are still different. A gap whose `rendered` has drifted is a
        // silent change in output; a gap that now matches the page is one to delete.
        const renderedByLabel = new Map(rendered);
        for (const [label, gap] of Object.entries(captureGaps)) {
          const pageRow = reference.rows.find(([rowLabel]) => rowLabel === label);
          expect(pageRow, `${label}: recorded gap names no row on this page`).toBeDefined();
          expect(pageRow?.[1], `${label}: page string`).toBe(gap.page);
          expect(renderedByLabel.get(label), `${label}: ${gap.missing}`).toBe(gap.rendered);
          expect(
            gap.rendered,
            `${label}: the pipeline now matches the page — delete this capture gap`,
          ).not.toBe(gap.page);
          // A GAP WITH NO NAMED MISSING OPTION IS AN EXCUSE, not a backlog entry.
          expect(gap.missing.trim().length, `${label}: no missing option named`).toBeGreaterThan(
            40,
          );
        }
      });

      it("records a gap or a divergence for a row, never both", () => {
        // The two records mean opposite things — one is closed, one is open — so a row carrying
        // both would be simultaneously ruled and unruled, and the green assertion above would
        // silently prefer the divergence.
        const both = Object.keys(captureGaps).filter((label) => divergences[label] !== undefined);
        expect(both, "a row is either ruled or open, not both").toEqual([]);
      });

      it("diverges from the ratified page ONLY where a divergence is recorded", () => {
        // THREE FACTS AT ONCE, per recorded row: the page still says what the record claims it
        // says, the renderer still prints what was agreed, and the two are still different. Any
        // one of those going stale is a defect — a renderer that quietly starts matching the page
        // has had its ruling overtaken and the record must go, and a record whose `page` no longer
        // matches the transcription above is a ruling made against a string nobody printed.
        const renderedByLabel = new Map(rendered);
        for (const [label, divergence] of Object.entries(divergences)) {
          const pageRow = reference.rows.find(([rowLabel]) => rowLabel === label);
          expect(pageRow, `${label}: recorded divergence names no row on this page`).toBeDefined();
          expect(pageRow?.[1], `${label}: page string`).toBe(divergence.page);
          expect(renderedByLabel.get(label), `${label}: ${divergence.why}`).toBe(
            divergence.rendered,
          );
          expect(
            divergence.rendered,
            `${label}: the renderer now matches the page — delete this divergence`,
          ).not.toBe(divergence.page);
          // A REASON IS THE POINT OF THE RECORD. An entry with an empty `why` is a relaxed
          // assertion wearing a costume.
          expect(divergence.why.trim().length, `${label}: no reason recorded`).toBeGreaterThan(40);
        }
      });

      it("renders no empty capability row (§11 #1)", () => {
        const empty = rendered.filter(([, value]) => value.trim() === "").map(([label]) => label);
        expect(empty).toEqual([]);
      });

      it("puts every rendered row into the HTML the reader actually gets", () => {
        // THE MAPPER IS NOT THE SHEET. A row can be built and still never reach the page if the
        // template's slot name drifts, so the rendered HTML is checked rather than trusted.
        const missing = rendered.filter(
          ([label, value]) =>
            !html.includes(PdfRenderer.escapeHtml(label)) ||
            !value.split(" · ").every((part) => html.includes(PdfRenderer.escapeHtml(part))),
        );
        expect(missing).toEqual([]);
      });

      // THE HEADLINE IS ASSERTED TWO WAYS FOR ONE ROLE ONLY, and the reason is a conflict between
      // two ratified references rather than a defect. See `headlineConflict` on the case.
      const headlineConflict = roleCase.headlineConflict;

      it.skipIf(headlineConflict !== undefined)(
        "composes the Verdict Line's headline exactly as the page prints it (§6.2)",
        () => {
          expect(input.headlineLine).toBe(reference.headline);
        },
      );

      it.runIf(headlineConflict !== undefined)(
        "composes the headline the OTHER ratified reference prints, and the two disagree",
        () => {
          // TWO SIGNED-OFF PAGES, ONE ROLE, DIFFERENT HEADLINES — the one thing this file cannot
          // adjudicate, so it asserts BOTH halves instead of picking a winner. Whichever way the
          // owner rules, exactly one of these lines changes and the other fails, which is what
          // makes the conflict impossible to resolve by accident.
          expect(input.headlineLine, headlineConflict!.why).toBe(headlineConflict!.rendered);
          expect(
            input.headlineLine,
            "the 21-role page and the R9 sample now agree — delete this conflict record",
          ).not.toBe(reference.headline);
          expect(reference.headline, "the 21-role page's own string").toBe(
            "CNC Machining Centre Operator — Setter · 8 yrs · Fanuc, Siemens, Mitsubishi",
          );
        },
      );

      it("fits one page", () => {
        // HELD TO THE STRICT FORM, DELIBERATELY, even though the 2026-09-03 owner ruling relaxed
        // the general contract to "one page unless preserving a ratified row required two". These
        // six ARE the ratified pages: each was signed off as a single sheet, so a persona
        // reproducing one and spilling is a defect in this pipeline rather than the ruling doing
        // its job. The relaxed form belongs on synthetic and future content, and is asserted
        // there — see `sheet-shape-matrix.test.ts`.
        expect(sheetContentLines(input)).toBeLessThanOrEqual(SHEET_LINE_BUDGET);
        expect(input.degradationOverflows, "a ratified page must not spill").toBe(false);
      });
    });
  }
});

describe("CAPABILITY_ROW_BUDGET holds and sheds by rank", () => {
  for (const roleCase of CASES) {
    const { persona } = roleCase;
    const tier = roleCase.budgetTier ?? roleCase.tier;
    const pack = loadPack(persona.packId);
    const map = tradeResumeMapFor(persona.packId);
    if (!map) throw new Error(`no trade map for ${persona.packId}`);
    const widest = attributesFrom(pack, maximalAnswers(pack, tier.field, tier.value, tier.option));
    const { input } = renderSheet(persona, widest, roleCase.employments);
    const printed = sectionBLabels(input);
    // ONLY THE ROWS THIS WORKER COULD HAVE HAD. A row whose question the tier gate never put on
    // screen was not SHED — it was never asked — and counting it as shed would make the property
    // below fail on the fresher branch for a reason that has nothing to do with the budget.
    const answerable = map.capability.filter((spec) => (widest[spec.from] ?? null) !== null);
    // AND ONLY THE ROWS THE SHEET IS ALLOWED TO PRINT. `drawing_reading: "none"`,
    // `simulation_work: "none"` and `drawing_check_work: "check_none"` are real answers that
    // carry no label ON PURPOSE (§8.3 — a negative claim does not belong on a worker's own
    // marketing document), so their rows correctly print nothing.
    const printable = answerable.filter((spec) => hasPrintableValue(spec, widest));

    describe(`${persona.id} answered as widely as the pack allows`, () => {
      it(`prints at most ${CAPABILITY_ROW_BUDGET} capability rows`, () => {
        expect(printed.length).toBeLessThanOrEqual(CAPABILITY_ROW_BUDGET);
      });

      it("spends its budget only on rows it can actually print", () => {
        // THE BUDGET FILTER RUNS BEFORE THE DICTIONARY FILTER. `buildTradeCapabilityRows` slices
        // to `CAPABILITY_ROW_BUDGET` on "did he answer this question", and only afterwards drops
        // the values with no reviewed label — so an unprintable answer occupies a slot and then
        // renders nothing, and a lower-ranked row that HAD values is pushed off the sheet to pay
        // for it. Fewer rows than the budget, with printable rows still queueing, is that defect.
        expect(
          printed.length,
          // NAME THE ROWS, not just the count. "expected 8 to be 9" says a row went missing and
          // nothing about which, and the whole value of this assertion is telling the reader
          // which printable row paid for the unprintable one.
          `printed [${printed.join(" | ")}] — printable [${printable.map((s) => s.label).join(" | ")}]`,
        ).toBe(Math.min(printable.length, CAPABILITY_ROW_BUDGET));
      });

      it("sheds only rows that are LESS decisive than every row it kept", () => {
        // THE PROPERTY, NOT THE ALGORITHM. Re-deriving "sort by rank, take ten" here would pass
        // even if the rule were inverted; this asserts the consequence the guideline actually
        // cares about — nothing more decisive is ever dropped for something less decisive.
        //
        // MEASURED OVER `printable`, NOT `answerable`, AND THE DIFFERENCE IS THE WHOLE POINT OF
        // THE SIBLING ASSERTION ABOVE. `drawing_check_work: "check_none"` is ANSWERED and carries
        // no reviewed label on purpose (§8.3), so it is not a row the budget shed — it is a row
        // with nothing to print, and counting it as shed would read a §8.3 silence as a budget
        // casualty and fail on the CAD senior for a reason that has nothing to do with rank.
        const kept = printable.filter((spec) => printed.includes(spec.label));
        const shed = printable.filter((spec) => !printed.includes(spec.label));
        const worstKept = Math.max(...kept.map((spec) => spec.rank));
        const bestShed = shed.length > 0 ? Math.min(...shed.map((spec) => spec.rank)) : Infinity;
        expect(worstKept).toBeLessThan(bestShed);
      });

      it("renders no empty capability row (§11 #1)", () => {
        const empty = sectionB(input)
          .filter(([, value]) => value.trim() === "")
          .map(([label]) => label);
        expect(empty).toEqual([]);
      });

      it("stays on one page after the ladder, unless a ratified row required a second", () => {
        // THE INVARIANT AS THE 2026-09-03 OWNER RULING RESTATED IT, and this is the block where
        // the restatement belongs: `maximalAnswers` is a worker who answered EVERY question his
        // pack asks, which is a shape no ratified page has and a shape the ladder may not buy a
        // page back from by deleting a row a human signed off.
        //
        // MEASURED TODAY: all six shipped roles still fit outright, so the branch below is not
        // yet taken by any of them. It is written because the alternative — asserting the strict
        // fit — would fail the day a pack grows, and would fail for the RIGHT behaviour.
        if (!input.degradationOverflows) {
          expect(sheetContentLines(input)).toBeLessThanOrEqual(SHEET_LINE_BUDGET);
          return;
        }
        // It spilled: prove the ladder had nothing left. Re-running every permitted compression
        // over the returned sheet must gain nothing at all.
        const probe = JSON.parse(JSON.stringify(input)) as DegradableSheet;
        const before = sheetContentLines(probe);
        for (const step of COMPRESSING_LADDER) step.apply(probe);
        expect(sheetContentLines(probe), "spilled with compression unspent").toBe(before);
      });
    });
  }
});

describe("the CAD draughtsman's FRESHER path — the role's primary worker", () => {
  const roleCase = caseFor("cad-fresher");
  const pack = loadPack(roleCase.persona.packId);
  const attributes = attributesFrom(pack, roleCase.answers);
  const { input, html } = renderSheet(roleCase.persona, attributes);

  it("has no employment block at all — the ratified page carries no work history", () => {
    expect(input.employments ?? []).toEqual([]);
  });

  it("fills Zone 4 with the workshop training block (§11 #1)", () => {
    // THE ROW THAT ALREADY SHIPPED EMPTY ONCE. `fresher.workshopMachines` is keyed by the STORED
    // VALUE; a key that matches nothing yields an empty `work` string and `buildFresherRows`
    // returns [] — an absent block, with no error anywhere. Both halves are checked.
    expect(input.experiences).toHaveLength(1);
    const block = input.experiences[0];
    expect(block?.role).toBe("CAD training");
    expect(block?.work.trim()).not.toBe("");
  });

  it("names the machines she actually stood at, not a slug and not nothing", () => {
    const work = input.experiences[0]?.work ?? "";
    expect(work).toContain("Hand drafting on drawing board");
    expect(work).toContain("CAD lab — drawing on computer");
    expect(work).toContain("Plotter printing");
    expect(work).toContain("Machine shop exposure");
    // Her own words, printed as she typed them (§8's third permitted source).
    expect(work).toContain("Sheet metal enclosure ka 3D model aur flat pattern banaya");
  });

  it("says nothing about a trade test she has not taken (§8.3)", () => {
    expect(input.experiences[0]?.work ?? "").not.toContain("Trade test");
  });

  it("says 'Sector studied', never 'Sector worked'", () => {
    const labels = sectionBLabels(input);
    expect(labels).toContain("Sector studied");
    expect(labels).not.toContain("Sector worked");
    expect(html).toContain("Sector studied");
    expect(html).not.toContain("Sector worked");
  });
});

describe("a thin sheet still degrades to one page", () => {
  for (const roleCase of CASES) {
    const { persona, tier } = roleCase;
    const pack = loadPack(persona.packId);

    it(`${persona.id} — only the tier question answered`, () => {
      const thin = attributesFrom(pack, { [tier.field]: tier.option });
      const { input } = renderSheet(persona, thin);
      expect(sheetContentLines(input)).toBeLessThanOrEqual(SHEET_LINE_BUDGET);
      // NOTHING SHOULD NEED TO BE DROPPED from a sheet with no capability section at all; a
      // non-zero stage here would mean the ladder is firing on the sparsest worker we produce.
      expect(input.degradationStage).toBe(0);
    });
  }
});

describe("fam_draughting is a router, not a role", () => {
  it("produces no capability section and therefore no role form", () => {
    // UNIT-3118 ROUTER. `qp_draughting` has no descriptor and no `TRADE_RESUME_MAPS` entry, so a
    // worker who somehow reached it must get a collapsed section rather than a half-built sheet.
    expect(tradeResumeMapFor("qp_draughting")).toBeUndefined();
  });
});
