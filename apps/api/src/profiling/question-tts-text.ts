import { CHAT_OPENING_TEXT, CHAT_UNAVAILABLE_REPLY } from "../chat/chat-replies";
import {
  CLOSING_REPLY_TEXT,
  DE_ESCALATION_REPLY_TEXT,
  DISAMBIGUATION_PROMPT_TEXT,
  HARDSHIP_REPLY_TEXTS,
} from "./next-question";
import { normalizeReplyText } from "./reply-closure";

/**
 * THE DEVANAGARI SIDECAR (#896) — the native-script twin of every string the interview can say.
 *
 * WHY IT EXISTS. The whole corpus is romanized Hinglish declared `hi-IN`: "…resume banate hain",
 * in Latin letters, with zero Devanagari codepoints in 466 pack items. No on-device voice can
 * pronounce that. A `hi-IN` voice is built for Devanagari and mangles the Latin ("banate" →
 * "banit"); an `en-IN` voice reads it as English. Both were verified on device. For a worker who
 * cannot read the screen, a confidently mispronounced question is worse than silence, because
 * nothing on screen lets them catch it. The text has to BE Devanagari to be spoken correctly.
 *
 * WHY NOT TRANSLITERATE AT RUNTIME. Romanization is lossy: "बनाते" and "बनते" both write as
 * "banate", and no phone can recover which one was meant. The mapping has to be authored once,
 * by someone who knows which word it was, and shipped.
 *
 * KEYED BY THE ROMAN TEXT ITSELF, not by `question_key`, and that is the load-bearing choice:
 *
 *   - ONE lookup covers everything. Pack prompts, `retry_text`, the `why_text` + question clarify
 *     JOIN, and the eight constants that belong to no pack are all just reply strings by the time
 *     they reach a serializer. Keying by question_key would have needed a second map for the
 *     constants and a `servedText`-shaped decision (prompt? retry? join?) re-derived at every
 *     call site — the orchestrator builds a reply at thirteen places, and each one would have had
 *     to state its own answer.
 *   - TRANSCRIPT HYDRATION FALLS OUT. `GET /chat/sessions/:id/messages` replays `body_text` and
 *     has no question_key to hand (the durable row's `metadata` is a closed slug set that must
 *     never hold worker-authored text). Keyed this way, the stored line looks itself up.
 *   - DRIFT IS A TEST FAILURE. The keys are LITERAL roman strings, deliberately not imports of
 *     the constants below. Import the constant and an edit to the English silently re-keys the
 *     entry, leaving Devanagari that no longer says the same thing — the exact failure this file
 *     exists to prevent, now invisible. Spelled out, an edit orphans the key and
 *     `question-tts-text.test.ts` fails until the pair is re-authored together.
 *
 * This is the same content-addressed shape the voice form already uses for its pre-rendered audio
 * (`tts_clip_id: clipId(turn.reply)` in `profiling-session.service.ts`) — that surface resolves a
 * Sarvam-rendered clip by reply text, this one resolves a script for the on-device voice.
 *
 * ADDITIVE AND OPTIONAL. A miss returns `undefined`, the field is omitted, and the client speaks
 * the romanized text exactly as it does today. Nothing regresses while the corpus fills in.
 *
 * COVERAGE TODAY: the 8 constants. The 466 pack items land as a data-only follow-up — see #896.
 */

/**
 * Roman → Devanagari, for the strings that belong to NO pack.
 *
 * Every entry is `CONSTANT_REPLIES` (`reply-closure.ts`) in the same order, and
 * `question-tts-text.test.ts` asserts that correspondence both ways: a ninth constant added to
 * the orchestrator without its Devanagari twin fails, and a key here that no longer matches any
 * constant fails. Punctuation follows Devanagari convention — the danda (।) for a full stop, but
 * a Latin question mark, which is what Hindi text uses in practice and what the voice needs to
 * hear to apply question intonation.
 */
const CONSTANT_TTS_TEXT: Readonly<Record<string, string>> = {
  // chat-replies.ts — the AI service is unreachable and no turn happened.
  "Abhi thodi dikkat aa rahi hai. Ek minute baad dobara bhejiye.":
    "अभी थोड़ी दिक्कत आ रही है। एक मिनट बाद दोबारा भेजिये।",

  // chat-replies.ts — the one-shot composite opener; the FIRST thing a worker ever hears, and
  // until now the one line the client had to carry its own hard-coded Devanagari for.
  "Namaste. Aap kaun sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?":
    "नमस्ते। आप कौन सा काम करते हैं, कहाँ रहते हैं, और कितना तजुर्बा है?",

  // next-question.ts — the fixed de-escalation line.
  "Aap se vinamra rehne ki request hai. Kaam ki baat karte hain.":
    "आप से विनम्र रहने की रिक्वेस्ट है। काम की बात करते हैं।",

  // next-question.ts — the closed hardship appreciation set, indexed by turn.
  "Samajh sakta hoon. Aapki baat sahi hai.": "समझ सकता हूँ। आपकी बात सही है।",
  "Aapki mehnat samajh aati hai. Thoda aur batayiye.":
    "आपकी मेहनत समझ आती है। थोड़ा और बताइये।",
  "Theek hai. Aaram se batayiye, koi jaldi nahi.": "ठीक है। आराम से बताइये, कोई जल्दी नहीं।",

  // next-question.ts — served when the interview ends normally.
  "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.":
    "आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।",

  // next-question.ts — asked ABOUT the packs, so it lives in none of them.
  "Aap in mein se kaun sa kaam karte hain?": "आप इन में से कौन सा काम करते हैं?",
};

/**
 * Roman → Devanagari for PACK-DERIVED text: `prompt_text`, `retry_text`, `why_text`, and the
 * `why + " " + question` clarify join, each keyed by the exact string that reaches the worker.
 *
 * EMPTY BY DESIGN until the corpus lands (#896 follow-up). Every miss is a silent, correct
 * fallback to today's behaviour, so the wiring ships and proves itself before 466 items of
 * hand-authored Devanagari arrive to be reviewed as a pure data diff.
 */
const PACK_TTS_TEXT: Readonly<Record<string, string>> = {};

/** One lookup table, normalized once at module load — see {@link ttsTextFor}. */
const TTS_TEXT_BY_REPLY: ReadonlyMap<string, string> = new Map(
  [...Object.entries(CONSTANT_TTS_TEXT), ...Object.entries(PACK_TTS_TEXT)].map(
    ([roman, devanagari]) => [normalizeReplyText(roman), devanagari],
  ),
);

/** Devanagari codepoints — the check that an entry is actually in the target script. */
const DEVANAGARI_RE = /[ऀ-ॿ]/;

/**
 * The Devanagari twin of `reply`, or `undefined` when none is authored.
 *
 * NORMALIZED ON BOTH SIDES via `normalizeReplyText` — the same collapse the reply closure hashes
 * under — so a reply that picked up a line break or a doubled space on its way through the engine
 * still resolves. Anything beyond whitespace is a genuine miss and must stay one.
 *
 * PRE-INTERPOLATION. Call this with the raw engine reply, while `{{worker_name}}` is still a
 * placeholder; the Devanagari carries the identical placeholder and is rendered through the same
 * `renderPackText` as the shown text. Looking up AFTER interpolation would key on a string that
 * differs per worker and never match — and would put a real name in a lookup table.
 */
export function ttsTextFor(reply: string | null | undefined): string | undefined {
  if (!reply) return undefined;
  return TTS_TEXT_BY_REPLY.get(normalizeReplyText(reply));
}

/**
 * `{ tts_text }` for a reply, or `{}` when no twin is authored — spread straight into a response.
 *
 * THE SPREAD IS THE POINT: an unauthored reply yields a body with the key ABSENT rather than
 * present-and-null, which is the contract every `tts_text` field documents and the shape a client
 * reads as "speak the romanized text". For the chat surface use `ChatService.ttsField` instead —
 * it wraps this to render `{{worker_name}}` through the same path as the shown string.
 */
export function ttsField(reply: string | null | undefined): { tts_text?: string } {
  const devanagari = ttsTextFor(reply);
  return devanagari === undefined ? {} : { tts_text: devanagari };
}

/**
 * Every authored pair, for the tests that hold this file to the reply closure.
 *
 * Exported as data rather than as assertions so the test owns the failure messages, and so a
 * future coverage report can ask "how much of the closure speaks correctly yet" without
 * re-deriving the table.
 */
export const TTS_TEXT_ENTRIES: readonly (readonly [roman: string, devanagari: string])[] = [
  ...Object.entries(CONSTANT_TTS_TEXT),
  ...Object.entries(PACK_TTS_TEXT),
];

/** The constants this file must cover, in `CONSTANT_REPLIES` order — see the test. */
export const TTS_CONSTANT_SOURCES: readonly string[] = [
  DE_ESCALATION_REPLY_TEXT,
  ...HARDSHIP_REPLY_TEXTS,
  CLOSING_REPLY_TEXT,
  CHAT_UNAVAILABLE_REPLY,
  DISAMBIGUATION_PROMPT_TEXT,
  CHAT_OPENING_TEXT,
];

export { DEVANAGARI_RE };
