import type { ResumeExperienceLine } from "./resume-renderer.service";
import type { WorkerAttributeValues } from "./trade-resume-map";
import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * ZONE 4 FOR A FRESHER (R10 §2.6) — what fills the page when there is no work history.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE GUIDELINE IS EXPLICIT AND WE WERE IGNORING IT. §11 #1: "Fresher order auto-applies.
 * Training, trade test, machines used in the ITI workshop and project work occupy Zone 4. Never
 * render an empty History heading." Nothing in the 143-pack corpus asked a fresher any of those
 * four things, so the rule was unimplementable rather than unimplemented — and persona 1, a fresh
 * ITI pass-out, measured 125 mm of blank page, the emptiest sheet in the set and the worker this
 * product exists for.
 *
 * §11 #1 IS ALSO WHY THIS IS A REAL ZONE RATHER THAN A CONSOLATION. A supervisor hiring a
 * pass-out is not looking for employment history he knows does not exist; he is looking for which
 * machines the man has actually stood at and whether he passed his trade test. That is a
 * different question with a real answer, and it belongs in the zone the eye goes to.
 *
 * ── COMPOSITION, AND WHY IT IS NOT THE THING §8 FORBIDS ───────────────────────────────
 *
 * Every value here is either a CLOSED VOCABULARY LABEL (a machine, a trade-test status) or the
 * worker's OWN WORDS (the project). Those are two of §8's three permitted sources, and this file
 * joins them with separators — exactly what `buildVerdictLine`, `locationSuffix` and every other
 * row on this sheet already do. What §8 forbids is a fourth source: a sentence the model wrote.
 * Nothing here passes through a model, and the project text prints as the worker typed it.
 *
 * IT RENDERS AS AN `experiences` ENTRY, not as a new region. The template already has a
 * role/duration/work shape for a worker with no `worker_employment` rows, and `resume-render-
 * input.ts` already suppresses it when real employments exist. Reusing it means no template
 * change — `bb_trade.v1.html` is shipped and immutable — and it means the History heading stops
 * being empty by the same mechanism that fills it for everyone else.
 */

/**
 * The ITI workshop's machine vocabulary — slug → the English printed on the sheet.
 *
 * PACK-KEYED (R12 §2.1). The MECHANISM here — a fresher has training rather than employment —
 * is trade-independent, and `buildFresherRows` stays generic. The VOCABULARY is not: a turner's
 * `iti_workshop_machines` options are lathes and shapers, a welder's would be welding sets, and
 * a slug list authored for one trade silently mislabelling another's answers is exactly the
 * failure this scoping exists to prevent. A pack with no entry gets no fresher block, which is
 * the same drop-the-unknown rule every dictionary on this sheet follows.
 *
 * READ OFF THE ROLE DESCRIPTOR NOW, because "which packs have a fresher vocabulary" was the sort
 * of fact that is only ever wrong by omission. `qp_vmc_milling` asks `iti_workshop_machines` and
 * `trade_test_status` exactly as turning does, and had no entry here — so a VMC pass-out answered
 * both questions and still met the empty History heading that §11 #1 forbids. Keeping the
 * vocabulary beside the role that asks for it is what makes that omission visible: the descriptor
 * has one `fresher` field, and a role either fills it or deliberately does not.
 */
const WORKSHOP_MACHINES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(
    ROLE_FORM_DESCRIPTORS.filter((role) => role.fresher !== undefined).map((role) => [
      role.packId,
      role.fresher!.workshopMachines,
    ]),
  );

/**
 * Trade-test status → the printed clause.
 *
 * `not_yet` PRINTS NOTHING, and that is the §8.3 asymmetry rule applied to a credential: "has not
 * yet taken the trade test" is a true statement that costs the worker the interview and tells the
 * employer nothing he would not assume. `appeared` DOES print — a man who sat the test and is
 * waiting has done something, and saying so is the honest version of the same fact.
 */
const TRADE_TEST: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.fromEntries(
  ROLE_FORM_DESCRIPTORS.filter((role) => role.fresher !== undefined).map((role) => [
    role.packId,
    role.fresher!.tradeTest,
  ]),
);

/**
 * The role line over a fresher block, per pack.
 *
 * SEE {@link DEFAULT_TRAINING_LABEL}. Read off the descriptor for the same reason the two
 * vocabularies above are: "which packs need a different heading" is a fact only the role knows,
 * and a table here would be the eleventh hand-maintained one this registry exists to delete.
 */
const TRAINING_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  ROLE_FORM_DESCRIPTORS.filter((role) => role.fresher?.trainingLabel !== undefined).map((role) => [
    role.packId,
    role.fresher!.trainingLabel!,
  ]),
);

/**
 * What the block is called when a role does not say otherwise.
 *
 * TRUE OF EVERY MACHINING TRADE AND FALSE OF THE DRAWING OFFICE, which is why it became a default
 * rather than staying a literal. A turner, a miller, a grinder and a part programmer all train on
 * an ITI workshop floor. A CAD student very often trains at a private institute, and heading his
 * block "ITI workshop training" would state a credential he has not got — on the one role whose
 * primary worker is a fresher. See {@link RoleFresherVocabulary.trainingLabel}.
 */
const DEFAULT_TRAINING_LABEL = "ITI workshop training";

/**
 * The one free-text answer in this block, and the only attribute key on the whole sheet that a
 * model may restate.
 *
 * EXPORTED SO THE RENDER WORKER AND THIS FILE CANNOT DISAGREE about which answer gets rewritten.
 * The polisher reads this key to decide what to send; this file reads it to decide what to print.
 * A literal in each place is the sort of pair that drifts silently — the rewrite would be
 * computed for one key and looked up under another, and the only symptom would be a fresher's
 * sheet that is still Hinglish for no visible reason.
 */
export const ITI_PROJECT_WORK_KEY = "iti_project_work";

/**
 * Every pack a role form actually serves.
 *
 * THE BOUND ON THE RULING BELOW, and the only fact about a role this file still reads. A profile
 * written before the role forms carries no pack: it was assembled from a chat interview that put
 * no work-history screen in front of anybody, so an empty employment list on it means "nobody
 * collected one" rather than "he has none". Reading that as "Fresher" would relabel the entire
 * back catalogue on the strength of a form those workers never saw.
 */
const FORM_PACKS: ReadonlySet<string> = new Set(ROLE_FORM_DESCRIPTORS.map((role) => role.packId));

/**
 * "Fresher" — the tenure segment's text for a worker with no work history, or null.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE WORK HISTORY IS THE ONLY SOURCE OF TENURE ON THIS SHEET (owner ruling 2026-09-09b).
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * "Fix the total experience which is shown on the resume to restrict only to the work history
 * details. The work history calculation should be the core of the experience which is displayed
 * on the resume on top summary. If there is someone who has no work experience, no work history,
 * then it will be considered as a fresher, and it should not become like duration not stated."
 *
 * THE ROLE PACK'S TIER GATE IS A PROFILING-DEPTH CONTROL AND NOTHING ELSE. `turning_experience`,
 * `welding_experience` and their nineteen siblings decide HOW MANY QUESTIONS THE FORM ASKS — the
 * fresher block hangs off `<= 0` and the depth questions off `>= 2` — which is why the same ruling
 * keeps the question in the form while taking it off the page. It is not a tenure source, so this
 * function no longer reads it, and no pack answer of any kind now reaches §6.2's tenure segment.
 * The FIGURE is `totalEmployedYears`, summed from the worker's own dated employments in
 * `resume-render-input.ts`; this label is only what prints when there is no history for it to sum.
 *
 * TWO REVISIONS DIED HERE AND BOTH MADE THE SAME MISTAKE. The first printed the gate's rungs as
 * bands ("1–3 yrs", "7+ yrs"). The second stopped printing them but still READ one, to withhold
 * "Fresher" from a worker whose rung claimed a year or more. The ruling rejects the premise under
 * both — a rung is not experience — and the withheld case is the one the owner is answering
 * directly: a man who tapped "7 saal se zyada" and then filed no work history used to read
 * "duration not stated", and now reads "Fresher". The way he stops reading it is by filing the
 * history he has, which is the screen this ruling points him at.
 *
 * WHAT THE SHEET GIVES UP BY SAYING SO, STATED PLAINLY. That man's own form claims years the page
 * no longer shows, and §8.3's asymmetry rule is why the previous revision withheld the word. The
 * ruling overrides it on a factual ground rather than a stylistic one: the rung is a bracket the
 * worker tapped to size his own questionnaire, and treating it as a claim about his career was the
 * error in the first place. "Fresher" now means exactly what it says — no work history on file.
 *
 * SO THE WHOLE RULE IS ONE LINE: A FORM WORKER WHOSE WORK HISTORY WAS READ AND IS EMPTY IS A
 * FRESHER. Everybody else gets null, and the segment is composed from the sum or from §11 #3's
 * honest unknown, exactly as before.
 *
 * THE DECLARED FRESHER CHIP NO LONGER OVERRIDES A FILED HISTORY, and that is the same rule holding
 * in the other direction. `qp_cad_drafting`'s "course kiya hai, kaam ka tajurba nahi" used to print
 * the word even beside an employment block, which is the contradiction §6.2 exists to prevent — a
 * page reading "Fresher" three rows above two employers. Her ratified sheet is unchanged, because
 * it has no work history: she reaches the word through the rule below, on its own terms.
 */
export function tenureStatusLabel(
  /** The pack the form ran, or null for a profile no form produced. See {@link FORM_PACKS}. */
  packId: string | null,
  /**
   * True when the worker's work history was READ and is EMPTY — never when it is merely absent.
   *
   * THE DISTINCTION IS THE FAIL-CLOSED RULE, and it is now the ONLY thing standing between an
   * infrastructure miss and a claim on a man's résumé. The caller loads `worker_employment` inside
   * a try/catch that degrades to `[]`, because a dead query must cost Zone 4 rather than the whole
   * PDF. Under a naive negation that degrade would print "Fresher" over a twelve-year turner whose
   * employer blocks simply could not be fetched. So the caller answers "did we actually look?",
   * and a failure answers `false`: the sheet says "duration not stated", which is what it said
   * before the query died.
   */
  filedNoWorkHistory: boolean,
): string | null {
  if (packId === null || !FORM_PACKS.has(packId)) return null;
  return filedNoWorkHistory ? FRESHER_LABEL : null;
}

/**
 * The word itself. §6.2's vocabulary, and NOT per-role: a fresher is a fresher in every trade,
 * and the only per-trade fact is which stored value means it.
 */
const FRESHER_LABEL = "Fresher";

/** The most machines a fresher's line prints, so one row cannot wrap into three. */
const MAX_WORKSHOP_MACHINES = 4;

function slugsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Zone 4 for a worker with no employment rows, or an empty array when he answered none of it.
 *
 * EMPTY IS STILL THE RIGHT ANSWER SOMETIMES. A worker who is not a fresher and simply has not
 * filled the work-history form must not get an invented training block — so this returns nothing
 * unless the fresher questions were actually answered. The History heading then collapses exactly
 * as it does today, which is the pre-existing behaviour and not a regression.
 *
 * THE CALLER DECIDES WHEN TO USE IT. This does not know whether `worker_employment` rows exist;
 * `resume-render-input.ts` does, and it already owns the one-or-the-other rule for Zone 4.
 */
export function buildFresherRows(
  /**
   * The pack the interview ran. REQUIRED — an optional pack id would let a caller get the
   * pack-blind behaviour back by forgetting to pass it, which is the bug this argument exists
   * to make impossible. A pack with no vocabulary entry yields no rows.
   */
  packId: string | null,
  attributes: WorkerAttributeValues,
  /**
   * The model's rewrite of the free-text segment, and whether it may print (#1350).
   *
   * STILL PURE. The rewrite is computed by the render worker and handed in, exactly as
   * `work_done_polished` is handed to {@link buildEmploymentBlock} — this file does no I/O and
   * calls no model, so the §8 reasoning in the header holds unchanged: every value it JOINS is a
   * closed-vocabulary label or the worker's text, and the choice of WHICH worker text is made by
   * the caller under the kill switch.
   */
  opts: {
    readonly polished?: Readonly<Record<string, string>>;
    readonly polishEnabled?: boolean;
  } = {},
): ResumeExperienceLine[] {
  const workshopMachines = packId === null ? undefined : WORKSHOP_MACHINES[packId];
  const tradeTests = packId === null ? undefined : TRADE_TEST[packId];
  if (workshopMachines === undefined && tradeTests === undefined) return [];

  const machines = slugsOf(attributes.iti_workshop_machines)
    .map((slug) => workshopMachines?.[slug])
    .filter((v): v is string => Boolean(v))
    .slice(0, MAX_WORKSHOP_MACHINES);
  const tradeTest = tradeTests?.[scalar(attributes.trade_test_status) ?? ""] ?? null;
  // ── THE ONE SEGMENT OF THIS BLOCK THE WORKER WROTE HIMSELF ──────────────────────────────
  //
  // The machines and the trade-test clause above are closed-vocabulary labels, already English.
  // This is free text, typed or dictated in answer to "ITI me kya banaya tha? Apne shabdon me
  // bataiye" — and until the 2026-09-09 owner report it printed exactly as typed, so a fresher's
  // entire work history read "kuch nhi banaya, bas knowledge he mujhe" to an employer.
  //
  // THE REWRITE WHEN THERE IS ONE AND THE SWITCH IS ON, his own words otherwise — the identical
  // rule, and the identical fail-closed default, that `workLine` applies to an employment's
  // description. His own words are never overwritten and are what every degrade prints.
  const ownProject = scalar(attributes.iti_project_work);
  const polishedProject =
    opts.polishEnabled === true ? scalar(opts.polished?.[ITI_PROJECT_WORK_KEY]) : null;
  const project = polishedProject ?? ownProject;

  // The whole block, as one entry. A fresher has one training period, not several, and giving
  // each fact its own row would spend three lines of a zone that has 24% of the page on a worker
  // whose page is already the sparsest we produce.
  const work = [machines.join(" · "), tradeTest, project]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v))
    .join(" · ");

  if (work === "") return [];
  return [
    {
      // THE ROLE IS A LABEL, not a claim about him. It names what the block IS; it is not a job
      // title he is asserting and it cannot be read as employment because it carries no employer
      // and no dates. Per-role where the default would be false — see {@link TRAINING_LABEL}.
      role: (packId === null ? undefined : TRAINING_LABEL[packId]) ?? DEFAULT_TRAINING_LABEL,
      // §11 #3's rule does not apply: this is not a tenure he stated and failed to have recorded,
      // it is a block that has no duration by nature. An empty string collapses the span.
      duration: "",
      work,
    },
  ];
}
