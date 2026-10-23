import type { ProfilingTurnUnderstandOutput, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import type { ProfilingEnvelope } from "../conversation-state";
import { factForPackItem } from "../facts/worker-fact.registry";

/**
 * TOKEN-AUDIT FIX Q2 — A MESSAGE READ AS CHAT ONLY, AND WHAT THE TURN DOES WITH IT. Pure.
 *
 * THE DEFECT. In the audit's run 7 a CNC turner from Faridabad asked four side questions ("bhai
 * pune mein 10 saal wale CNC turner ko kitna milta hai?", "gurgaon mein koi company hai jo 38 de
 * de turner ko?", ...). The turn understanding read each one as `chat` at 0.95 with nothing in it,
 * and the interview carried on correctly. The end-of-interview extraction then read the whole
 * transcript (owner ruling #1505-2, so that a fact the worker volunteers is still captured) and
 * turned the questions into his facts: current city Pune, preferred cities Gurgaon and Pune, an
 * expected salary of 38,000.
 *
 * THE RULE. The layer classifies; code decides (CLAUDE.md §3). A message is CHAT ONLY when the
 * layer, above the confidence floor, calls it `chat` and heard nothing for the profile in it: no
 * fill, no edit, no Profile-page fact, no "none" answer. Its prompt defines chat as never stating a
 * fact about the worker, and a message where it heard a salary or a preferred city is NOT chat only
 * — so #1505-2's purpose holds: what a worker volunteers is still read.
 *
 * TWO SWITCHES, both default off (today):
 *  - `PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED`: the turn's lines are flagged `chatOnly`
 *    ({@link flagChatOnlyLines}) and the extraction leaves them out;
 *  - `CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED`: the cross-question fill takes no current city from
 *    the message ({@link withoutCityCrossFill}).
 */

/** The layer heard nothing for the profile in this message. The caller applies the confidence floor. */
export function isChatOnlyReading(out: ProfilingTurnUnderstandOutput): boolean {
  return (
    out.intent === "chat" &&
    out.fills.length === 0 &&
    out.edits.length === 0 &&
    out.page_owned_mentions.length === 0 &&
    !out.on_screen_none
  );
}

/**
 * The cross-question fill's items without the worker's current city — for a chat-only message under
 * the city guard. A city he ASKS about ("Pune mein kitna milta hai?") is not the city he lives in;
 * a message that STATES it is a statement, never chat only, and keeps the fill. Every other field
 * stays: the guard is the city's alone.
 */
export function withoutCityCrossFill<
  T extends Pick<QuestionPackItem, "question_key" | "target_field">,
>(items: readonly T[]): T[] {
  return items.filter((item) => factForPackItem(item)?.fact !== "current_city");
}

/** A turn whose message was read as chat only, and the pack question it served again, if any. */
export interface ChatOnlyVerdict {
  /**
   * The pack question the side-message branch served again, unspent — null when the turn went on
   * (the AI-led stretch, or no pack question on screen).
   */
  readonly reservedKey: string | null;
}

/**
 * Did this turn leave every profile fact as it found it? The answer map, the model's draft and the
 * occupation pin: the places a turn records what a worker said. (The general road's lane state is
 * not read: its extraction reads no transcript, ADR-0045 §3.4.) Compared as JSON, so any change —
 * even one that only reshapes a value — counts as a write, which fails toward today's transcript.
 */
export function wroteNoFacts(before: ProfilingEnvelope, after: ProfilingEnvelope): boolean {
  return JSON.stringify(factsOf(before)) === JSON.stringify(factsOf(after));
}

function factsOf(envelope: ProfilingEnvelope): readonly unknown[] {
  return [envelope.answerMap, envelope.llmDraft, envelope.occupation];
}

/**
 * Flag this turn's lines `chatOnly` — the worker's message, and the reply when it only served the
 * same pack question again. Returned unchanged unless the turn wrote no fact and appended exactly
 * two lines: the worker's message and one reply.
 *
 * THE REPLY, ONLY WHEN IT SERVES THE SAME QUESTION AGAIN. Over a pack question the reply is a short
 * line answering the chat ("Haan, Gurgaon mein bahut companies hain.") above the SAME question,
 * which the line before the chat already asked, so leaving both out keeps that question next to
 * its answer. Under the model's own question (the AI-led stretch) the reply is the model's next
 * question, which the worker's next answer needs: it stays. So does a reply the edit gate replaced.
 */
export function flagChatOnlyLines<
  D extends {
    readonly buffer: TranscriptBuffer;
    readonly result: { readonly kind: string; readonly questionKey: string | null };
  },
>(
  decided: D,
  args: {
    /** The buffer as this attempt loaded it, before the turn's lines were appended. */
    readonly before: TranscriptBuffer;
    /** The envelope as this attempt loaded it. */
    readonly envelope: ProfilingEnvelope;
    /** The worker's message on this turn. */
    readonly text: string;
    readonly verdict: ChatOnlyVerdict;
  },
): D {
  const after = decided.buffer.profiling;
  if (after === undefined || !wroteNoFacts(args.envelope, after)) return decided;
  const lines = decided.buffer.messages;
  const at = args.before.messages.length;
  const worker = lines[at];
  const reply = lines[at + 1];
  if (
    lines.length !== at + 2 ||
    worker?.role !== "worker" ||
    worker.text !== args.text ||
    reply?.role !== "assistant"
  ) {
    return decided;
  }
  const reserved = args.verdict.reservedKey;
  const replyServesItAgain =
    reserved !== null && decided.result.kind === "ask" && decided.result.questionKey === reserved;
  const messages = [...lines];
  messages[at] = { ...worker, chatOnly: true };
  if (replyServesItAgain) messages[at + 1] = { ...reply, chatOnly: true };
  return { ...decided, buffer: { ...decided.buffer, messages } };
}
