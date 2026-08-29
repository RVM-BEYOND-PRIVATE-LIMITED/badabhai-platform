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

/**
 * The forms that exist. A kind here must have a form schema behind it — an entry with no form is
 * an interview that stops and hands the worker nothing.
 */
export const TRADE_FORM_KINDS = ["cnc_turner"] as const;
export type TradeFormKind = (typeof TRADE_FORM_KINDS)[number];

interface TradeFormRoute {
  readonly kind: TradeFormKind;
  /**
   * The family retrieval must have pinned for a MACHINE term to count. Never consulted for an
   * occupation term: a worker who says "turner" has named their own trade, and requiring a pin
   * as well would strand every worker whose phrasing retrieval could not resolve.
   */
  readonly corroboratingFamilyId: string;
  /** Names the occupation. Routes on its own. */
  readonly occupationTerms: readonly string[];
  /** Names only the equipment. Routes only alongside {@link corroboratingFamilyId}. */
  readonly machineTerms: readonly string[];
  /** Names a competing specialisation. Vetoes the route. */
  readonly conflictTerms: readonly string[];
}

/**
 * Devanagari sits beside the Latin spellings because the labels are the MODEL's words, not the
 * pack's. The persona constrains `reply_text` to Latin-script Hinglish; it says nothing about the
 * draft, and a model handed a Devanagari answer has every reason to echo the worker's script back
 * into `role_label`. A table that only spelled these in Latin would route a worker who typed
 * Hinglish and drop the one who spoke Hindi, which is the wrong worker to lose.
 */
const TRADE_FORM_ROUTES: readonly TradeFormRoute[] = [
  {
    kind: "cnc_turner",
    corroboratingFamilyId: "fam_cnc_turning",
    occupationTerms: ["turner", "turning", "cnc turner", "टर्नर", "टर्निंग"],
    machineTerms: ["lathe", "cnc lathe", "khraad", "kharad", "khrad", "खराद", "लेथ"],
    conflictTerms: [
      "vmc",
      "hmc",
      "milling",
      "miller",
      "mill",
      "machining centre",
      "machining center",
      "grinding",
      "grinder",
      "drilling",
      "edm",
      "wire cut",
      "मिलिंग",
    ],
  },
];

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
 */
export function routeToTradeForm(input: TradeFormRouteInput): TradeFormKind | null {
  const haystack = normalise(`${input.draft.domain_label ?? ""} ${input.draft.role_label ?? ""}`);
  if (haystack.length === 0) return null;

  for (const route of TRADE_FORM_ROUTES) {
    if (containsAny(haystack, route.conflictTerms)) continue;
    if (containsAny(haystack, route.occupationTerms)) return route.kind;
    if (
      input.occupationFamilyId === route.corroboratingFamilyId &&
      containsAny(haystack, route.machineTerms)
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

export const TRADE_FORM_OFFERS: Readonly<Record<TradeFormKind, TradeFormOffer>> = {
  cnc_turner: {
    kind: "cnc_turner",
    reply: "CNC turner profile detected. Ab form bharkar resume pura karein.",
    headline: "CNC turner profile detected",
    ctaLabel: "Form bharkar resume pura karein",
  },
};

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
  const route = TRADE_FORM_ROUTES.find((candidate) => candidate.kind === kind);
  // Unreachable while `TradeFormKind` is derived from the same table; asserted so an entry
  // removed from the table without its kind fails loudly instead of serving an empty form.
  if (!route) throw new Error(`no trade-form route for ${kind}`);
  return route.corroboratingFamilyId;
}
