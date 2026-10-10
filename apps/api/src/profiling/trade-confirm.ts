import { DISAMBIGUATION_ESCAPE_KEY, DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";
import { normalizeOccupationText, parseAffirmation } from "@badabhai/profiling-lexicon";

/**
 * THE TRADE-CONFIRM GATE — "<trade> — kya aap yahi kaam karna chahte hain?" [Haan] [Nahi].
 *
 * ── WHAT IT IS ───────────────────────────────────────────────────────────────────
 *
 * Phase A (the LLM-led stretch) infers the worker's trade into `domain_label` /
 * `role_label`. Before that inference becomes the profile's trade — before the
 * trade-form offer, the lane decision and the draft settlement read it — the worker
 * confirms it. Haan → the interview continues exactly as today. Nahi → the engine
 * asks which trade the worker DOES want ("Aap kis trade mein kaam karna chahte hain?"),
 * the model learns the new trade the same way it learned the first one, and the gate
 * is served again for the new trade. The loop repeats until the worker says Haan.
 *
 * A worker who was always a CNC Turner but now wants to be a CAM programmer answers
 * Nahi to "CNC Turner — kya aap yahi kaam karna chahte hain?", names CAM programming on
 * the re-ask, answers Haan to the next gate, and is profiled as a CAM programmer.
 *
 * ── WHY THE GATE IS OURS AND NOT THE MODEL'S ────────────────────────────────────
 *
 * The same reason the experience gate is (§3, AI never owns a business decision;
 * `llm-reply-guard` documents the failure): which trade the profile is built for is
 * a business decision, and a model-authored twin of the question is a question whose
 * Haan/Nahi produces nothing structured. So the words are fixed here, the model's
 * own attempts at them are caught by `classifyLlmReply`, and the reply is read by
 * code. The prompt (`interview_system_prompt`) tells the model the system asks this
 * itself — the twin instruction to the experience gate's.
 *
 * ── THE PAST TRADE ──────────────────────────────────────────────────────────────
 *
 * A declined trade stays ONLY in the transcript. It is never written into the draft
 * labels again unless the worker restates it, and never as an `experience_entry`
 * unless the worker described that past job with a role, a duration and the work
 * done. The worker adds it as experience later through the ordinary experience flow
 * if they choose to — that is their choice, not the gate's.
 *
 * ── PURE, INERT ─────────────────────────────────────────────────────────────────
 *
 * No I/O, no clock, no logging. The reader sees a worker's words and returns one of
 * three closed values; it never echoes, stores or logs the words themselves (the
 * event spine carries no trade-gate event at all — counts only, in the logs).
 */

/**
 * How many times the gate may be answered Nahi before the engine stops re-asking.
 *
 * FIVE, and the sixth answer is treated as a confirmation. An unbounded loop lets a
 * worker who keeps declining run forever without ever being profiled; a bound of one
 * would profile a worker for a trade they just refused. Five re-asks is far above any
 * ordinary "no, I meant X" correction, and the failure past it is continuing the
 * interview — never trapping the worker.
 */
export const MAX_TRADE_CONFIRM_ROUNDS = 5;

/** The re-ask served after a Nahi — which trade the worker wants instead. */
export const TRADE_DESIRED_PROMPT = "Aap kis trade mein kaam karna chahte hain?";

/**
 * The two chips.
 *
 * SHORT LABELS ON PURPOSE, the same words a worker would type anyway — which is why
 * {@link readTradeConfirmReply} matches the labels themselves. Keys share no prefix
 * with any routed chip set (`skills_gate_*`, `form_offer_*`, `resume_*`,
 * `section_*`, `occ_*`), so a tap here can never answer the wrong question.
 */
export const TRADE_CONFIRM_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "trade_confirm_yes",
    label_text: "Haan",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "trade_confirm_no",
    label_text: "Nahi",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

/**
 * The gate bubble for one inferred trade.
 *
 * `<trade> — kya aap yahi kaam karna chahte hain?` LATIN SCRIPT ONLY, like every other
 * engine line the worker reads (`EXPERIENCE_GATE_PROMPT`'s precedent): the interview speaks
 * Hinglish in Latin letters, and a Devanagari line here would be the one bubble on screen
 * the voice form cannot pre-render and the worker may not read. One question mark (a "?"
 * inside the trade itself is stripped), no exclamation, the "aap" form — the same persona
 * rules every engine line is held to in `persona-copy.test.ts`.
 *
 * DYNAMIC, so it is never in `CONSTANT_REPLIES`: the voice form falls back to
 * on-device TTS for it, exactly as it does for the experience gate.
 */
export function tradeConfirmPrompt(trade: string): string {
  const clean = trade.replace(/[?？!！]/gu, "").replace(/\s+/gu, " ").trim();
  return `${clean} — kya aap yahi kaam karna chahte hain?`;
}

/**
 * What the worker's reply to the gate means.
 *
 *   yes   — Haan: the trade is confirmed, the interview continues as today.
 *   no    — Nahi: the trade is declined; the engine asks {@link TRADE_DESIRED_PROMPT}.
 *   other — neither: the worker answered with the trade itself ("CAM programmer banna
 *           hai") instead of tapping. The caller treats this as a Nahi whose desired
 *           trade is already stated — no re-ask, the model reads it on the same turn.
 *
 * ORDER, first match wins:
 *   1. a chip key, exactly;
 *   2. a chip label, case-insensitive and trimmed ("haan", "HAAN", "Nahi");
 *   3. the "Kuch aur" escape, by label or key — an old build typing at a Haan/Nahi
 *      gate means "something else", which is a Nahi. Without this the words reach
 *      identification as a trade phrase and spend an attempt (the twin of the old
 *      client's model-chip escape, which the orchestrator answers before capture);
 *   4. the lexicon's yes/no (`parseAffirmation`) — a Haan/Nahi ANYWHERE in the reply,
 *      which is what distinguishes "haan" from "haan nahi karna" via the veto;
 *   5. otherwise `other` — including "" and a bare trade name.
 *
 * DELIBERATELY NOT `hasFirstPersonClaim → yes` (the experience gate's rule). There a
 * worker describing another job means YES to "another?"; here a worker describing the
 * trade they want means NO to the trade on screen. A first-person claim with no
 * yes/no cue is `other`, and the caller feeds it to the model as the desired trade.
 */
export type TradeConfirmRead = "yes" | "no" | "other";

export function readTradeConfirmReply(text: string): TradeConfirmRead {
  const trimmed = text.trim();

  const byKey = TRADE_CONFIRM_OPTIONS.find((option) => option.option_key === trimmed);
  if (byKey) return byKey.value ? "yes" : "no";

  const lowered = trimmed.toLowerCase();
  const byLabel = TRADE_CONFIRM_OPTIONS.find(
    (option) => option.label_text.toLowerCase() === lowered,
  );
  if (byLabel) return byLabel.value ? "yes" : "no";

  if (
    normalizeOccupationText(trimmed) === normalizeOccupationText(DISAMBIGUATION_ESCAPE_LABEL) ||
    trimmed.toLowerCase() === DISAMBIGUATION_ESCAPE_KEY.toLowerCase()
  ) {
    return "no";
  }

  const affirmation = parseAffirmation(trimmed);
  if (affirmation !== null) return affirmation.value ? "yes" : "no";
  return "other";
}

/**
 * The trade the draft currently names — `role_label`, else `domain_label` — trimmed,
 * or null when the model has named nothing yet.
 *
 * DRAFT LABELS ONLY, never the deterministic occupation pin: this gate confirms what
 * the MODEL assumed, which is the flow it guards. No pin, no gate.
 */
export function draftTradeLabel(draft: {
  readonly role_label?: string | null;
  readonly domain_label?: string | null;
}): string | null {
  const raw = draft.role_label ?? draft.domain_label ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
