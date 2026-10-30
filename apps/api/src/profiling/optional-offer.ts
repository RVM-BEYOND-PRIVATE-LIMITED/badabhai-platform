import { parseAffirmation } from "@badabhai/profiling-lexicon";

/**
 * The optional-depth OFFER (Middle-Way C2 stop rule, P3b) — "2 minute more?".
 *
 * The shape is the trade-form offer's (`trade-form-offer.ts`), deliberately:
 * one question, two chips, one reader. The differences are the point of this
 * file rather than a shared abstraction:
 *
 * - The OFFER IS NOT A GATE, in the other direction from the form's. Declining
 *   the form offer resumes the interview; declining THIS offer ENDS it
 *   (required_complete) — the worker said the profile is done, and there is
 *   nothing behind the offer but optional depth.
 * - Accepting CONTINUES the same interview (optional until the 20-turn cap or
 *   drain), where accepting the form offer leaves it. No handover, no phase
 *   change, no new surface.
 * - An unreadable reply is a DECLINE, never a re-ask — the same posture as the
 *   form offer: the offer is a question and re-asking one the worker did not
 *   answer spends the ask twice.
 */

/** The bubble. Bas-ho-gaya first (the 8 are done), then the one offer. */
export const OPTIONAL_OFFER_PROMPT_TEXT =
  "Bas ho gaya. Resume ban raha hai. 2 minute aur dein? Resume aur strong banega.";

/** The two chips. A binary question gets a binary affordance. */
export const OPTIONAL_OFFER_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "optional_offer_yes",
    label_text: "Haan, 2 minute aur",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "optional_offer_no",
    label_text: "Nahi, bas ho gaya",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

export type OptionalOfferReply = "accept" | "decline" | "unclear";

/** What the worker's reply means. `unclear` is a DECLINE, never a re-ask. */
export function readOptionalOfferReply(text: string): OptionalOfferReply {
  const chip = OPTIONAL_OFFER_OPTIONS.find((option) => option.option_key === text.trim());
  if (chip) return chip.value ? "accept" : "decline";

  const parsed = parseAffirmation(text);
  if (parsed === null) return "unclear";
  return parsed.value ? "accept" : "decline";
}
