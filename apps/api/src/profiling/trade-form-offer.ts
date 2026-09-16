import { parseAffirmation } from "@badabhai/profiling-lexicon";

import { TRADE_FORM_OFFERS, type TradeFormKind } from "./trade-form-router";

/**
 * The trade-form OFFER turn (Task 1 recall path; owner ruling 2026-09-16).
 *
 * ── WHAT CHANGED, AND WHY ────────────────────────────────────────────────────────────────
 *
 * The mid-chat handover used to be a GATE: the moment `routeToTradeForm` recognised a
 * form-enabled trade, the interview closed and the worker was pushed onto the form,
 * whether or not they wanted it. The ruling is OFFER: deterministic code still decides
 * ELIGIBILITY (the router is unchanged), and the WORKER makes the choice. This module is
 * the whole of that choice — one question, two chips, one reader.
 *
 * ── THE OFFER IS NOT A GATE, IN EITHER DIRECTION ─────────────────────────────────────────
 *
 * Declining does not block anything: the interview continues exactly where it left off on
 * the same bubble, and the offer is never served twice (`formOfferPrompt` settles on the
 * first reply, whatever it says). Accepting runs the SAME handover the gate used to run —
 * `completeFormHandover` settles Phase A's draft first, so the form does not open by
 * asking the worker the one question they have already answered.
 *
 * ── THE REPLY READER IS THE SAME BINARY READER AS EVERYWHERE ELSE ────────────────────────
 *
 * `parseAffirmation` is the lexicon's one yes/no parser, the same one the résumé
 * batch-confirm reads and the 236 boolean pack items use. A second haan/nahi list here
 * would be free to disagree with the shipped one the day somebody improves it. An
 * unreadable reply is a DECLINE, never a re-ask: the offer is a question, and re-asking a
 * question the worker did not answer spends the ask twice.
 */

/**
 * The two chips.
 *
 * CHIPS AND NOT A FREE ANSWER, for the résumé-confirm's reason: the question is genuinely
 * binary and a tap is the cheapest thing a worker on a mid-range Android between shifts
 * can do. {@link readFormOfferReply} still reads typed and spoken replies — the chips are
 * the affordance, not the contract.
 */
export const FORM_OFFER_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "form_offer_yes",
    label_text: "Haan, form bharein",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "form_offer_no",
    label_text: "Nahi, chat mein poora karein",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

export type FormOfferReply = "accept" | "decline" | "unclear";

/**
 * The bubble. The handover's own headline, then the question the ruling added.
 *
 * NOT GENERATED, and not persona-checked for that reason — reviewed server copy in the
 * same class as the handover's and the résumé-confirm's. The headline comes from
 * `TRADE_FORM_OFFERS` so the trade name a worker reads is spelled one way in the offer and
 * in the handover card that follows an accept.
 */
export function offerPrompt(kind: TradeFormKind): string {
  return `${TRADE_FORM_OFFERS[kind].headline}. Form bharkar resume pura karna chahenge?`;
}

/**
 * What the worker's reply means.
 *
 * `unclear` IS A REAL OUTCOME AND IS NOT AN ACCEPT — the exact posture `readConfirmReply`
 * documents: a reply this cannot read must never be taken as a yes, because that would
 * close an interview and move a worker onto a form off a sentence nobody understood.
 */
export function readFormOfferReply(text: string): FormOfferReply {
  const chip = FORM_OFFER_OPTIONS.find((option) => option.option_key === text.trim());
  if (chip) return chip.value ? "accept" : "decline";

  const parsed = parseAffirmation(text);
  if (parsed === null) return "unclear";
  return parsed.value ? "accept" : "decline";
}
