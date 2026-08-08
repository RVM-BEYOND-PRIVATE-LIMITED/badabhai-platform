/**
 * EVERY STRING THE INTERVIEW CAN EVER SAY TO A WORKER, as a finite, content-addressed set.
 *
 * WHY THIS CAN EXIST AT ALL, and why it is the load-bearing property of the voice form: the engine
 * makes ZERO LLM calls between session start and completion. Question selection is a pure function
 * over authored JSON, so the set of things a worker can hear is knowable ahead of time rather than
 * generated per worker. That is what makes pre-rendered TTS possible — instant playback, no 2G
 * round trip per question, and audio that can be bundled in the APK.
 *
 * WHY IT IS NOT JUST "THE PACK STRINGS". The corpus is not the closure. Two producers compose text
 * at RUNTIME and appear in no pack field:
 *
 *   - `joinClarify` concatenates `why_text + " " + servedText(...)` — measured: 145 distinct
 *     strings, more than the 129 distinct prompts they are built from.
 *   - `servedText` selects `retry_text` over `prompt_text` from the second ask onward.
 *
 * Both are IMPORTED here rather than reimplemented. A second copy of the join would let the
 * pre-rendered clip and the runtime reply disagree about wording — a silent failure on the one
 * surface where the worker cannot read the screen to catch it.
 *
 * WHAT MUST NEVER ENTER. A shared, content-addressed cache is only safe while its keys depend on
 * nothing about the individual worker. `{{worker_name}}` interpolation happens POST-emit, on the
 * client-returned reply only, precisely so the durable and rendered copies keep the placeholder —
 * but a pack that shipped a vocative inside `prompt_text` would put one worker's name in a clip
 * every other worker hears. {@link assertNoInterpolation} makes that a build failure rather than a
 * privacy incident. Measured today: 0 of 466 items contain a `{{` anywhere.
 */

import { createHash } from "node:crypto";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import {
  CLOSING_REPLY_TEXT,
  DE_ESCALATION_REPLY_TEXT,
  DISAMBIGUATION_PROMPT_TEXT,
  HARDSHIP_REPLY_TEXTS,
  joinClarify,
  servedText,
} from "./next-question";
// THE ONE IMPORT NOT FROM THE PURE MODULE, and it is a deliberate trade. `UNAVAILABLE_REPLY` is
// this same constant re-exported by the orchestrator, because two copies of a worker-facing string
// drift and which one a worker sees would then depend on which internal path produced it. Copying
// it here to keep the module import-free would recreate exactly that problem.
import { CHAT_UNAVAILABLE_REPLY } from "../chat/chat-replies";

/** Which code path can put this text in front of a worker. */
export type ReplyProducer = "prompt" | "retry" | "clarify" | "why" | "constant";

export interface ReplyClip {
  /** `sha256(normalize(text))` truncated — the render filename and the cache key. */
  readonly id: string;
  /** The exact string served. Not normalized: normalization is for IDENTITY, not for speech. */
  readonly text: string;
  readonly producer: ReplyProducer;
}

/**
 * The content-address of one reply.
 *
 * NORMALIZED BEFORE HASHING so that whitespace churn in the corpus — a trailing space, a wrapped
 * line, a CRLF from a Windows editor — does not silently invalidate every rendered clip and
 * re-spend the entire render budget. The normalization is deliberately narrow: it collapses
 * horizontal whitespace runs and trims, and touches nothing else. Case is significant (Hinglish
 * proper nouns), punctuation is significant (a question mark changes prosody), and Devanagari is
 * untouched.
 *
 * SIXTEEN HEX CHARACTERS = 64 bits. Against a corpus three orders of magnitude smaller than a
 * thousand clips, collision probability is ~1e-14. `assertNoCollisions` checks it anyway, because
 * a collision here silently plays the wrong question to a worker who cannot read the screen.
 */
export function clipId(text: string): string {
  return createHash("sha256").update(normalizeReplyText(text)).digest("hex").slice(0, 16);
}

/**
 * Identity normalization for {@link clipId}.
 *
 * `[ \t\r\n]` EXPLICITLY, never `\s`. The lexicon package bans `\s` for exactly this reason: it
 * matches a different character set in TypeScript than in Python's `re`, and this normalization has
 * to produce byte-identical results in both or the TS closure and the Python renderer will disagree
 * about which clips exist. The Devanagari danda and the non-breaking space are NOT whitespace here,
 * on purpose — both carry meaning in the corpus.
 *
 * AND `.trim()` IS GONE, FOR THE SAME REASON IT BANNED `\s`. Trimming with the explicit class was
 * the missing half: `String.prototype.trim` strips the ECMAScript WhiteSpace set, Python's
 * `str.strip()` strips the Python one, and they are NOT the same set. Measured across the two
 * runtimes this repo actually uses, six codepoints disagree:
 *
 *   U+FEFF          JS strips it, Python keeps it   ← a BOM on a pack file reaches here
 *   U+001C..U+001F  Python strips them, JS keeps them
 *   U+0085 (NEL)    Python strips it, JS keeps it
 *
 * A leading BOM would therefore have produced a DIFFERENT clip id on each side — the pre-rendered
 * audio and the runtime reply silently disagreeing about which clip is which, on the one surface
 * where the worker cannot read the screen to notice. That is precisely the divergence the `\s` ban
 * exists to prevent, walked in through the other door.
 *
 * The explicit form also FIXES an inconsistency with the paragraph above: `.trim()` treats the
 * non-breaking space as whitespace, so it stripped a LEADING U+00A0 while the comment declared
 * NBSP meaningful. The existing NBSP vector only tested an INTERIOR one, which is why nothing
 * caught it. Edges and interior now agree — NBSP is preserved in both.
 */
export function normalizeReplyText(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[ \t\r\n]+/g, " ");
}

/**
 * Reply strings that belong to no pack — the fixed constants the engine serves directly.
 *
 * Enumerated as a value rather than described in a comment, so adding a seventh constant to the
 * orchestrator without adding it here is a test failure rather than a question a worker hears in
 * silence.
 */
export const CONSTANT_REPLIES: readonly string[] = [
  DE_ESCALATION_REPLY_TEXT,
  ...HARDSHIP_REPLY_TEXTS,
  CLOSING_REPLY_TEXT,
  CHAT_UNAVAILABLE_REPLY,
  DISAMBIGUATION_PROMPT_TEXT,
];

/** Thrown by the guards below. Names the offending text so the corpus row is findable. */
export class ReplyClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyClosureError";
  }
}

/**
 * FAIL THE BUILD ON A TEMPLATE PLACEHOLDER IN SERVED TEXT.
 *
 * The worst failure available in this design is a shared pre-rendered cache serving one worker's
 * interpolated name to every other worker, and `{{worker_name}}` is exactly the mechanism that
 * would do it. The interpolation is post-emit and client-only by construction today; this makes
 * that a checked property of the corpus rather than a property of one function's current shape.
 */
export function assertNoInterpolation(clips: readonly ReplyClip[]): void {
  const offending = clips.filter((clip) => /\{\{|\}\}/.test(clip.text));
  if (offending.length > 0) {
    throw new ReplyClosureError(
      `${offending.length} reply string(s) carry a template placeholder and must not be ` +
        `pre-rendered — a shared clip would speak one worker's value to every worker: ` +
        offending.map((c) => JSON.stringify(c.text)).join(", "),
    );
  }
}

/** Two different strings sharing a clip id would play the wrong audio. Cheap to check, so check. */
export function assertNoCollisions(clips: readonly ReplyClip[]): void {
  const byId = new Map<string, string>();
  for (const clip of clips) {
    const seen = byId.get(clip.id);
    if (seen !== undefined && normalizeReplyText(seen) !== normalizeReplyText(clip.text)) {
      throw new ReplyClosureError(
        `clip id ${clip.id} is claimed by two different strings: ` +
          `${JSON.stringify(seen)} and ${JSON.stringify(clip.text)}`,
      );
    }
    byId.set(clip.id, clip.text);
  }
}

/**
 * Every reply the engine can produce for these packs, deduplicated by clip id and sorted by it.
 *
 * SORTED BY ID rather than by pack order so the output is a stable artifact: re-ordering a pack's
 * items, or authoring a new pack, changes the set but not the ordering of everything already in it.
 * A render is then an incremental diff instead of a full re-spend.
 *
 * `why_text` IS EMITTED ON ITS OWN as well as inside its concatenation, and that is not redundancy.
 * `joinClarify` returns the bare `why` whenever the served question is absent — which happens when
 * the envelope's `servedQuestionKey` names an item the current pack no longer contains, i.e. after
 * a pack version moved under a live conversation. Rare, reachable, and a missing clip there is
 * silence at the exact moment a confused worker asked for help.
 */
export function replyClosure(packs: readonly QuestionPack[]): ReplyClip[] {
  const clips = new Map<string, ReplyClip>();
  const add = (text: string, producer: ReplyProducer): void => {
    const normalized = normalizeReplyText(text);
    if (normalized.length === 0) return; // a blank reply is never served — the guard drops the turn
    const id = clipId(normalized);
    if (!clips.has(id)) clips.set(id, { id, text: normalized, producer });
  };

  for (const text of CONSTANT_REPLIES) add(text, "constant");

  for (const pack of packs) {
    for (const item of pack.items) {
      // Ask 1 and ask 2 go through the SAME selector the engine uses, so an item with no
      // `retry_text` contributes one clip and an item with one contributes two.
      add(servedText(item, 1), "prompt");
      const retry = servedText(item, 2);
      if (retry !== item.prompt_text) add(retry, "retry");

      if (item.why_text) {
        add(item.why_text, "why");
        // The concatenation, built by the ENGINE'S OWN function against the same pack. Both ask
        // numbers, because a worker can ask "why?" before or after the re-ask.
        for (const askNumber of [1, 2]) {
          add(joinClarify({ promptText: clarifyPromptText(item) }, item, askNumber), "clarify");
        }
      }
    }
  }

  return [...clips.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * What `clarify` would put in `promptText` for this item.
 *
 * Derived rather than obtained by calling `clarify`, which needs a whole `EngineState` and resolved
 * `EnginePacks` to answer something this enumerator already knows — and mirrors that function's one
 * expression exactly, including the `??` fallback for an item with no `why_text`.
 */
function clarifyPromptText(item: QuestionPackItem): string {
  return item.why_text ?? servedText(item, 1);
}

/** Build the closure and run every guard. What a renderer and a CI check should both call. */
export function checkedReplyClosure(packs: readonly QuestionPack[]): ReplyClip[] {
  const clips = replyClosure(packs);
  assertNoInterpolation(clips);
  assertNoCollisions(clips);
  return clips;
}
