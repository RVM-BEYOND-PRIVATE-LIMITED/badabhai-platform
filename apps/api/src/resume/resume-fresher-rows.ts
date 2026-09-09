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
 * THE TIER GATE's SCALE, as every pack in the corpus writes it: stored value → the English the
 * sheet prints.
 *
 * WHY A VALUE MAP AND NOT AN OPTION-KEY MAP, which is what one would reach for first. The
 * renderer never sees `option_key` — `worker_attributes` stores the option's VALUE and nothing
 * else (`pack-registry.service.ts::toOption` resolves `value_text ?? value_number ?? value_bool`),
 * so the value is the only thing there is to key on. That is also the trap this file has always
 * documented: the same number does not mean the same rung on every pack, which is why 0 is
 * DELIBERATELY ABSENT from this table and resolved by the caller against the role's own
 * declaration.
 *
 * PINNED IN CI RATHER THAN TRUSTED. `role-corpus-parity.guard.test.ts` asserts, for every enabled
 * role, that the gate's options are exactly this scale AND that each option_key sits on the value
 * this table assumes — so a pack authored later that spells "1-3 saal" as 3 goes red there
 * instead of printing the wrong band on a worker's résumé.
 *
 * A RANGE, NEVER A POINT FIGURE. `resume-employment-rows.ts` forbids reading this gate as a
 * NUMBER of years — printing "10 yrs" for "7 saal se zyada" would be a figure nobody stated — and
 * that prohibition is exactly what this respects: "7+ yrs" is the chip the worker tapped, printed
 * as the closed-vocabulary label it is (§8's first permitted source). It never reaches
 * `experienceYears`, which is a number and stays sourced only from a number the worker gave.
 */
const TENURE_RUNG_LABELS: Readonly<Record<number, string>> = {
  1: "Under 1 yr",
  2: "1–3 yrs",
  5: "3–7 yrs",
  10: "7+ yrs",
};

/**
 * The tier-gate value every pack's LOWEST rung stores.
 *
 * IT MEANS TWO DIFFERENT THINGS AND THE CALLER RESOLVES WHICH. On `qp_cad_drafting` it is
 * `fresher_course` — "course kiya hai, kaam ka tajurba nahi", a worker SAYING he has no
 * experience, which is why that role declares it as {@link RoleFresherVocabulary.tenureValue}. On
 * every other pack it is `under_one` — "1 saal se kam", less than a year rather than none.
 *
 * WHAT THE PACKS AGREE WITH, AND WHAT THEY DO NOT — stated exactly, because the difference is the
 * whole risk in reading it as "fresher". The packs DO treat this rung as the fresher tier:
 * `iti_workshop_machines`, `trade_test_status` and `iti_project_work` are served behind
 * `<tenure gate> <= 0` on the machining packs, which is why an `under_one` worker is the one asked
 * about his ITI workshop at all. They do NOT contain a chip in which he says he has no experience.
 * So on those packs the word is an inference from an ask-gate, and the 2026-09-08 ruling is what
 * authorises it — bounded, as `tenureStatusLabel` sets out.
 */
const LOWEST_RUNG = 0;

/** What the lowest rung reads as for a worker who HAS filed a work history. */
const UNDER_ONE_YEAR = TENURE_RUNG_LABELS[1]!;

/**
 * THE TENURE SEGMENT's STATUS TEXT — what §6.2's middle segment says when there is no figure.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL, AND WHY IT GREW (owner rulings 2026-09-08, then 2026-09-09).
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * The segment had exactly two outputs, "N yrs" and §11 #3's "duration not stated", and the second
 * one was reaching workers it was never written for. §11 #3 is about a worker whose tenure NOBODY
 * ASKED — but the 21-role forms ask every worker his tenure, in a MANDATORY question, and then
 * printed "duration not stated" over the answer. The first ruling made the word "Fresher"
 * reachable; the second came with a rendered sheet — a turner who had filed no work history,
 * still reading "CNC turner · duration not stated · Siemens" — and said to fix it.
 *
 * SO THE RULE IS NOW "PRINT WHAT HE ANSWERED", not "print Fresher in one special case". The gate
 * is the only tenure question a form-first worker is ever asked (the universal `experience_years`
 * ask never runs for him — see `employedYears` in `resume-render-input.ts`), so his answer to it
 * is the sheet's best and only source, and every rung of it is now printed:
 *
 *   rung 0  →  "Fresher"      when he filed no work history — the ruling
 *              "Under 1 yr"   when he did — see below
 *   rung 1  →  "Under 1 yr"   (`qp_cad_drafting`'s own `under_one`)
 *   rung 2  →  "1–3 yrs"
 *   rung 5  →  "3–7 yrs"
 *   rung 10 →  "7+ yrs"
 *
 * THE SENIOR WORKER IS THE REASON IT IS NOT SIMPLY "NO WORK HISTORY → FRESHER". Read literally,
 * the ruling would put "Fresher" on the sheet of a man who tapped "7 saal se zyada" and then
 * skipped the work-history screen — deleting seven years of his own stated experience from his own
 * résumé, which is §8.3's asymmetry rule broken in the direction that costs him the job. Printing
 * his rung instead satisfies the ruling's actual complaint (no worker should meet "duration not
 * stated" after answering) without ever contradicting him.
 *
 * ── THE ORDER, AND WHAT EACH STEP COSTS IF IT IS WRONG ────────────────────────────────
 *
 * 1. A DECLARED fresher rung — a role whose pack has a chip that SAYS "no experience"
 *    ({@link RoleFresherVocabulary.tenureValue}, today `qp_cad_drafting` alone). Ungated by work
 *    history, exactly as it shipped: he said the word himself.
 * 2. THE ANSWERED RUNG, as its label. The lowest rung reads "Fresher" only when no work history
 *    was filed; with employer blocks on the page it reads "Under 1 yr", because "Fresher" printed
 *    three rows above a man's own job is a contradiction the sheet cannot defend.
 * 3. NO RUNG ANSWERED, no work history filed, but a KNOWN PACK — "Fresher". This is the ruling
 *    applied to the worker who skipped even the tenure question: he has told the form nothing and
 *    filed no job, and the owner's definition of a fresher is exactly "someone not added work
 *    experience". BOUNDED TO PACK WORKERS deliberately: a legacy chat-only profile with no pack
 *    has not been asked any of this, and §11 #3 still governs it.
 * 4. Otherwise null, and the caller prints "duration not stated" — which now means what it always
 *    should have: nobody asked, or he has a work history whose dates he could not give.
 *
 * A STATED FIGURE STILL OUTRANKS EVERYTHING. `tenurePhrase` consults this only where there is no
 * number at all, so a worker who states six months prints "6 mo" and never a band.
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
   * actually look?", and a failure answers `false`: the lowest rung then reads "Under 1 yr", which
   * is true of him whatever the read did.
   */
  filedNoWorkHistory: boolean,
): string | null {
  if (packId === null) return null;

  // STRICT EQUALITY ON A NUMBER throughout. `pack-registry.service.ts::toOption` resolves
  // `value_text ?? value_number ?? value_bool`, so a numeric rung arrives as a number; a string
  // "0" would be a different pack shape and is not silently coerced into a claim about a worker.
  const declared = FRESHER_TENURE[packId];
  const gate = TENURE_GATE[packId];
  const answered = gate === undefined ? undefined : attributes[gate];

  // 1. The role's own declared fresher chip.
  if (declared !== undefined && answered === declared.value) return FRESHER_LABEL;

  if (typeof answered === "number") {
    // 2. The rung he tapped, as the band it names.
    if (answered === LOWEST_RUNG) return filedNoWorkHistory ? FRESHER_LABEL : UNDER_ONE_YEAR;
    return TENURE_RUNG_LABELS[answered] ?? null;
  }

  // 3. He answered nothing, on a form that asks. See the header.
  //
  // `gate === undefined` IS A PACK NO ROLE CLAIMS, and it takes the same exit as a null one. The
  // ruling reads silence as "fresher" because the FORM asked and he skipped; a pack this registry
  // has never heard of is not evidence that anything was asked at all.
  if (gate === undefined) return null;
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
