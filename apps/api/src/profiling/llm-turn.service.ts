/**
 * ONE turn of the LLM-led interview (Phase A), and the caps that bound it.
 *
 * WHAT THIS IS NOT. It is not a second interview engine. It produces a reply, some chips and an
 * updated draft, and returns `null` the moment it cannot — at which point the caller runs the
 * deterministic engine exactly as it does today. The fall-through IS the fallback: there is one
 * branch in `decide()`, not two engines to keep in step.
 *
 * WHY THE CAPS LIVE HERE AND NOT IN THE PROMPT. The ai-service is stateless by design — it holds
 * no session and cannot count turns — so a model asked to stop after N questions has no way to
 * know it has asked N. `MAX_LLM_ASKS` and `MAX_EXPERIENCE_ENTRIES` are checked on this side,
 * before the call, and `force_close` is how the model is TOLD the interview is over rather than
 * trusted to decide. A model that can extend its own interview can spend an unbounded amount of
 * a worker's time, and a worker on a 2G phone in a noisy workshop is the one paying.
 *
 * THE EXPERIENCE GATE IS OURS, NOT THE MODEL'S. "Aur experience jode?" is served by the engine
 * with `options_only`, so the loop is exactly two options, typing is off, and termination is
 * deterministic. The model writes the experience QUESTION; it never writes the control flow.
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  ExperienceEntry,
  InputMode,
  LlmInterviewDraft,
  LlmInterviewStage,
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

/**
 * The synthetic `servedQuestionKey` for the loop gate.
 *
 * A RESERVED KEY RATHER THAN A NEW STAGE, deliberately: `LlmInterviewStage` is a frozen
 * cross-language contract, and the gate is an API-side control-flow detail the model has no
 * business knowing about. The double underscore keeps it outside `^[a-z_]+$`, which is the slug
 * shape every real `question_key` must satisfy — so it can never be mistaken for a pack question
 * or reach an event payload that validates against that regex.
 */
export const EXPERIENCE_GATE_KEY = "__experience_gate";

export const EXPERIENCE_GATE_PROMPT = "Aur koi experience jodna hai?";
const GATE_YES = "Haan";
const GATE_NO = "Nahi";

/** What a successful Phase A turn produces. `null` from {@link take} means "engine, you go". */
export interface LlmTurnResult {
  readonly reply: string;
  readonly chips: readonly string[];
  readonly inputMode: InputMode;
  /** The synthetic key when this is the loop gate; null for a model-written question. */
  readonly questionKey: string | null;
  readonly patch: Partial<ProfilingEnvelope>;
  /** Phase A is over — the caller moves the interview on to the template pack. */
  readonly done: boolean;
}

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
   * Take one Phase A turn.
   *
   * `null` means the caller runs the deterministic engine for this turn. Once that has happened
   * the envelope carries `llmFallback`, and the caller should stop asking.
   */
  async take(
    envelope: ProfilingEnvelope,
    text: string,
    history: readonly TranscriptLine[],
    ctx: { readonly workerId: string },
  ): Promise<LlmTurnResult | null> {
    if (!this.enabled() || envelope.llmFallback) return null;

    // 1. The gate owns this turn if it is on screen. Answered deterministically — no model call,
    //    because "did they say yes" is not a judgement and paying a model for it would be.
    if (envelope.servedQuestionKey === EXPERIENCE_GATE_KEY) {
      return this.settleGate(text);
    }

    // 2. Caps, checked BEFORE the call so a runaway costs nothing.
    const capped =
      envelope.llmAsks >= MAX_LLM_ASKS ||
      envelope.llmDraft.experiences.length >= MAX_EXPERIENCE_ENTRIES;

    const out = await this.ai.llmTurn({
      schema_version: "oie.v1",
      worker_ref: ctx.workerId,
      stage: envelope.llmStage,
      message_text: text,
      history: [...history],
      draft: envelope.llmDraft,
      experience_count: envelope.llmDraft.experiences.length,
      force_close: capped,
    });

    if (out === null) {
      this.logger.warn(
        `LLM turn unavailable at stage=${envelope.llmStage} asks=${envelope.llmAsks} — ` +
          `the engine takes this interview`,
      );
      return null;
    }

    const draft = this.mergeDraft(envelope.llmDraft, out);

    // 3. A completed experience entry hands the NEXT turn to the gate — unless we are already at
    //    the entry cap, in which case there is nothing to offer and Phase A ends here.
    if (out.experience_entry !== null && draft.experiences.length < MAX_EXPERIENCE_ENTRIES) {
      return {
        reply: EXPERIENCE_GATE_PROMPT,
        chips: [GATE_YES, GATE_NO],
        inputMode: "options_only",
        questionKey: EXPERIENCE_GATE_KEY,
        patch: { llmDraft: draft, llmStage: "experience", llmAsks: envelope.llmAsks + 1 },
        done: false,
      };
    }

    // 4. `phase_a_done` is the model's ADVICE; the caps are the decision. Either ends it.
    const done = capped || out.phase_a_done || draft.experiences.length >= MAX_EXPERIENCE_ENTRIES;

    return {
      reply: out.reply_text,
      chips: out.suggested_answers,
      inputMode: out.input_mode,
      questionKey: null,
      patch: {
        llmDraft: draft,
        llmStage: done ? "done" : out.stage,
        llmAsks: envelope.llmAsks + 1,
      },
      done,
    };
  }

  /**
   * The worker answered "Aur koi experience jodna hai?".
   *
   * FREE TEXT IS STILL ACCEPTED even though the turn was sent as `options_only`, because shipped
   * clients render the keyboard regardless until they honour `input_mode` — so a typed "haan" has
   * to work or the interview dead-ends on a rendering gap. An unreadable answer is treated as
   * "no": ending the experience loop costs one entry, while looping on an answer we could not
   * read costs the worker an interview that will not move.
   */
  private settleGate(text: string): LlmTurnResult {
    // `parseAffirmation` returns a NormalizedValue carrying the matched span and whether a
    // negation vetoed it — not a bare boolean. Reading `.value` is what distinguishes "haan"
    // from "haan nahi karna", which is the whole reason the lexicon reports the veto.
    const affirmation = parseAffirmation(text);
    const yes = affirmation?.value === true || (affirmation === null && hasFirstPersonClaim(text));
    if (!yes) {
      return {
        reply: "",
        chips: [],
        inputMode: "text",
        questionKey: null,
        patch: { llmStage: "done", servedQuestionKey: null },
        done: true,
      };
    }
    // Back to the model for the next experience question. `reply: ""` with `done: false` is the
    // caller's signal to take another Phase A turn immediately rather than serve anything.
    return {
      reply: "",
      chips: [],
      inputMode: "text",
      questionKey: null,
      patch: { llmStage: "experience", servedQuestionKey: null },
      done: false,
    };
  }

  /**
   * Fold a turn's findings into the draft.
   *
   * LAST NON-EMPTY WINS for the labels: a worker who corrects their trade three turns in is
   * telling us the first answer was wrong, and keeping the first would preserve a mistake the
   * conversation already fixed. Skills UNION rather than replace — they accumulate across the
   * skills stretch, and a turn that mentions two must not erase the three before it.
   */
  private mergeDraft(
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
}

/** The stage a fresh Phase A starts in. Exported so the orchestrator need not repeat the literal. */
export const INITIAL_LLM_STAGE: LlmInterviewStage = "domain";
