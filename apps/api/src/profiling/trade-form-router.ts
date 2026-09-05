/**
 * WHICH TRADES HAND THE INTERVIEW OVER TO A FORM, and on what evidence.
 *
 * THE FLOW THIS SERVES. Phase A talks to a worker until it can name their trade. For most trades
 * the conversation then continues into the template packs. For a few — the ones whose
 * employability lives in a long list of closed facts rather than in anything a worker would say
 * unprompted — a conversation is the wrong instrument: a CNC turner's sheet turns on which
 * controllers, which materials, which tolerance band, what they can SET versus only run. Asking
 * eighteen closed questions one bubble at a time spends the ask budget on typing. So the
 * interview stops and the worker gets a form.
 *
 * AI PROPOSES, CODE DECIDES (§3). The model contributes two free-text LABELS — `domain_label` and
 * `role_label` — and nothing else. This module is the deterministic half: a closed table, a pure
 * function, no network, no model, and a result that is the same every time for the same input. A
 * model that hallucinated "CNC Turner" for a bus driver still cannot route one here, because the
 * routing evidence is checked rather than trusted.
 *
 * ── THE TWO-TIER EVIDENCE RULE, AND WHY IT IS NOT ONE LIST ──────────────────────────────────
 *
 * `apps/ai-service/app/profiling/signals.py` deleted its `<machine> + <function>` mapping
 * ("lathe operator" → `role_cnc_turner_operator`) because it FABRICATED A SPECIALISATION: a man
 * who runs a lathe has told you about a machine, not about which of the four occupations built
 * around that machine is his. That rule is load-bearing and this module keeps it.
 *
 *   OCCUPATION TERMS  name the occupation itself — "turner", "turning". A worker who says one has
 *                     claimed the specialisation, so the term routes on its own.
 *   MACHINE TERMS     name only the equipment — "lathe", "khraad". These route ONLY when
 *                     retrieval has independently pinned the turning family, so the machine word
 *                     is corroboration rather than the whole case.
 *   CONFLICT TERMS    name a COMPETING specialisation — "vmc", "milling", "machining centre". Any
 *                     of them vetoes the route outright, whatever else matched.
 *
 * WHY CONFLICT IS A VETO AND NOT A SCORE. "CNC Turner cum VMC Operator" is a real thing a real
 * worker says, and it is precisely the case where a form built for turning would ask the wrong
 * eighteen questions. The honest answer to an ambiguous trade is to keep talking, so an ambiguous
 * label falls through to the interview that already handles it. Failing closed costs a worker a
 * few more turns; failing open costs them the sheet.
 *
 * ADDING THE SECOND TRADE IS A ROW, NOT A BRANCH. Everything below the table is generic.
 */
import type { LlmInterviewDraft } from "@badabhai/ai-contracts";

import {
  conflictTermsForKind,
  TRADE_FORM_KINDS,
  descriptorForKind,
  ENABLED_ROLE_DESCRIPTORS,
  type TradeFormKind,
} from "./roles/role-registry";

/**
 * The forms that exist. A kind here must have a form schema behind it — an entry with no form is
 * an interview that stops and hands the worker nothing.
 *
 * DERIVED FROM THE ROLE REGISTRY, not authored here any more. `role-registry.ts` filters to the
 * roles whose forms actually ship, so a role can be DESCRIBED (and contribute its vocabulary to
 * everybody else's veto) long before it can be routed to.
 */
export { TRADE_FORM_KINDS } from "./roles/role-registry";
export type { TradeFormKind };

interface TradeFormRoute {
  readonly kind: TradeFormKind;
  /**
   * The family retrieval must have pinned for a MACHINE or LEVEL term to count. Never consulted
   * for an occupation term: a worker who says "turner" has named their own trade, and requiring a
   * pin as well would strand every worker whose phrasing retrieval could not resolve.
   */
  readonly corroboratingFamilyId: string;
  /** Names the occupation. Routes on its own. */
  readonly occupationTerms: readonly string[];
  /**
   * Names only the equipment, or a RUNG of this role's level ladder. Routes only alongside
   * {@link corroboratingFamilyId}.
   *
   * THE TWO TIERS MERGE HERE BECAUSE THEY ROUTE IDENTICALLY, and they are kept apart on the
   * descriptor because they DERIVE differently: a machine word is another role's veto, a level
   * word is shared vocabulary that must never veto anybody. Once conflict derivation has run,
   * the distinction has done its job and both are simply corroborated evidence.
   */
  readonly corroboratedTerms: readonly string[];
  /** Names a competing specialisation. Vetoes the route. */
  readonly conflictTerms: readonly string[];
}

/**
 * THE TABLE IS NOW COMPUTED FROM `role-registry.ts` and this file authors none of it. The terms
 * live on each role's descriptor, beside that role's pack id, family id, level ladder and sheet
 * vocabulary, so the twenty facts that describe one trade sit together instead of in eleven
 * files. What stays here is the RULE — two tiers of evidence and a veto — which is identical for
 * every trade and was never per-trade data.
 *
 * Devanagari sits beside the Latin spellings in those descriptors because the labels are the
 * MODEL's words, not the pack's. The persona constrains `reply_text` to Latin-script Hinglish; it
 * says nothing about the draft, and a model handed a Devanagari answer has every reason to echo
 * the worker's script back into `role_label`. A table that only spelled these in Latin would
 * route a worker who typed Hinglish and drop the one who spoke Hindi, which is the wrong worker
 * to lose.
 */
const TRADE_FORM_ROUTES: readonly TradeFormRoute[] = ENABLED_ROLE_DESCRIPTORS.map((descriptor) => ({
  kind: descriptor.kind,
  corroboratingFamilyId: descriptor.familyId,
  occupationTerms: descriptor.detection.occupationTerms,
  corroboratedTerms: [...descriptor.detection.machineTerms, ...descriptor.detection.levelTerms],
  conflictTerms: conflictTermsForKind(descriptor.kind),
}));

/**
 * Lowercase, strip everything that is not a letter or digit, collapse runs, and pad with single
 * spaces so a term can be matched on whole-token boundaries.
 *
 * PADDED RATHER THAN REGEX-ESCAPED because the terms are a closed literal table in this file, not
 * anything a worker or a model supplies. `\b` would also be wrong here: it is defined on ASCII
 * word characters, so it does not fire between a Devanagari character and a space, and the
 * Devanagari terms would silently never match.
 *
 * `\p{M}` IS LOAD-BEARING, and omitting it is a bug this module was written with. Devanagari
 * builds a syllable from a consonant plus combining marks — the AA in खराद (U+093E) and the
 * virama in टर्नर (U+094D) are both category `Mn`, not `L`. A class of `\p{L}\p{N}` alone strips
 * them, so खराद normalises to खरद, every Devanagari term in the table becomes unmatchable, and
 * the failure is SILENT: the router simply never routes a worker who spoke Hindi. The unit table
 * catches it, which is why those cases are in it.
 */
function normalise(value: string | null | undefined): string {
  if (!value) return "";
  const stripped = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
  return stripped.length === 0 ? "" : ` ${stripped} `;
}

function containsAny(haystack: string, terms: readonly string[]): boolean {
  if (haystack.length === 0) return false;
  return terms.some((term) => haystack.includes(` ${term} `));
}

export interface TradeFormRouteInput {
  /** Phase A's draft. Only the two labels are read; skills and experiences are not evidence. */
  readonly draft: LlmInterviewDraft;
  /** The family retrieval pinned, when it pinned one. */
  readonly occupationFamilyId: string | null;
  /**
   * The CATALOGUE label retrieval pinned — `OccupationPin.label`, not anything the model wrote.
   *
   * WHY IT IS HERE AT ALL. Without it the router could only read labels the MODEL had got round
   * to filling in, and a model that answers "cnc turning" by asking a follow-up question before
   * populating `domain_label` costs the worker an extra question they had already answered. That
   * is exactly what happened in production: the interview asked which materials a CNC turner cuts
   * and only handed over on the turn after. The pin, by contrast, is derived from the worker's own
   * first sentence through a closed catalogue with a confidence gate, so it is available on the
   * SAME turn they say what they do.
   *
   * IT IS EVIDENCE, NOT AN OVERRIDE. It joins the same haystack the model's labels do and is read
   * by the same two rules — so it can only route a worker whose catalogue label actually says
   * turner, turning or lathe, and the conflict terms veto it exactly as they veto the model. A
   * mis-pin still cannot end an interview on its own: a cashier pinned into the turning family
   * contributes the label "Cashier", which matches nothing.
   */
  readonly occupationLabel?: string | null;
  /**
   * The worker's own message this turn, read for CONFLICT TERMS AND NOTHING ELSE.
   *
   * ASYMMETRIC ON PURPOSE, and the asymmetry is the whole safety argument. Raw worker text may
   * only ever make this router MORE reluctant to hand over; it can never cause a handover. So
   * "cnc turning ka kaam dhoondh raha hoon" cannot route anybody, while "cnc turning aur vmc
   * dono karta hoon" stops a handover that would otherwise have happened.
   *
   * WHY IT IS NEEDED. Retrieval pins the longest exact alias span it finds, so that second worker
   * pins cleanly on "cnc turning" — bare "vmc" is not an alias, contributes no rival candidate,
   * and the pin comes back `auto` at 0.97. The label is then "CNC Operator-Turning", which carries
   * no conflict term, and the model's draft is still empty. Every surface the veto could read said
   * "turner"; the only place the worker's own "vmc" appeared was the sentence they typed, which
   * this router could not see. They would have been handed eighteen turning questions having just
   * said out loud that they run a machining centre too.
   *
   * NEVER READ FOR ROUTING. Matching occupation or machine terms against free text is exactly the
   * machine-plus-function fabrication this module documents at the top and refuses to do.
   */
  readonly workerText?: string | null;
}

/**
 * Does this interview hand over to a form, and to which one?
 *
 * `null` means "keep interviewing" and is the answer for every trade that has no form, every
 * ambiguous label, and every case where the model gave us nothing to read. It is the safe answer
 * and it is the common one.
 *
 * BOTH LABELS ARE READ AS ONE STRING. A model that puts "CNC Turning" in `domain_label` and
 * "Operator" in `role_label` has told us the same thing as one that puts "CNC Turner" in the
 * role — splitting the evidence by field would make the route depend on the model's formatting
 * taste. Conflict terms are searched over the same joined string for the same reason.
 *
 * THE PINNED LABEL JOINS THAT STRING — see {@link TradeFormRouteInput.occupationLabel}. It is
 * the only piece of evidence here that does not come from the model, and it is what lets the
 * handover happen on the turn the worker names their trade rather than the turn after.
 */
export function routeToTradeForm(input: TradeFormRouteInput): TradeFormKind | null {
  const haystack = normalise(
    `${input.draft.domain_label ?? ""} ${input.draft.role_label ?? ""} ` +
      `${input.occupationLabel ?? ""}`,
  );
  if (haystack.length === 0) return null;

  // THE VETO READS ONE MORE THING THAN THE ROUTE DOES — see `workerText`. Two haystacks rather
  // than one because the extra text is only ever allowed to withhold a handover, never to cause
  // one; merging them would silently let free text route a worker.
  const vetoHaystack = normalise(
    `${input.draft.domain_label ?? ""} ${input.draft.role_label ?? ""} ` +
      `${input.occupationLabel ?? ""} ${input.workerText ?? ""}`,
  );

  for (const route of TRADE_FORM_ROUTES) {
    if (containsAny(vetoHaystack, route.conflictTerms)) continue;
    if (containsAny(haystack, route.occupationTerms)) return route.kind;
    if (
      input.occupationFamilyId === route.corroboratingFamilyId &&
      containsAny(haystack, route.corroboratedTerms)
    ) {
      return route.kind;
    }
  }
  return null;
}

/**
 * What the worker is shown on the turn the interview hands over.
 *
 * COPY LIVES BESIDE THE ROUTING TABLE, not in the orchestrator, because it is per-trade DATA in
 * exactly the way the route is: the second trade adds a row here too, and an orchestrator that
 * held the strings would need a branch per form.
 *
 * `reply` is the chat bubble and the TTS line — it goes into the transcript and is read aloud, so
 * it is a whole sentence in the worker's register. `headline` and `ctaLabel` are the card the
 * client draws over it. Splitting them is what lets a client with no card fall back to a reply
 * that still makes sense on its own.
 */
export interface TradeFormOffer {
  readonly kind: TradeFormKind;
  readonly reply: string;
  readonly headline: string;
  readonly ctaLabel: string;
}

/**
 * The CTA is IDENTICAL FOR EVERY TRADE, and only the noun changes.
 *
 * That is why the copy is composed rather than authored twenty-one times. "Form bharkar resume
 * pura karein" says what the button does, which does not depend on the trade; the trade appears
 * once, in the headline, as the thing we have recognised. Authoring each variant by hand would
 * produce twenty-one near-identical strings that drift the first time somebody improves one of
 * them, and every one of them would have to be re-checked against the persona rules.
 *
 * `offerName` RATHER THAN `displayName` — see the descriptor. The sheet prints a title-cased job
 * title; this is a sentence spoken to a worker.
 */
const FORM_CTA_LABEL = "Form bharkar resume pura karein";

/**
 * Sentence case for the FIRST character only — because `offerName` is sentence-cased for the
 * MIDDLE of a sentence and this is the one place it starts one.
 *
 * ═══ THE BUG THIS FIXES, AND WHY FIVE ROLES HID IT ═══
 *
 * The headline is `${offerName} profile detected`, and every Batch 1 role's offerName begins with
 * an acronym — "CNC turner", "CNC machining centre operator", "CAM programmer", "CAD draughtsman".
 * All four therefore started with a capital by accident of the trade's name, and the composition
 * looked correct for a year. Batch 2's roles are ordinary nouns, and the same line produced
 * "welder profile detected", "tool and die maker profile detected" and "conventional machinist
 * profile detected" — a sentence beginning in lower case, on the one card the worker reads at the
 * moment we tell them we recognised their trade.
 *
 * ═══ WHY THE FIX IS HERE AND NOT ON THE DESCRIPTOR ═══
 *
 * Capitalising `offerName` itself would be wrong: the descriptor documents it as the form that
 * appears INSIDE a worker-facing sentence, and it is deliberately not `displayName` precisely so
 * the card does not read like a form field. The casing belongs to the SENTENCE, so it is applied
 * where the sentence is built.
 *
 * ═══ ZERO REGRESSION, WHICH IS CHECKABLE RATHER THAN ASSERTED ═══
 *
 * All five shipped headlines already begin with an uppercase letter, so this leaves every one of
 * them byte-identical — which matters because the Flutter contract test pins the shipped copy
 * exactly. `toUpperCase()` on an already-uppercase character is the identity.
 */
function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export const TRADE_FORM_OFFERS: Readonly<Record<TradeFormKind, TradeFormOffer>> = Object.freeze(
  Object.fromEntries(
    ENABLED_ROLE_DESCRIPTORS.map((descriptor) => {
      const headline = sentenceCase(`${descriptor.offerName} profile detected`);
      return [
        descriptor.kind,
        {
          kind: descriptor.kind,
          reply: `${headline}. Ab ${FORM_CTA_LABEL.toLowerCase()}.`,
          headline,
          ctaLabel: FORM_CTA_LABEL,
        } satisfies TradeFormOffer,
      ];
    }),
  ),
) as Readonly<Record<TradeFormKind, TradeFormOffer>>;

/** Narrow an untrusted (Redis-round-tripped) value back to an offer. */
export function narrowTradeFormOffer(value: unknown): TradeFormOffer | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  const match = TRADE_FORM_KINDS.find((candidate) => candidate === kind);
  // REBUILT FROM THE TABLE RATHER THAN READ OFF THE STORED OBJECT. The copy is ours, not the
  // session's: replaying a headline that a since-retired build wrote would put words on screen
  // that no longer exist anywhere in the source. Only the KIND survives the round trip.
  return match === undefined ? null : TRADE_FORM_OFFERS[match];
}

/**
 * Which question-pack FAMILY backs a form.
 *
 * THE SAME VALUE the route table already holds for corroboration, exposed under its second
 * meaning rather than duplicated. The two are the same fact — "this is the turning family" —
 * and a second table would be free to disagree with the first the day a family is renamed.
 */
export function familyForTradeForm(kind: TradeFormKind): string {
  const descriptor = descriptorForKind(kind);
  // Unreachable while `TRADE_FORM_KINDS` is derived from the same registry; asserted so a role
  // removed from the registry without its kind fails loudly instead of serving an empty form.
  if (!descriptor) throw new Error(`no trade-form route for ${kind}`);
  return descriptor.familyId;
}
