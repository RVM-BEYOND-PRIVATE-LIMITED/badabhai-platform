/**
 * ONE turn of the LLM-led interview (Phase A), and the caps that bound it.
 *
 * WHAT THIS IS NOT. It is not a second interview engine. It decides ONE thing — what to put on
 * screen while the model leads — and returns `null` the moment it cannot, at which point the
 * caller runs the deterministic engine exactly as it does today. The fall-through IS the
 * fallback: there is one branch in `decide()`, not two engines to keep in step.
 *
 * WHY THE CAPS LIVE HERE AND NOT IN THE PROMPT. The ai-service is stateless by design — it holds
 * no session and cannot count turns — so a model asked to stop after N questions has no way to
 * know it has asked N. `MAX_LLM_ASKS` and `MAX_EXPERIENCE_ENTRIES` are checked on this side,
 * BEFORE the call, so a runaway costs nothing: a cap that has already fired ends Phase A without
 * spending a token. `force_close` is the softer half of the same rule — it tells the model which
 * question is its last, so the interview closes on something worth asking rather than mid-tangent.
 * A model that can extend its own interview can spend an unbounded amount of a worker's time, and
 * a worker on a 2G phone in a noisy workshop is the one paying.
 *
 * THE EXPERIENCE GATE IS OURS, NOT THE MODEL'S. "Aur koi experience jodna hai?" is served by the
 * engine with `options_only`, so the loop is exactly two options, typing is off, and termination
 * is deterministic. The model writes the experience QUESTION; it never writes the control flow.
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  ExperienceEntry,
  InputMode,
  LlmInterviewDraft,
  TranscriptLine,
} from "@badabhai/ai-contracts";
import { hasFirstPersonClaim, parseAffirmation } from "@badabhai/profiling-lexicon";
import type { ServerConfig } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import { SERVER_CONFIG } from "../config/config.module";
import type { ProfilingEnvelope } from "./conversation-state";

/**
 * How many questions the model may ask before the engine takes over.
 *
 * TWENTY. Phase A covers four topics and a worker with three jobs legitimately needs a dozen
 * turns for the experience stretch alone; below about fifteen the cap fires on ordinary
 * interviews rather than runaway ones, which would make the LLM path feel arbitrarily truncated.
 * It is a RUNAWAY GUARD, not a budget — the model is expected to finish well inside it.
 */
export const MAX_LLM_ASKS = 20;

/**
 * How many jobs a worker may describe. FIVE, and the reason is the résumé rather than the cost:
 * past five entries the document stops being scannable by the employer it exists to persuade,
 * and the loop gate gives the worker a natural place to stop long before this fires.
 */
export const MAX_EXPERIENCE_ENTRIES = 5;

export const EXPERIENCE_GATE_PROMPT = "Aur koi experience jodna hai?";
const GATE_YES = "Haan";
const GATE_NO = "Nahi";

/**
 * What one Phase A turn decided.
 *
 * A DISCRIMINATED UNION rather than an `ask` shape with a `done` flag, because the two carry
 * genuinely different payloads: `done` has no reply to serve. The engine serves Phase B's first
 * question on the same turn, so a reply here would put two questions in one bubble — and a
 * `reply` field that must be ignored in one of two cases is a field someone will eventually
 * serve. `null` from {@link LlmTurnService.take} is the third outcome: "engine, you go".
 */
export type LlmTurnResult =
  | {
      readonly kind: "ask";
      readonly reply: string;
      readonly chips: readonly string[];
      readonly inputMode: InputMode;
      readonly patch: Partial<ProfilingEnvelope>;
    }
  | { readonly kind: "done"; readonly patch: Partial<ProfilingEnvelope> };

@Injectable()
export class LlmTurnService {
  private readonly logger = new Logger(LlmTurnService.name);

  constructor(
    private readonly ai: AiService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Is the LLM path armed at all? Read by the orchestrator before anything else. */
  enabled(): boolean {
    return this.config.CHAT_LLM_INTERVIEW_ENABLED === true;
  }

  /**
   * Is Phase A still leading this interview?
   *
   * GATED ON `llmStage`, NOT ON `phase`. `nextQuestion` rewrites `phase` on every decision it
   * makes, so a single fallback turn would erase the only record that the model was ever in
   * charge. The stage is the LLM path's own state and nothing else writes it.
   */
  leads(envelope: ProfilingEnvelope): boolean {
    return this.enabled() && !envelope.llmFallback && envelope.llmStage !== "done";
  }

  /**
   * Take one Phase A turn.
   *
   * `null` means the caller runs the deterministic engine for this turn and marks the interview
   * fallen back; from then on {@link leads} is false and this is never called again.
   */
  async take(
    envelope: ProfilingEnvelope,
    text: string,
    history: readonly TranscriptLine[],
    ctx: { readonly workerId: string },
  ): Promise<LlmTurnResult | null> {
    if (!this.leads(envelope)) return null;

    // 1. THE GATE OWNS THE TURN when it is on screen, and is answered without a model call —
    //    "did they say yes" is not a judgement, and paying a capable model for it would be.
    if (envelope.llmGateOpen) {
      if (!wantsAnotherExperience(text)) {
        return { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } };
      }
      // Yes — close the gate and fall straight through to the model for the next experience
      // question, IN THIS SAME TURN. Returning an empty ask here would spend a worker's round
      // trip on a bubble with no question in it.
    }
    const closeGate: Partial<ProfilingEnvelope> = envelope.llmGateOpen ? { llmGateOpen: false } : {};

    // 2. CAPS, CHECKED BEFORE THE CALL, so a runaway costs nothing at all.
    const asks = envelope.llmAsks;
    const entries = envelope.llmDraft.experiences.length;
    if (asks >= MAX_LLM_ASKS || entries >= MAX_EXPERIENCE_ENTRIES) {
      this.logger.log(
        `Phase A closed by cap asks=${asks}/${MAX_LLM_ASKS} ` +
          `experiences=${entries}/${MAX_EXPERIENCE_ENTRIES}; the engine takes the tail`,
      );
      return { kind: "done", patch: { ...closeGate, llmStage: "done" } };
    }

    const out = await this.ai.llmTurn({
      schema_version: "oie.v1",
      worker_ref: ctx.workerId,
      stage: envelope.llmStage,
      message_text: text,
      history: [...history],
      draft: envelope.llmDraft,
      experience_count: entries,
      // THE LAST ASK, not a cap already hit: a hit cap returned above without calling at all.
      // This is what lets the model spend its final question on the thing it most needs.
      force_close: asks + 1 >= MAX_LLM_ASKS,
    });

    if (out === null) {
      this.logger.warn(
        `LLM turn unavailable at stage=${envelope.llmStage} asks=${asks} — ` +
          `the engine takes this interview`,
      );
      return null;
    }

    const draft = mergeDraft(envelope.llmDraft, out);

    // 3. A COMPLETED EXPERIENCE ENTRY HANDS THE NEXT TURN TO THE GATE — unless the entry cap is
    //    now full, in which case there is nothing to offer and Phase A ends here.
    //
    //    `llmAsks` IS NOT INCREMENTED. The model's reply is discarded in favour of the gate, so
    //    the question it wrote was never asked, and counting it would spend a worker's budget on
    //    a question they never saw.
    if (out.experience_entry !== null && draft.experiences.length < MAX_EXPERIENCE_ENTRIES) {
      return {
        kind: "ask",
        reply: EXPERIENCE_GATE_PROMPT,
        chips: [GATE_YES, GATE_NO],
        inputMode: "options_only",
        patch: { llmDraft: draft, llmStage: "experience", llmGateOpen: true },
      };
    }

    // 4. `phase_a_done` IS THE MODEL'S ADVICE; the caps above are the decision. Either ends it,
    //    and the model's closing words are dropped so the engine's next question stands alone.
    if (out.phase_a_done || draft.experiences.length >= MAX_EXPERIENCE_ENTRIES) {
      return {
        kind: "done",
        patch: { ...closeGate, llmDraft: draft, llmStage: "done", llmAsks: asks + 1 },
      };
    }

    return {
      kind: "ask",
      reply: out.reply_text,
      chips: out.suggested_answers,
      inputMode: out.input_mode,
      patch: { ...closeGate, llmDraft: draft, llmStage: out.stage, llmAsks: asks + 1 },
    };
  }
}

/**
 * The worker answered "Aur koi experience jodna hai?".
 *
 * FREE TEXT IS STILL ACCEPTED even though the turn was sent as `options_only`, because shipped
 * clients render the keyboard regardless until they honour `input_mode` — so a typed "haan" has
 * to work or the interview dead-ends on a rendering gap.
 *
 * AN UNREADABLE ANSWER IS A "NO". Ending the experience loop costs at most one entry, and the
 * worker still reaches Phase B and a profile; looping on an answer we could not read costs them
 * an interview that never moves.
 */
function wantsAnotherExperience(text: string): boolean {
  // `parseAffirmation` returns a NormalizedValue carrying the matched span and whether a negation
  // vetoed it — not a bare boolean. Reading `.value` is what distinguishes "haan" from "haan nahi
  // karna", which is the whole reason the lexicon reports the veto.
  const affirmation = parseAffirmation(text);
  if (affirmation !== null) return affirmation.value === true;
  // No yes/no anywhere in it. A worker who answers the gate by simply starting to describe
  // another job ("uske pehle main helper tha") means yes, and hearing that as a no would throw
  // away the experience they were in the middle of telling us about.
  return hasFirstPersonClaim(text);
}

/**
 * Fold a turn's findings into the draft.
 *
 * LAST NON-EMPTY WINS for the labels: a worker who corrects their trade three turns in is
 * telling us the first answer was wrong, and keeping the first would preserve a mistake the
 * conversation already fixed. Skills UNION rather than replace — they accumulate across the
 * skills stretch, and a turn that mentions two must not erase the three before it.
 */
function mergeDraft(
  current: LlmInterviewDraft,
  out: {
    domain_label: string | null;
    role_label: string | null;
    skills: string[];
    experience_entry: ExperienceEntry | null;
  },
): LlmInterviewDraft {
  const skills = [...current.skills];
  for (const skill of out.skills) {
    const trimmed = skill.trim();
    if (trimmed && !skills.some((s) => s.toLowerCase() === trimmed.toLowerCase())) {
      skills.push(trimmed);
    }
  }
  return {
    domain_label: out.domain_label?.trim() || current.domain_label,
    role_label: out.role_label?.trim() || current.role_label,
    skills,
    experiences: out.experience_entry
      ? [...current.experiences, out.experience_entry]
      : current.experiences,
  };
}
