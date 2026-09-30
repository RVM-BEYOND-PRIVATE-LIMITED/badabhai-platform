/**
 * The identity intake's worker-facing copy (ADR-0048, #1858), in a module with NO runtime imports.
 *
 * WHY A SEPARATE MODULE. Every line here is also a member of the reply closure (`reply-closure.ts`
 * `CONSTANT_REPLIES`) and of the Devanagari sidecar (`question-tts-text.ts`), and both of those are
 * read by processes that must not boot Nest or load the gazetteer — the same reason
 * `chat-replies.ts` holds the chat's own constants. The state machine that SERVES these lines
 * (`identity-intake.ts`) imports validators and the lexicon; this file imports a type and nothing
 * else, so enumerating what a worker can hear stays cheap.
 *
 * NAME-FREE, BY RULING (D4). No `{{worker_name}}` anywhere below: every line is a shared,
 * pre-renderable clip, and `assertNoInterpolation` fails the build on a placeholder. A greeting by
 * name would have needed a `listMessages` render fix and would have had no pre-rendered audio.
 *
 * ON-PERSONA by the rules the pack validator enforces: "aap", no vocative, no exclamation, no
 * emoji, at most one question mark and twenty words — pinned by `identity-intake.test.ts`.
 */

import type { IdentityIntakeStep } from "@badabhai/event-schema";

/** The three lines one intake step can put on screen, plus the ⓘ explanation. */
export interface IntakeStepCopy {
  /** The first ask. */
  readonly prompt: string;
  /** The second ask, after a reply that was not an answer. An instruction, not a question. */
  readonly retry: string;
  /** Why we ask — the ⓘ affordance, and the first half of {@link clarify}. */
  readonly why: string;
  /**
   * `why + " " + prompt`, served when the worker asks a question back. SPELLED OUT rather than
   * joined at runtime so the closure and the sidecar hold the exact string the worker is served,
   * and so a wording edit to either half is a visible diff on this one too.
   */
  readonly clarify: string;
}

/** Per-step copy. Keyed by the closed step set the `profile.identity_intake_answered` event uses. */
export const INTAKE_COPY: Readonly<Record<IdentityIntakeStep, IntakeStepCopy>> = {
  first_name: {
    prompt: "Aapka pehla naam kya hai?",
    retry: "Kripya sirf apna pehla naam likhiye.",
    why: "Aapka naam aapke resume par chhapta hai.",
    clarify: "Aapka naam aapke resume par chhapta hai. Aapka pehla naam kya hai?",
  },
  last_name: {
    prompt: "Aapka surname kya hai?",
    retry: "Kripya sirf apna surname likhiye.",
    why: "Poora naam resume par sahi dikhta hai.",
    clarify: "Poora naam resume par sahi dikhta hai. Aapka surname kya hai?",
  },
  state: {
    prompt: "Aap kis state mein rehte hain?",
    retry: "Kripya apne state ka naam likhiye.",
    why: "State se aapke paas ki naukri dhoondhi jaati hai.",
    clarify: "State se aapke paas ki naukri dhoondhi jaati hai. Aap kis state mein rehte hain?",
  },
  city: {
    prompt: "Aap kis sheher mein rehte hain?",
    retry: "Kripya apne sheher ka naam likhiye.",
    why: "Sheher se aapke paas ki naukri dikhayi jaati hai.",
    clarify: "Sheher se aapke paas ki naukri dikhayi jaati hai. Aap kis sheher mein rehte hain?",
  },
};

/**
 * The intake's last line when nothing résumé-shaped follows it — the interview's opener, served as
 * the reply to the last intake answer (D6).
 *
 * THE COMPOSITE OPENER'S OWN QUESTION (`CHAT_OPENING_TEXT`) with "Shukriya" in place of "Namaste":
 * the worker has already been greeted and has just answered, and the question after it is the one
 * every interview opens on, so the worker's next message is read exactly as a first message is.
 */
export const INTAKE_HANDOFF_TEXT = "Shukriya. Aap kaun sa kaam karte hain, aur kitna tajurba hai?";

/**
 * Every string the intake can serve, for the reply closure and the TTS sidecar's coverage test.
 * The de-escalation line is the engine's own constant and is already in the closure.
 */
export const IDENTITY_INTAKE_REPLIES: readonly string[] = [
  ...Object.values(INTAKE_COPY).flatMap((copy) => [
    copy.prompt,
    copy.retry,
    copy.why,
    copy.clarify,
  ]),
  INTAKE_HANDOFF_TEXT,
];
