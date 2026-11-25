/**
 * VOICE HELD (#3018): a question from a form whose voice is not signed yet is not read aloud.
 *
 * THE RULING. A CEO pack v2 sheet may go live for chips and typing before a practising worker has
 * signed its wording; only its voice waits (`VOICE_READY_THROUGH_VERSION` in @badabhai/taxonomy).
 * Its lines have no Devanagari twin, and without one the chat's speaker reads the ROMANIZED text
 * with the phone's Hindi voice, and the voice form has nothing to play at all.
 *
 * THE RULE, NARROW ON PURPOSE. A turn is held only when ALL three hold:
 *   1. the session is pinned to a pack version the table holds back;
 *   2. the turn serves a pack question (`questionKey` set — never a disambiguation or a fixed line);
 *   3. the reply has no Devanagari twin.
 * A held form's question that already has a twin (a shared key worded like a live form's) is still
 * read aloud, correctly. Every voice-ready form is held to a twin for every string by
 * `question-tts-text.test.ts`, so condition 1 keeps every live form byte-identical.
 *
 * WHAT EACH SURFACE DOES WITH IT. Chat: `read_aloud: false` and no `tts_text`, so the speaker
 * button is hidden — the same wire the model-written turns use (ADR-0051 §3.8). Voice form: no
 * `tts_text`, `voice_ready: false` and {@link VOICE_FALLBACK_HINT}, with the question's chips, so a
 * worker is told to tap or type instead of being met with silence.
 */
import { isPackVersionVoiceReady } from "@badabhai/taxonomy";

import { ttsTextFor } from "./question-tts-text";

/**
 * The one fixed line a voice-form worker sees on a held question. Hinglish only, by owner ruling
 * (2026-11-25): it is shown, never read aloud, so it needs no Devanagari twin.
 */
export const VOICE_FALLBACK_HINT = "Is sawaal ka jawab neeche se chuniye ya likh kar bhejiye.";

/** The pinned pack pointer, as the profiling envelope carries it. */
export interface PinnedPack {
  readonly packId: string | null;
  readonly packVersion: number | null;
}

/** Whether this turn's reply must not be read aloud. See the module note for the three conditions. */
export function voiceHeld(
  pin: PinnedPack | null | undefined,
  questionKey: string | null,
  reply: string | null | undefined,
): boolean {
  if (!pin || pin.packId === null || pin.packVersion === null) return false;
  if (questionKey === null) return false;
  if (isPackVersionVoiceReady(pin.packId, pin.packVersion)) return false;
  return ttsTextFor(reply) === undefined;
}
