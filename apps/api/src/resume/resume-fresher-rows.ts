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
 * Pack → { the tier question, the stored value that means "no work experience at all" }.
 *
 * READ OFF THE ROLE DESCRIPTOR for the same reason the three vocabularies above are: which packs
 * have a fresher rung at all, and what that rung STORES, is a fact only the role knows, and the
 * value is not portable — `qp_cad_drafting` stores 0 for "course kiya hai, kaam ka tajurba nahi"
 * while every other pack stores 0 for "1 saal se kam". See
 * {@link RoleFresherVocabulary.tenureValue}.
 */
const FRESHER_TENURE: Readonly<Record<string, { question: string; value: number }>> =
  Object.fromEntries(
    ROLE_FORM_DESCRIPTORS.filter((role) => role.fresher?.tenureValue !== undefined).map((role) => [
      role.packId,
      { question: role.tenureQuestionKey, value: role.fresher!.tenureValue! },
    ]),
  );

/**
 * Pack → the tier-gate question, for EVERY role rather than only the ones with a fresher block.
 *
 * SEPARATE FROM `FRESHER_TENURE` BECAUSE IT ANSWERS A DIFFERENT QUESTION. That map holds the rung
 * a role DECLARES as its fresher status; this one holds the gate key alone, because the rule
 * below reads the rung's value rather than a declaration. Every enabled pack's gate is mandatory
 * (`role-corpus-parity.guard.test.ts`), so this is a question every form-first worker has
 * answered — which is what makes it usable as a tenure source at all.
 */
const TENURE_GATE: Readonly<Record<string, string>> = Object.fromEntries(
  ROLE_FORM_DESCRIPTORS.map((role) => [role.packId, role.tenureQuestionKey]),
);

/**
 * The tier-gate value every pack's LOWEST rung stores — the rung the packs themselves treat as
 * "fresher".
 *
 * NOT A GUESS ABOUT THE CORPUS, AND IT IS ASSERTED. `role-corpus-parity.guard.test.ts` pins the
 * lowest rung of every ENABLED role's gate at 0, so a pack authored later whose scale starts
 * somewhere else goes red there rather than silently printing the wrong word here. (Enabled is
 * all it can pin: twelve of the twenty-one declared roles have no pack file yet, and each is
 * covered by that guard the day its pack lands.)
 *
 * WHAT THE PACKS AGREE WITH, AND WHAT THEY DO NOT — stated exactly, because the difference is the
 * whole risk in this rule. The packs DO treat rung 0 as the fresher tier: `iti_workshop_machines`,
 * `trade_test_status` and `iti_project_work` are served behind `<tenure gate> <= 0` on the
 * machining packs, which is why a `under_one` worker is the one asked about his ITI workshop at
 * all. They do NOT contain a chip in which he SAYS he has no experience — outside
 * `qp_cad_drafting` the bottom rung reads "1 saal se kam", less than a year rather than none. So
 * this is an inference from an ask-gate, not a claim the worker made, and the 2026-09-08 ruling
 * is what authorises it. See the ROUTE 2 note on `fresherTenureLabel` for what bounds it and for
 * the follow-up that would put the word back on the worker's own words.
 */
const NO_EXPERIENCE_RUNG = 0;

/**
 * "Fresher", when this worker's own form says he has no work experience — otherwise null.
 *
 * WHY THE SHEET NEEDS THIS AT ALL (§6.2, and it is the ratified page). The CAD draughtsman's
 * reference sheet leads "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD,
 * SolidWorks, Fusion 360", and the renderer could not produce the word: the tenure segment had
 * exactly two outputs, "N yrs" and "duration not stated". Pooja's status IS captured — she taps
 * `fresher_course`, stored as 0 — but nothing carried it to the headline, so the highest-volume
 * role in the programme printed "duration not stated" over the worker the role exists for.
 *
 * A STATUS LABEL, WHICH IS §8's FIRST PERMITTED SOURCE. It is a closed-vocabulary word, not a
 * derived figure and not a model's sentence.
 *
 * IT DOES NOT OUTRANK A STATED NUMBER. `tenurePhrase` consults it only where the segment would
 * have said "duration not stated"; a worker who also stated a total still prints his own figure.
 *
 * ── TWO ROUTES TO THE WORD, AND THE SECOND IS AN OWNER RULING (2026-09-08) ─────────────
 *
 * ROUTE 1 — THE DECLARED RUNG. A role whose pack has a rung that MEANS "fresher" declares it
 * ({@link RoleFresherVocabulary.tenureValue}); today that is `qp_cad_drafting` alone, whose
 * `fresher_course` rung reads "Course kiya hai, kaam ka tajurba nahi". Ungated, exactly as it
 * shipped: the worker said the word himself, so nothing else needs to be true.
 *
 * ROUTE 2 — THE LOWEST RUNG, FOR A WORKER WITH NO WORK HISTORY AT ALL. Owner ruling: "In resume
 * for freshers (someone not added work experience) 'duration not stated' is written, I want
 * 'Fresher' mentioned there." Twenty of the twenty-one roles have no `fresher_course` rung, so
 * route 1 could never fire for them and every genuine fresher on those forms printed the unknown
 * text over the top of his own résumé.
 *
 * IT IS THE RULE THIS FILE PREVIOUSLY REFUSED, AND THE REFUSAL IS ANSWERED RATHER THAN DELETED.
 * `RoleFresherVocabulary.tenureValue` records the objection: on the other packs the lowest rung
 * is `under_one` ("1 saal se kam"), so a bare "0 means fresher" rule would print "Fresher" over a
 * man with eleven months on a shop floor and delete real experience from his own sheet. That
 * objection is met by the two conjuncts rather than waived:
 *
 *   • NO EMPLOYMENT ROWS — `hasEmployments` is false, i.e. the worker has added no work history.
 *     That is the owner's own definition of the worker this is for, and it is what keeps the
 *     word off a sheet that prints an employer block three rows down.
 *   • NO STATED FIGURE — enforced one level up in `tenurePhrase`, which reads a label only where
 *     there is no number at all. His eleven months print as "11 mo" the moment he states them.
 *
 * So the word appears only where the alternative is "duration not stated" on a worker who has
 * told us, through the one question his form makes mandatory, that he has under a year and no
 * job to show for it. §11 #3 still governs everyone else: a worker who answered any higher rung,
 * or whose pack is unknown, still gets the honest unknown.
 *
 * ── THE RESIDUAL RISK, STATED RATHER THAN LEFT TO BE DISCOVERED ───────────────────────
 *
 * THE ELEVEN-MONTH MAN ON A FORM-FIRST PATH CANNOT CURRENTLY CLEAR IT. "He states his months and
 * the figure wins" is true of the mechanism and not yet true of his product surface: the
 * universal `experience_years` ask never runs for a worker handed the form on his first message
 * (which is why `employedYears` exists as a fallback at all), the finishing form has no
 * experience key, and the only remaining channel is the dated employment rows — the very screen
 * this rule reads as empty. So for him "under a year, nothing filed" is not merely the trigger,
 * it is the whole of what the system knows, and he prints as "Fresher" alongside a genuine
 * pass-out. The owner ruling was taken with the alternative in view: today that same man prints
 * "duration not stated", which in this market reads as something withheld.
 *
 * THE FOLLOW-UP THAT WOULD END THE INFERENCE is a corpus change, not a renderer one: give the
 * eight non-drafting packs a real bottom rung — "koi tajurba nahi" beside "1 saal se kam", the
 * shape `qp_cad_drafting` already has — and declare it as {@link RoleFresherVocabulary.tenureValue}.
 * Route 1 then covers every role, this route can be deleted, and the word rests on a chip the
 * worker tapped rather than on a screen he skipped.
 */
export function fresherTenureLabel(
  packId: string | null,
  attributes: WorkerAttributeValues,
  /**
   * True when the worker's work history was READ and is EMPTY — never when it is merely absent.
   *
   * THE DISTINCTION IS THE FAIL-CLOSED RULE, and it is why this is not `hasEmployments` negated.
   * Both callers load `worker_employment` inside a try/catch that degrades to `[]`, because a
   * failed read must cost Zone 4 and not the whole PDF. Under a naive negation that degrade also
   * turns a twelve-year turner into a fresher on his own résumé — an infrastructure miss putting
   * a claim on the page, which is the one thing the processor's own comments say must never
   * happen. So the caller answers "did we actually look?", and a failure answers `false`: the
   * sheet falls back to §11 #3's honest unknown, which is exactly what it printed yesterday.
   *
   * REQUIRED, NOT OPTIONAL, and that is the same argument `buildFresherRows`' `packId` makes: an
   * optional flag defaulting either way would let a call site get the wrong rule by forgetting
   * it, and both wrong rules are silent — `false` withholds the word from the workers the ruling
   * is for, `true` prints it over a man with an employment history.
   */
  filedNoWorkHistory: boolean,
): string | null {
  if (packId === null) return null;
  // STRICT EQUALITY ON A NUMBER, deliberately, on both routes. `pack-registry.service.ts::
  // toOption` resolves `value_text ?? value_number ?? value_bool`, so a numeric rung arrives as
  // a number; a string "0" would be a different pack shape and is not silently coerced into a
  // fresher claim.
  const declared = FRESHER_TENURE[packId];
  if (declared !== undefined && attributes[declared.question] === declared.value) {
    return FRESHER_LABEL;
  }
  // ROUTE 2. A worker with employment rows has a history on the page and cannot be described as
  // a fresher beside it, whatever rung he tapped — the contradiction resolves towards what he
  // actually filed, never towards the label. A history we could not READ is treated the same way,
  // and for a stronger reason: see the parameter.
  if (!filedNoWorkHistory) return null;
  const gate = TENURE_GATE[packId];
  return gate !== undefined && attributes[gate] === NO_EXPERIENCE_RUNG ? FRESHER_LABEL : null;
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
): ResumeExperienceLine[] {
  const workshopMachines = packId === null ? undefined : WORKSHOP_MACHINES[packId];
  const tradeTests = packId === null ? undefined : TRADE_TEST[packId];
  if (workshopMachines === undefined && tradeTests === undefined) return [];

  const machines = slugsOf(attributes.iti_workshop_machines)
    .map((slug) => workshopMachines?.[slug])
    .filter((v): v is string => Boolean(v))
    .slice(0, MAX_WORKSHOP_MACHINES);
  const tradeTest = tradeTests?.[scalar(attributes.trade_test_status) ?? ""] ?? null;
  const project = scalar(attributes.iti_project_work);

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
