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
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../ai/ai-trace-recorder.service";
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
    // EVERY PHASE A TURN IS A BILLABLE CALL, and this is the only thing that says so. Measured
    // on the first live interview: twelve real `profiling_chat_turn` calls, and ZERO
    // `ai.cost_recorded` events — the ai-service logged them into its own ledger and the
    // platform's cost spine never heard. That is the same defect #738 fixed for STT and #745 for
    // the payer chat turn, on the one path whose entire economic argument is per-profile cost.
    //
    // NAMED `aiCost`, MATCHING THE OTHER FIVE CALL SITES, AND THE RENAME IS A BUG FIX. It was
    // `cost`, and `ai-cost-coverage.test.ts` matches emitter call sites by RECEIVER NAME — so
    // `this.cost.record(...)` matched nothing, this emitter was invisible to the coverage
    // check, and `profiling_chat_turn` sat in its `KNOWN_UNLEDGERED` list under a comment
    // asserting "no apps/api caller". Wrong since #785 shipped this service. The regex is
    // widened in the same change so a future rename cannot repeat it; the consistent name is
    // the belt to that pair of braces.
    private readonly aiCost: AiCostRecorder,
    // 0083 — the sibling of `aiCost` above, and the answer to the question that one cannot
    // reach: the cost row says a `profiling_chat_turn` happened and what it cost, and nothing
    // anywhere said what was asked or what came back. Same six call sites, same metadata, same
    // attribution; a different table and a much stricter read path.
    private readonly aiTraces: AiTraceRecorder,
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
    ctx: {
      readonly workerId: string;
      /**
       * The interview this turn belongs to — `chat_sessions.id`, the same id
       * `ai_jobs.input_ref->>'session_id'` carries for the extraction of the same interview.
       *
       * REQUIRED, not optional, and that is the point. This is the platform's dominant
       * per-profile cost and it is the ONE surface where "what did this profile cost" has an
       * exact answer; an optional field here would let a future caller drop it silently and
       * the number would go quietly wrong rather than loudly missing.
       */
      readonly sessionId: string;
      readonly correlationId: string;
      readonly requestId: string;
    },
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
    const closeGate: Partial<ProfilingEnvelope> = envelope.llmGateOpen
      ? { llmGateOpen: false }
      : {};

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

    const request = {
      schema_version: "oie.v1" as const,
      worker_ref: ctx.workerId,
      stage: envelope.llmStage,
      message_text: text,
      history: [...history],
      draft: envelope.llmDraft,
      experience_count: entries,
      // THE LAST ASK, not a cap already hit: a hit cap returned above without calling at all.
      // This is what lets the model spend its final question on the thing it most needs.
      force_close: asks + 1 >= MAX_LLM_ASKS,
    };

    const out = await this.ai.llmTurn(
      request,
      // BL-19: the SAME pair the cost record below carries, so the far side's trace joins to
      // the request that made it rather than to an id minted inside the client.
      { correlationId: ctx.correlationId, requestId: ctx.requestId },
    );

    // LEDGERED BEFORE THE NULL CHECK, because a turn we could not USE is still a turn that may
    // have been PAID FOR — a reply that failed the contract burned tokens exactly like one that
    // passed. `record` no-ops on null metadata, which is the degraded path (mock posture, a cap,
    // an unreachable service) where there genuinely was no call.
    //
    // NO `ai_job` ID: an interview turn is synchronous and has no async job behind it. The
    // recorder takes null by design — see its own note on the payer chat turn — rather than
    // minting a row in a table every dashboard reads to describe a job that never existed.
    //
    // WHICH IS EXACTLY WHY THE ATTRIBUTION IS PASSED EXPLICITLY. A null `ai_job_id` means
    // there is no `ai_jobs.input_ref` to join through, so before this pair travelled on the
    // event, the single largest line item in a worker's cost — a dozen capable calls per
    // interview — belonged to nobody. "Cost per profile" summed to zero and read as free.
    await this.aiCost.record(
      out?.ai_metadata ?? null,
      "profiling_chat_turn",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );

    // AND THE TRACE (0083), on the same metadata and the same attribution. This is the surface
    // the table was built for: an interview that goes wrong is a sequence of these turns, and
    // until now none of them left any record of what was actually asked or answered — only what
    // it cost. Both ids are present, so the trace is attributable and therefore storable; the
    // session id is what makes "show me this interview, turn by turn" a query rather than a
    // reconstruction.
    //
    // Placed AFTER the cost record and BEFORE the null check, for the same reason the cost
    // record is: a turn that failed the contract is the turn most worth being able to read.
    // Never throws, so it cannot fail the interview.
    await this.aiTraces.capture(
      out?.ai_metadata ?? null,
      "profiling_chat_turn",
      null,
      ctx.correlationId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );

    if (out === null) {
      this.logger.warn(
        `LLM turn unavailable at stage=${envelope.llmStage} asks=${asks} — ` +
          `the engine takes this interview`,
      );
      return null;
    }

    const draft = mergeDraft(envelope.llmDraft, out);

    // THE TURN LANDED, SO PHASE A HAS NOW LED THIS SESSION — recorded here, once, on the far
    // side of the null check so that a turn we could not use is not counted as one the worker saw.
    //
    // WHY THIS COUNTER AND NOT `llmAsks`. `llmAsks` is the runaway budget and skips the
    // gate-opening turn on purpose (see branch 3). `llmLedTurns` answers the different question
    // `selectableEnginePacks` actually asks — "did the platform already interview this worker
    // about their work?" — so it counts EVERY turn Phase A put on screen, the gate included. It is
    // incremented by this service and by nothing else, which is what keeps the trade-pack decision
    // deterministic under §3: the model can shorten Phase A, but it cannot manufacture, inflate or
    // erase the record that Phase A ran.
    const ledTurns = envelope.llmLedTurns + 1;

    // 3. A COMPLETED EXPERIENCE ENTRY HANDS THE NEXT TURN TO THE GATE — unless the entry cap is
    //    now full, in which case there is nothing to offer and Phase A ends here.
    //
    //    `llmAsks` IS NOT INCREMENTED. The model's reply is discarded in favour of the gate, so
    //    the question it wrote was never asked, and counting it would spend a worker's budget on
    //    a question they never saw. `llmLedTurns` IS, and the difference between the two is the
    //    point of having both: the worker was asked about a job and answered — this is the single
    //    most substantive turn Phase A takes — and an interview that consisted of exactly this
    //    turn plus "Nahi" must not be treated as an interview that never ran.
    if (out.experience_entry !== null && draft.experiences.length < MAX_EXPERIENCE_ENTRIES) {
      return {
        kind: "ask",
        reply: EXPERIENCE_GATE_PROMPT,
        chips: [GATE_YES, GATE_NO],
        inputMode: "options_only",
        patch: {
          llmDraft: draft,
          llmStage: "experience",
          llmGateOpen: true,
          llmGateAsked: true,
          llmLedTurns: ledTurns,
        },
      };
    }

    // 3b. THE ENGINE ASKS THE GATE ITSELF BEFORE IT ACCEPTS A CLOSE (#1016) — because branch 3
    //     is not enough, and #1017 could not make it enough.
    //
    //     Branch 3 fires on `experience_entry`, which is the MODEL'S OWN OUTPUT. A model that
    //     runs the experience stretch conversationally and never fills that field takes the gate
    //     off the air for the entire session, then returns `phase_a_done` and lands here — no
    //     error, no fallback, nothing in the logs that names it. That is not hypothetical: it is
    //     the welder session recorded in `llm-interview.orchestrator.test.ts`, where the model
    //     wrote its own gate-shaped question and the worker's "Nahi" ended Phase A. #1017
    //     sharpened the prompt so the model fills the field more reliably, and said in its own
    //     commit message that the API "cannot invent a job the model did not report" — true, and
    //     beside the point. The engine does not need the job to ask the QUESTION.
    //
    //     §3: whether a worker is asked "do you have another job?" is a business decision, and a
    //     decision that evaporates when a model declines to populate a field was never the
    //     engine's. This is the same move #949 made for pack selection, which took that trigger
    //     off model output onto `llmLedTurns`; the gate's own trigger was left behind, and this
    //     is it.
    //
    //     ONCE PER INTERVIEW, and `llmGateAsked` — not the entry count — is what bounds it. A
    //     model that keeps returning `phase_a_done` would otherwise be handed the gate on every
    //     one of those turns, and a worker who already answered it would be asked again, which
    //     is the "asked twice" failure the prompt itself warns the model about.
    //
    //     ONLY WHEN THERE IS ROOM. At the entry cap there is no second job to add, so the
    //     question would be a lie; branch 4 closes as before. The ask budget needs no check —
    //     `llmAsks` is NOT incremented here (branch 3's reasoning verbatim: the model's closing
    //     words are discarded in favour of the gate, so the question it wrote was never asked),
    //     and this turn already passed branch 2, so a "Haan" is guaranteed a real model turn.
    if (
      out.phase_a_done &&
      !envelope.llmGateAsked &&
      draft.experiences.length < MAX_EXPERIENCE_ENTRIES
    ) {
      this.logger.log(
        `Phase A gate served by the engine at phase_a_done ` +
          `experiences=${draft.experiences.length}/${MAX_EXPERIENCE_ENTRIES} asks=${asks}; ` +
          `the model never opened it`,
      );
      return {
        kind: "ask",
        reply: EXPERIENCE_GATE_PROMPT,
        chips: [GATE_YES, GATE_NO],
        inputMode: "options_only",
        patch: {
          llmDraft: draft,
          // `experience`, the last non-terminal rung — the same stage branch 3 writes. A "Haan"
          // falls through to the model on the next turn and it must arrive there knowing the
          // interview is in the experience stretch, not at whatever rung it thought it had left.
          llmStage: "experience",
          llmGateOpen: true,
          llmGateAsked: true,
          llmLedTurns: ledTurns,
        },
      };
    }

    // 4. `phase_a_done` IS THE MODEL'S ADVICE; the caps above are the decision. Either ends it,
    //    and the model's closing words are dropped so the engine's next question stands alone.
    if (out.phase_a_done || draft.experiences.length >= MAX_EXPERIENCE_ENTRIES) {
      return {
        kind: "done",
        patch: {
          ...closeGate,
          llmDraft: draft,
          llmStage: "done",
          llmAsks: asks + 1,
          llmLedTurns: ledTurns,
        },
      };
    }

    return {
      kind: "ask",
      reply: out.reply_text,
      chips: out.suggested_answers,
      inputMode: out.input_mode,
      // `out.stage` IS THE MODEL'S, AND IT MAY NOT SAY `done` HERE (§3). `done` is a legal member
      // of `LLM_INTERVIEW_STAGES`, so the model can return it on a turn that is still ASKING a
      // question — `experience_entry: null`, `phase_a_done: false`, a normal `reply_text` — and
      // this line used to write it through verbatim. That made `llmStage: "done"` reachable on a
      // branch which, being an ask, never runs `settleFromLlmDraft`: the draft was then never
      // settled on this turn, and never on a later one either, because `leads()` is false once
      // the stage reads `done` and Phase A is skipped entirely from then on.
      //
      // Harmless while the engine went on to ask the trade pack anyway. Not harmless now that
      // `selectableEnginePacks` DELETES that pack for a finished interview: the pair produced a
      // worker with no trade signal anywhere — nothing in `answer_map`, nothing in
      // `worker_pack_answer`, nothing in the matching inputs — because the interview was declared
      // over by a field the model controls, before anything it had gathered was written down.
      // The §3 floor two calls away cannot catch it: the experience entries are real and were
      // recorded on earlier turns; it is the SETTLEMENT that never happens.
      //
      // THIS RESTORES A CLAIM THE CONTRACT ALREADY MAKES rather than inventing a rule. The
      // ai-service router says so in as many words (`apps/ai-service/app/routers/profiling.py`):
      // "the API owns progression regardless: `LlmTurnService` decides `done` from its own caps,
      // never from this". It decides `done` at exactly three places above — the answered gate,
      // the caps, and `phase_a_done` under those caps — and an ask turn is none of them. Clamped
      // to `experience`, the last non-terminal rung, so a model that jumps the ladder advances
      // the interview instead of silently ending it.
      patch: {
        ...closeGate,
        llmDraft: draft,
        llmStage: out.stage === "done" ? "experience" : out.stage,
        llmAsks: asks + 1,
        llmLedTurns: ledTurns,
      },
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
 *
 * AN EXPERIENCE ENTRY IS THE LAST ROLE FALLBACK. Both labels default to `null` and an entry may
 * arrive on ANY turn, including the first — the composite opener actively invites it ("aap kaun
 * sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?" answered in one sentence). The
 * entry then opens the Yes/No gate, so a worker can be looking at "Aur koi experience jodna hai?"
 * while the draft has no trade label at all: the conversation recorded a job but never named the
 * work. #916 made that harmless by falling `trade` back to `occupation.label`, but that pin is
 * the DOMAIN ("welder"), not the worker's own role ("pipe fitter welder").
 *
 * The entry already carries `role_label` — the same field, for the job just described — so there
 * is nothing to infer and no extra turn to spend. LAST IN PRECEDENCE, below both the turn's own
 * label and the label the draft already holds, so this fires only when Phase A would otherwise
 * assert nothing; a model that named the role properly always wins. That ordering is also what
 * keeps a SECOND entry from overwriting the first: by then `current.role_label` is set, so an
 * earlier job ("pehle main helper tha") cannot rename the worker's trade.
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
    role_label:
      out.role_label?.trim() ||
      current.role_label ||
      out.experience_entry?.role_label.trim() ||
      null,
    skills,
    experiences: out.experience_entry
      ? [...current.experiences, out.experience_entry]
      : current.experiences,
  };
}
