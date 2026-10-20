import type { ProfilingTurnUnderstandOutput, QuestionPackItem } from "@badabhai/ai-contracts";

import { isFreeTextItem } from "./none-answer";

/**
 * A TYPED MESSAGE THAT DOES NOT ANSWER THE QUESTION ON SCREEN (#2379) — pure.
 *
 * THE DEFECT. The layer read "main Pune mein rehta hoon", typed over "Koi training ki hai?", as a
 * `statement`: it filled the city and said the training question was not answered. The capture
 * still filed the whole message as the training's NAME, because a free-text question keeps any
 * text. A correction typed with a new fact ("experience 5 nahi 6 saal hai, aur roz 15 km tak aa
 * sakta hoon") went the same way, and over a typed question the ask was spent on a message that
 * never answered it.
 *
 * THE RULE (owner ruling 2026-10-20). The layer's verdict decides whether the message answers the
 * question on screen (CLAUDE.md §3: it classifies; code decides). When it does not, nothing is
 * filed under that question, and the question is served again, unspent, after a short reply. What
 * the message told is still filled, and a change to a filled field still goes to Haan/Nahi.
 *
 * NOT A SIDE MESSAGE, so today's capture runs, whenever the message has any claim on the question:
 *   - the model filled the on-screen field itself, or read a "none" for it (#2328's decline);
 *   - the deterministic reading said "pata nahi";
 *   - over a TYPED question, its parser read a value from the message (a value that parses keeps
 *     first claim, as in #2328). A free-text question's capture takes any text, so it claims
 *     nothing on its own.
 * The caller also requires a verdict above the confidence floor, a pack question on screen, and no
 * offer or gate owning the turn.
 */
export function isSideMessage(args: {
  readonly out: ProfilingTurnUnderstandOutput;
  readonly item: QuestionPackItem;
  /** The deterministic capture read a value for `item` from this message. */
  readonly capturedOnScreen: boolean;
  /** The deterministic reading was "pata nahi". */
  readonly dontKnow: boolean;
}): boolean {
  const { out, item } = args;
  const notAnAnswer = out.intent === "statement" || (out.intent === "chat" && out.fills.length > 0);
  if (!notAnAnswer || out.on_screen_none || args.dontKnow) return false;
  if (out.fills.some((fill) => fill.key === item.question_key)) return false;
  return isFreeTextItem(item) || !args.capturedOnScreen;
}
