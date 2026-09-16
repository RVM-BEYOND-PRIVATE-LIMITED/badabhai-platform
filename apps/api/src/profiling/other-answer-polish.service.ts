import { Injectable, Logger } from "@nestjs/common";

import type { ServerConfig } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import type { AiRequestContext } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { TradeFormRepository } from "./form/trade-form.repository";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * "OTHER" ANSWER REVIEW — the round-4 "typed custom answer, everywhere" ruling, verbatim:
 *
 *   "print it after LLM reviews it wrt to the profile he is upto and LLM will correct spelling
 *    mistakes and Nomenclature so the resume doesnt have any errors. If the LLM finds that it is
 *    irrelevant it can omit the reply as well."
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * REUSES THE ADR-0039 WORK-HISTORY-POLISH PRECEDENT (`WorkHistoryPolishService`) DELIBERATELY,
 * both in SHAPE and, for now, in TRANSPORT: pseudonymized input, a display-only rewrite the
 * worker can see and refuse, fail-closed to "print the worker's own words is never allowed here
 * — print NOTHING" when the model is unavailable, mock-postured, over budget, or declines. It
 * calls the SAME `/profiling/work-history/polish` ai-service route `polishWorkHistory` already
 * uses rather than a new one, which is an INTERIM DECISION flagged for AI Systems: it gets this
 * call the SAME real-call gate (`work_history_polish` in `AI_REAL_CALL_TASKS`) and the same
 * digit-grounding / length / re-certification checks for free, but the route's prompt is written
 * for a work-history description and has not been reviewed for arbitrary closed-question "other"
 * text. Dormant by construction either way (see below) — this is a scope note for whoever reviews
 * it before `WORK_HISTORY_POLISH_ENABLED` is armed for this call, not a blocker to landing the
 * write path and the fail-closed contract.
 *
 * ═══ MANDATORY-FIX #1 (RULING SCOPE), SATISFIED BY HAVING NO SEPARATE GATE ═══
 * There is no deterministic pre-check here that can drop a worker's typed text before it reaches
 * this review — `trade-form.service.ts`'s `answer()` (via `triggerOtherAnswerPolish`) hands
 * EVERY non-empty typed "other" answer `recordFor` produces to this same review-or-omit path,
 * fire-and-forget off the response. The only two outcomes this method itself can produce are
 * "the LLM's rewrite is stored" and "nothing is stored" (never a raw, unreviewed string written
 * to `answer_other_text_polished`) — which is exactly the ruling's own scope: the model may omit
 * what it finds irrelevant; nothing here may omit anything else.
 *
 * ═══ MANDATORY-FIX #2 (PAYER SURFACE), ENFORCED ELSEWHERE, NOT HERE ═══
 * This service has NO caller on the payer-facing disclosure path — see
 * `ResumeDisclosureService`'s "LAST-LINE GUARD" and `other-answer-leak-guard.ts`. Its write-back
 * (`TradeFormRepository.savePolishedOtherAnswer`) lands on `worker_pack_answer`, which
 * `WorkerAttributesRepository.loadTradeSheet` (the payer surface's own source) never reads.
 *
 * ═══ NO WORKER-FACING READER EITHER, YET — SAID PLAINLY RATHER THAN LEFT IMPLICIT ═══
 * Wiring the caller closes the "dead code" half of the finding this docblock used to overstate:
 * `review()` is reachable and `answer_other_text_polished` is actually computed and persisted
 * now. What is still true is that NOTHING READS THAT COLUMN FOR DISPLAY ANYWHERE, worker-facing
 * or otherwise. `TradeFormService.questionScreen`'s `other_text` and
 * `ProfilingSessionService.displayValueOf` are the only two places a worker's own "other" answer
 * is shown back to him today, and BOTH deliberately serve the raw typed text by their own
 * documented design (the form's edit surface and the interview's pre-submit review) — reversing
 * that is a product call, not a wiring gap this service can close on its own. The column is
 * written for the first surface built to read it; until one exists, "print it after LLM
 * reviews it" is satisfied up to the print step and stops there.
 */
@Injectable()
export class OtherAnswerPolishService {
  private readonly logger = new Logger(OtherAnswerPolishService.name);

  constructor(
    private readonly ai: AiService,
    private readonly repo: TradeFormRepository,
    private readonly aiCost: AiCostRecorder,
  ) {}

  /**
   * Review ONE "other" answer and return the text to PRINT on the worker's own sheet — the
   * rewrite when the model vouches for one, otherwise `null`, which the caller must read as
   * "print nothing for this answer", never as "print the raw text".
   *
   * ONE CALL PER ANSWER, EVER, on the same mechanism `WorkHistoryPolishService.polishAttribute`
   * uses: the result is written to `answer_other_text_polished` and this returns early once one
   * is stored, or once the worker has declined it (`answer_other_text_polished_declined`) — a
   * refusal is not an absence (ADR-0039's rule, applied here unchanged).
   */
  async review(
    workerId: string,
    packId: string,
    questionKey: string,
    ownText: string,
    contextLabel: string,
    ctx: AiRequestContext,
    config: Pick<ServerConfig, "WORK_HISTORY_POLISH_ENABLED">,
    already: { polished: string | null; declined: boolean },
  ): Promise<string | null> {
    if (already.declined) return null;
    if ((already.polished ?? "").trim() !== "") return already.polished as string;
    if (!config.WORK_HISTORY_POLISH_ENABLED) return null;
    const text = ownText.trim();
    if (!text) return null;

    let result: string | null;
    try {
      const out = await this.ai.polishWorkHistory(
        {
          schema_version: "oie.v1",
          // PSEUDONYMOUS BY CONSTRUCTION, same contract as the work-history call this reuses:
          // the worker id is the billing/trace reference; nothing else identity-shaped crosses.
          worker_ref: workerId,
          work_done: text.slice(0, 300),
          role_label: contextLabel.slice(0, 80),
        },
        ctx,
      );

      // LEDGER THE SPEND, same rule `WorkHistoryPolishService.polishOne` states (#738): recorded
      // whatever the answer was, including a null rewrite, because a rejected review still burns
      // tokens and a ledger that only counts successes understates the true cost.
      await this.aiCost.record(
        out?.ai_metadata ?? null,
        "work_history_polish",
        null,
        ctx.correlationId ?? "",
        ctx.requestId ?? "",
        { workerId },
      );

      const rewritten = out?.work_done?.trim();
      result = rewritten ? rewritten : null;
    } catch (err) {
      // Never throws into a caller that may be a render or a request path — logged, not
      // surfaced, matching `WorkHistoryPolishService.polishOne`.
      this.logger.warn(
        `'other' answer review threw for worker ${workerId} question ${questionKey}; printing ` +
          `nothing for this answer (${err instanceof Error ? err.message : "unknown"})`,
      );
      result = null;
    }

    if (result === null) return null;

    // WRITE-BACK IS BEST-EFFORT — a failed persist costs one model call on the next read, never
    // this call's output, which is already computed and already correct.
    try {
      await this.repo.savePolishedOtherAnswer(workerId, packId, questionKey, result);
    } catch (err) {
      this.logger.warn(
        `could not persist the polished 'other' answer for worker ${workerId} question ` +
          `${questionKey}; this read is unaffected and the next one will retry ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    return result;
  }
}
