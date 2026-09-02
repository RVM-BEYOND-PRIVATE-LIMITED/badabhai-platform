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
      // THE ROLE IS A LITERAL, not a claim about him. "ITI workshop training" is what the block
      // IS; it is not a job title he is asserting and it cannot be read as employment because it
      // carries no employer and no dates.
      role: "ITI workshop training",
      // §11 #3's rule does not apply: this is not a tenure he stated and failed to have recorded,
      // it is a block that has no duration by nature. An empty string collapses the span.
      duration: "",
      work,
    },
  ];
}
