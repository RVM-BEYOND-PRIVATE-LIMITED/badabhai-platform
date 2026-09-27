/**
 * ONE turn of the general road's SKILLS stage (ADR-0045), and the caps that bound it.
 *
 * A worker whose role is outside the 21 predefined roles has their role settled by today's Phase
 * A; this stage then asks ONLY for skills (`interview_mode: "skills_only"` on the same ai-service
 * route and task type), and ends at a deterministic gate — the certified skills as bullets, then
 * "Kya aur koi skill jodni hai?" [Haan] [Nahi]. Haan (or a typed skill) returns to the stage;
 * Nahi closes the chat with the general-form card.
 *
 * WHAT THIS IS NOT. It is not the lane decision, the handover or the persistence — the
 * orchestrator owns those, exactly as it owns them for Phase A. This decides ONE thing: what the
 * skills stage puts on screen this turn. Unlike `LlmTurnService` it NEVER returns "engine, you
 * go": the skills lane has no engine to fall back to, so a model that is unavailable ends the
 * stage at the gate (or, with nothing gathered, at the form) instead.
 *
 * WHY THE CAPS LIVE HERE. The ai-service is stateless; a model told to stop after N questions
 * cannot count to N. Every cap is checked BEFORE the call, so a runaway costs nothing, and
 * `force_close` marks the last call: the ai-service tells the model not to ask anything more, so
 * that turn harvests the worker's answer and the stage goes to the gate.
 *
 * THE GATE IS OURS, NOT THE MODEL'S (the Phase A experience-gate rule, again). A model reply that
 * asks its own "aur koi skill?" is replaced by the real gate (`classifySkillsReply`), so the loop
 * is always exactly two chips with the keyboard locked, and termination is deterministic.
 *
 * PRIVACY. Every model-returned skill passes `certifySkills` (the API's second wall, after the
 * ai-service's) before it is shown or stored; the gate is built only from certified skills; and
 * nothing here logs a skill, a chip or a worker's words — counts only.
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LlmTurnInput, TranscriptLine } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import type { SkillsGateReply, SkillsStageOutcome } from "@badabhai/types";

import { AiService } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../ai/ai-trace-recorder.service";
import { SERVER_CONFIG } from "../config/config.module";
import type { GeneralRoadState, ProfilingEnvelope } from "./conversation-state";
import { classifySkillsReply } from "./llm-reply-guard";
import { certifySkillLabel, certifySkills, MAX_SKILLS, skillKey } from "./skill-certifier";
import {
  isSkillsStageStop,
  readSkillsGateReply,
  SKILLS_ADD_PROMPT,
  skillsGatePrompt,
} from "./skills-gate";

/** Model skills questions per session (ADR-0045 §6). Checked before the call. */
export const MAX_SKILLS_ASKS = 16;
/** Consecutive answers that add no new certified skill before the stage goes to the gate. */
export const MAX_STALE_SKILL_TURNS = 2;
/** How many times the gate may be served; the next would-be gate hands over instead. */
export const MAX_SKILLS_GATE_ROUNDS = 4;
/**
 * The most model-returned skill candidates certified per turn. `LlmTurnOutputSchema.skills` is
 * UNBOUNDED on the contract, and each candidate costs a pass through every wall — a runaway or
 * prompt-injected reply must not be able to buy an unbounded amount of work. A worker's single
 * message naming more than a dozen distinct skills is not a real case.
 */
export const MAX_SKILL_CANDIDATES_PER_TURN = 12;
/** Chips shown under a skills question — the persona's cap. */
const MAX_SKILL_CHIPS = 4;

/**
 * What one skills turn decided.
 *
 * `road` is the WHOLE next general-road state — the orchestrator folds it in as-is. `gateReply`
 * is set only on a turn that answered the gate, and `gateRound` is the round that was answered;
 * together they are the `profile.skills_gate_answered` event.
 */
export type SkillsTurnResult =
  | {
      readonly kind: "ask";
      readonly reply: string;
      readonly chips: readonly string[];
      readonly road: GeneralRoadState;
      readonly gateReply: SkillsGateReply | null;
      readonly gateRound: number;
    }
  | {
      readonly kind: "gate";
      readonly reply: string;
      readonly road: GeneralRoadState;
      readonly gateReply: SkillsGateReply | null;
      readonly gateRound: number;
    }
  | {
      readonly kind: "handover";
      readonly outcome: SkillsStageOutcome;
      readonly road: GeneralRoadState;
      readonly gateReply: SkillsGateReply | null;
      readonly gateRound: number;
    };

/** Why the stage is ending, which decides the outcome when there is nothing to gate. */
type EndReason = "done" | "capped" | "unavailable";

@Injectable()
export class SkillsTurnService {
  private readonly logger = new Logger(SkillsTurnService.name);

  constructor(
    private readonly ai: AiService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Named `aiCost` / `aiTraces` like every other emitter: `ai-cost-coverage.test.ts` matches
    // call sites by receiver shape, and a skills turn is the same billable `profiling_chat_turn`.
    private readonly aiCost: AiCostRecorder,
    private readonly aiTraces: AiTraceRecorder,
  ) {}

  /**
   * Should a NEW chat session be armed for the general road? Read ONCE, when the envelope is
   * created — the stamp, not this, decides every later turn, so a flag flip never switches
   * engines mid-interview. Needs the LLM interview too: the skills stage is model-led.
   */
  armed(): boolean {
    return (
      this.config.CHAT_GENERAL_ROAD_ENABLED === true &&
      this.config.CHAT_LLM_INTERVIEW_ENABLED === true
    );
  }

  /**
   * Take one skills turn.
   *
   * `entering` is true on the turn the lane is decided: `text` is then the worker's ROLE answer —
   * harvested for skills, never read as a stop word.
   */
  async take(
    envelope: ProfilingEnvelope,
    text: string,
    history: readonly TranscriptLine[],
    ctx: {
      readonly workerId: string;
      readonly sessionId: string;
      readonly correlationId: string;
      readonly requestId: string;
    },
    opts: { readonly entering: boolean },
  ): Promise<SkillsTurnResult> {
    let road = envelope.generalRoad;
    const gateRound = road.gateRounds;
    let gateReply: SkillsGateReply | null = null;
    // A non-yes/no reply at the gate: the skills model reads it, and whether it named a skill
    // decides `typed` (back to the stage) or `unclear` (treated as Nahi, counted apart).
    let typedAtGate = false;
    // A "haan" at the gate is not an answer to a model question — it must not count as stale.
    let fromGate = false;

    // 1. THE GATE OWNS THE TURN when it is on screen, read without a model call.
    if (road.gateOpen) {
      const read = readSkillsGateReply(text);
      road = { ...road, gateOpen: false };
      if (read === "done") {
        return this.handover(road, "confirmed", "done", gateRound);
      }
      fromGate = true;
      if (read === "add") gateReply = "add";
      else typedAtGate = true;
    } else if (!opts.entering && isSkillsStageStop(text)) {
      // 2. "bas / itna hi / aur kuch nahi" mid-stage — the worker has said they are done. No model
      //    call. A BARE "nahi" is not one: it answers an open per-area question, and the model
      //    reads it as that area being empty (see `isSkillsStageStop`).
      return this.toGate(road, "done", null, gateRound);
    }

    // 3. CAPS AND THE KILL SWITCH, BEFORE THE CALL, so a runaway costs nothing. A gate answer
    //    that cannot be served — a reply typed there cannot be read without the model, and a
    //    "Haan" cannot be followed by a question — HANDS OVER with the true outcome rather than
    //    re-serving the same locked gate. A "Haan" needs room for at least one more question.
    const atCap = road.skillsAsks >= MAX_SKILLS_ASKS || road.skills.length >= MAX_SKILLS;
    if (atCap || (fromGate && road.skillsAsks + 1 >= MAX_SKILLS_ASKS)) {
      if (fromGate) return this.handover(road, "capped", gateReply ?? "unclear", gateRound);
      return this.toGate(road, "capped", gateReply, gateRound);
    }
    if (this.config.CHAT_LLM_INTERVIEW_ENABLED !== true) {
      // The LLM interview's own switch stays a live spend kill switch on this stage too.
      if (fromGate) return this.handover(road, "unavailable", gateReply ?? "unclear", gateRound);
      return this.toGate(road, "unavailable", gateReply, gateRound);
    }

    const forceClose = road.skillsAsks + 1 >= MAX_SKILLS_ASKS;
    const request: LlmTurnInput = {
      schema_version: "oie.v1",
      worker_ref: ctx.workerId,
      stage: "skills",
      message_text: text,
      history: [...history],
      // ONLY what this stage may echo: the settled, certified role and the certified skills. No
      // experiences — the stage never asks about them (the ai-service drops them anyway).
      draft: {
        domain_label: road.domainLabel,
        role_label: road.roleLabel,
        skills: [...road.skills],
        experiences: [],
      },
      experience_count: 0,
      force_close: forceClose,
      interview_mode: "skills_only",
    };
    const out = await this.ai.llmTurn(request, {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    // LEDGERED BEFORE THE NULL CHECK — a turn we could not use may still have been paid for.
    // Same task type and attribution as a Phase A turn: this IS a `profiling_chat_turn`.
    await this.aiCost.record(
      out?.ai_metadata ?? null,
      "profiling_chat_turn",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );
    await this.aiTraces.capture(
      out?.ai_metadata ?? null,
      "profiling_chat_turn",
      null,
      ctx.correlationId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );

    if (out === null) {
      this.logger.warn(
        `skills turn unavailable session=${ctx.sessionId} asks=${road.skillsAsks} ` +
          `skills=${road.skills.length}; the stage goes to the gate`,
      );
      // After a gate answer the same gate must not come straight back: hand over, honestly.
      if (fromGate) return this.handover(road, "unavailable", gateReply ?? "unclear", gateRound);
      return this.toGate(road, "unavailable", gateReply, gateRound);
    }

    // 4. CERTIFY AND MERGE. Grounded in THIS turn's words: the worker's own message is the only
    //    licence a skill has. Bounded first — the contract list is unbounded.
    const certified = certifySkills(out.skills.slice(0, MAX_SKILL_CANDIDATES_PER_TURN), {
      workerText: text,
      held: road.skills,
      roleLabel: road.roleLabel,
      domainLabel: road.domainLabel,
    });
    const added = certified.kept.length;
    road = {
      ...road,
      skills: [...road.skills, ...certified.kept],
      rejectedCount: road.rejectedCount + certified.rejected,
      // Stale only when the worker answered a skills question and nothing new landed. The
      // entering turn's text is the ROLE answer, not a skills answer: counting it left a worker
      // whose role answer named no skill ONE empty skills answer before the form, not two (§6).
      //
      // A GATE ANSWER STARTS A FRESH WINDOW (review, Phase 2b): the gate is usually reached by two
      // empty answers, so carrying that count through a "Haan" would end the stage again on the
      // very turn the worker asked to add more.
      staleTurns: added > 0 || fromGate ? 0 : opts.entering ? road.staleTurns : road.staleTurns + 1,
      skillsAsks: road.skillsAsks + 1,
    };
    if (certified.rejected > 0) {
      // COUNTS ONLY. What was refused is exactly what must never be logged.
      this.logger.log(
        `skills turn refused ${certified.rejected} candidate(s) session=${ctx.sessionId}`,
      );
    }
    if (typedAtGate) {
      gateReply = added > 0 ? "typed" : "unclear";
      if (added === 0) return this.handover(road, "confirmed", "unclear", gateRound);
    }

    // 5. END THE STAGE? The model's `phase_a_done` is advisory; the caps and the stale count are
    //    ours. A reply the worker must not see — the system's own gate question, a repeat, or a
    //    question off the skills topic (years, salary, employer) — is never served.
    const usable =
      classifySkillsReply(out.reply_text, history) === "ok" &&
      !isOffTopicSkillsReply(out.reply_text);
    if (forceClose || certified.capped || road.skills.length >= MAX_SKILLS) {
      return this.toGate(road, "capped", gateReply, gateRound);
    }
    const chips = this.certifiedChips(out.suggested_answers, road);
    if (gateReply === "add" && added === 0) {
      // THE WORKER SAID "HAAN" AND NAMED NOTHING YET: they must be asked WHICH skill, whatever the
      // model reported. The model's own question when it is servable, else the engine's — never
      // the same locked gate again (which is what a repeat of the prompt-mandated "Kaunsi skill
      // jodni hai?" used to trigger from the second round on).
      return {
        kind: "ask",
        reply: usable ? out.reply_text : SKILLS_ADD_PROMPT,
        chips: usable ? chips : [],
        road,
        gateReply,
        gateRound,
      };
    }
    if (out.phase_a_done || road.staleTurns >= MAX_STALE_SKILL_TURNS || !usable) {
      return this.toGate(road, "done", gateReply, gateRound);
    }

    return { kind: "ask", reply: out.reply_text, chips, road, gateReply, gateRound };
  }

  /**
   * The gate when there is something to confirm, else the handover.
   *
   * ZERO SKILLS SKIP THE GATE (ADR-0045 §6): a bullet list of nothing followed by "any more?" is
   * a question with no referent. The gate is also bounded — past `MAX_SKILLS_GATE_ROUNDS` the
   * next would-be gate hands over, so a worker who keeps saying Haan without naming anything
   * cannot loop.
   */
  private toGate(
    road: GeneralRoadState,
    reason: EndReason,
    gateReply: SkillsGateReply | null,
    gateRound: number,
  ): SkillsTurnResult {
    if (road.skills.length === 0) {
      const outcome: SkillsStageOutcome =
        reason === "unavailable" ? "unavailable" : reason === "capped" ? "capped" : "no_skills";
      return this.handover(road, outcome, gateReply, gateRound);
    }
    if (road.gateRounds >= MAX_SKILLS_GATE_ROUNDS) {
      return this.handover(road, "capped", gateReply, gateRound);
    }
    return {
      kind: "gate",
      reply: skillsGatePrompt(road.skills),
      // The stale window restarts at every gate — see the `staleTurns` rule in `take`.
      road: { ...road, gateOpen: true, gateRounds: road.gateRounds + 1, staleTurns: 0 },
      gateReply,
      gateRound,
    };
  }

  private handover(
    road: GeneralRoadState,
    outcome: SkillsStageOutcome,
    gateReply: SkillsGateReply | null,
    gateRound: number,
  ): SkillsTurnResult {
    return {
      kind: "handover",
      outcome,
      road: { ...road, gateOpen: false, outcome },
      gateReply,
      gateRound,
    };
  }

  /**
   * The model's chips, as the worker may see them: each one a certified skill label (a tap
   * sends it back as the worker's answer, so it passes the same wall), never one already held,
   * never twice, at most four. Not grounded — a chip is an offer, and the tap is the grounding.
   */
  private certifiedChips(chips: readonly string[], road: GeneralRoadState): string[] {
    // The ROLE itself is never a chip either: `certifySkills` refuses it when tapped, so offering
    // it would spend the worker's tap on an answer that is then counted as empty.
    const seen = new Set([
      ...road.skills.map(skillKey),
      ...[road.roleLabel, road.domainLabel].filter((l): l is string => l !== null).map(skillKey),
    ]);
    const kept: string[] = [];
    for (const chip of chips.slice(0, MAX_SKILL_CHIPS * 2)) {
      const label = certifySkillLabel(chip);
      if (label === null) continue;
      const key = skillKey(label);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(label);
      if (kept.length === MAX_SKILL_CHIPS) break;
    }
    return kept;
  }
}

/**
 * A model question OFF THE SKILLS TOPIC (ADR-0045): years or tenure, salary, or an employer.
 *
 * The prompt forbids these, but model output is untrusted (CLAUDE.md §11) and the history already
 * carries Phase A's "… aur kitna tajurba hai?". On this lane the answer would be thrown away —
 * experience is never cross-filled (R5) and no skill certifies — and the general form asks the
 * same fact again; an employer question also invites a name into the transcript. QUANTITY forms
 * only ("kitne saal", "kitna experience"), so "Kis software ka experience hai?" stays servable.
 */
const OFF_TOPIC_SKILLS_REPLY =
  /\b(?:kitne|kitna|kitni)\s+(?:saal|sal|mahine|mahina|varsh|baras|time|samay|tajurba|experience|anubhav)\b|\bkab\s+se\b|\b(?:salary|tankhwah|tankhah|pagaar|pagar|vetan)\b|\bkitna\s+kama|\b(?:company|kampani|kampni|employer|malik|seth|firm)\b/iu;

function isOffTopicSkillsReply(reply: string): boolean {
  return OFF_TOPIC_SKILLS_REPLY.test(reply.normalize("NFKC"));
}
