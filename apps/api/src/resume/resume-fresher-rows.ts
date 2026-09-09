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
 * The tier-gate rung at which a worker starts CLAIMING a year or more (`one_to_three` on every
 * pack in the corpus).
 *
 * IT IS READ ONLY TO WITHHOLD A WORD, NEVER TO PRINT ONE, and that distinction is the whole of
 * what this constant is for. The 2026-09-09 ruling is explicit that total experience is not a
 * range taken from any question — it is the sum of the work history the worker filled in — so
 * nothing derived from this gate reaches the page. What the gate can still do is stop the sheet
 * calling a man a fresher when his own form says he has years: a rung at or above this one means
 * "Fresher" is withheld and §11 #3's honest unknown prints instead.
 *
 * IT GOES INERT, CORRECTLY, IF THE GATE IS DELETED. The question is under review for removal from
 * the form; with no rung stored, a worker who filed no work history simply reads "Fresher", which
 * is the ruling with nothing left to qualify it.
 */
const CLAIMS_A_YEAR_OR_MORE = 2;

/**
 * "Fresher" — the tenure segment's text for a worker with no work history, or null.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * WHAT TOTAL EXPERIENCE IS, AND WHAT THIS IS NOT (owner ruling 2026-09-09).
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * "This is not how experience is calculated, it is not a range taken from any question. It is
 * calculated from the work history that is filled by the individual and the total calculated from
 * the work history itself" — 1 yr 2 mo + 10 mo + 2 yrs is 4 years.
 *
 * SO THE FIGURE IS NOT THIS FUNCTION'S BUSINESS AT ALL. It is `totalEmployedYears`, summed from
 * the worker's own dated employments, and `resume-render-input.ts` now feeds it to BOTH mapper
 * branches — the defect this ruling surfaced was that the form-first branch never read it. An
 * earlier revision of this file printed the gate's rungs as bands ("1–3 yrs", "7+ yrs"); that is
 * exactly the "range taken from a question" the ruling rejects, and it is gone.
 *
 * WHAT IS LEFT IS ONE WORD, FOR ONE WORKER. A man who has filed no work history has no experience
 * for the sum to find, and the owner's standing definition of a fresher is "someone not added work
 * experience". So:
 *
 *   1. A DECLARED fresher chip — a role whose pack has an option that SAYS "no experience"
 *      ({@link RoleFresherVocabulary.tenureValue}, today `qp_cad_drafting` alone). Ungated by work
 *      history, exactly as it shipped: he said the word himself.
 *   2. NO WORK HISTORY FILED → "Fresher", unless his own form claims a year or more (see
 *      {@link CLAIMS_A_YEAR_OR_MORE}) — the sheet must not call a self-declared seven-year man a
 *      fresher, and it must not invent a figure for him either, so it says nothing and §11 #3's
 *      text prints.
 *   3. A WORK HISTORY EXISTS → null, always. Either it is dated and the SUM speaks, or it is not
 *      and "duration not stated" is the honest line for a tenure the worker could not give.
 *
 * BOUNDED TO PACK WORKERS. A legacy chat profile with no pack was never asked any of this, and
 * reading its empty employment list as "fresher" would relabel the whole back catalogue on the
 * strength of a question nobody put to it.
 */
export function tenureStatusLabel(
  packId: string | null,
  attributes: WorkerAttributeValues,
  /**
   * True when the worker's work history was READ and is EMPTY — never when it is merely absent.
   *
   * THE DISTINCTION IS THE FAIL-CLOSED RULE. Both callers load `worker_employment` inside a
   * try/catch that degrades to `[]`, because a failed read must cost Zone 4 and not the whole PDF.
   * Under a naive negation that degrade would relabel a twelve-year turner "Fresher" on his own
   * résumé — an infrastructure miss putting a claim on the page. So the caller answers "did we
   * actually look?", and a failure answers `false`: the sheet says "duration not stated", which is
   * what it said before the read failed.
   */
  filedNoWorkHistory: boolean,
): string | null {
  if (packId === null) return null;

  // STRICT EQUALITY ON A NUMBER. `pack-registry.service.ts::toOption` resolves
  // `value_text ?? value_number ?? value_bool`, so a numeric rung arrives as a number; a string
  // "0" would be a different pack shape and is not silently coerced into a claim about a worker.
  const declared = FRESHER_TENURE[packId];
  const gate = TENURE_GATE[packId];
  const answered = gate === undefined ? undefined : attributes[gate];

  // 1. The role's own declared fresher chip — his statement, and it outranks everything here.
  if (declared !== undefined && answered === declared.value) return FRESHER_LABEL;

  // 3, checked before 2: a work history on the page is the sheet's answer to "how long", whether
  // the sum could read it or not.
  if (!filedNoWorkHistory) return null;

  // A pack no role claims is not evidence that anything was asked.
  if (gate === undefined) return null;

  // 2. He filed nothing — unless he told the form he has years, in which case the sheet withholds
  // the word rather than contradicting him.
  if (typeof answered === "number" && answered >= CLAIMS_A_YEAR_OR_MORE) return null;
  return FRESHER_LABEL;
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
