import { Injectable, Logger } from "@nestjs/common";

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import type { AiRequestContext } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { EventsService } from "../events/events.service";
import { tradeResumeMapFor } from "../resume/trade-resume-map";
import { TradeFormRepository } from "./form/trade-form.repository";
import {
  encodeOtherAnswerReview,
  readOtherAnswerReview,
  reviewedTextFingerprint,
} from "./other-answer-review-record";
import { PackRegistryService } from "./pack-registry.service";
import { descriptorForPack } from "./roles/role-registry";

/** One typed answer to review: whose, which question, and what he wrote. */
export interface OtherAnswerReviewTarget {
  readonly workerId: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly item: QuestionPackItem;
  readonly ownText: string;
}

/**
 * The API-side lock, ADR-0039's two-lock posture for a printed AI rewrite: `WORK_HISTORY_POLISH_ENABLED`
 * here, `work_history_polish` (the task the review rides) in the ai-service's `AI_REAL_CALL_TASKS`
 * there. Either one off means
 * no NEW answer is reviewed. Only this one hides what is already stored: off, the render prints
 * no typed answer at all (and no work-history rewrite either, which shares it).
 */
export type OtherAnswerReviewConfig = Pick<ServerConfig, "WORK_HISTORY_POLISH_ENABLED">;

/** What the column already holds for this answer, read by the caller. */
export interface OtherAnswerAlready {
  readonly polished: string | null;
  readonly declined: boolean;
}

/**
 * The most reviews one résumé render may start. A worker types "Koi aur" on a handful of
 * questions at most; the cap bounds a render's spend and latency if that is ever not true. An
 * answer over the cap is reviewed on the next render.
 */
export const MAX_OTHER_ANSWER_REVIEWS_PER_RENDER = 8;

/**
 * How many of those run at once. Each is one short model call under the ai-service deadline, so a
 * render with several typed answers waits for about two of them rather than for all in turn.
 */
const RENDER_REVIEW_CONCURRENCY = 4;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * "KOI AUR — KHUD LIKHEIN" REVIEW (#2409) — a worker's typed answer to a closed-option form
 * question, checked before it may print on HIS OWN résumé and Resume screen.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S RULES (2026-10-22). It prints only if it relates to the worker's TRADE, fits the
 * FIELD it was typed in (a real machine under machines, a real tool under tools), and is not
 * vulgar, irrelevant or junk. Two inputs decide it: the trade and the field. What prints is the
 * AI-cleaned names, and only the parts that pass. Display only: nothing here reaches matching.
 *
 * WHERE EACH RULE LIVES. The ai-service route (`/profiling/other-answer/review`) holds the prompt
 * and the deterministic walls (abuse, the gateway, the ADR-0047 G1 floor, length, grounding).
 * This service supplies the two deciding inputs: the TRADE from the role descriptor, the FIELD
 * from the résumé row the question prints in, with the pack's own options as examples.
 *
 * ONLY A QUESTION THAT PRINTS IS REVIEWED. A question with no capability row on the trade's
 * résumé map can never show the answer, so it costs nothing.
 *
 * ONE CALL PER ANSWER, EVER. A settled review (`reviewed: true`) is stored as a versioned record
 * (`other-answer-review-record.ts`), including "nothing prints", and every later render reads it
 * back. A degrade (unreachable, mock posture, deadline) stores nothing and the next render asks
 * again. Every outcome that is not a settled list of names prints NOTHING; the raw text never
 * prints.
 *
 * WORKER'S OWN COPY ONLY. The employer portal's masked copy reads `worker_attributes` through
 * `loadTradeSheet`, never this column, and `resume-render-input.ts` drops `otherAnswers` on any
 * payer render as well.
 */
@Injectable()
export class OtherAnswerPolishService {
  private readonly logger = new Logger(OtherAnswerPolishService.name);

  constructor(
    private readonly ai: AiService,
    private readonly repo: TradeFormRepository,
    private readonly aiCost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly packs: PackRegistryService,
  ) {}

  /**
   * Review ONE typed answer and return the names that may print: a list (possibly empty) once a
   * review has settled, or `null` when there is no decision, which the caller reads as "print
   * nothing for this answer yet".
   *
   * NEVER THROWS. It runs fire-and-forget off the answer request and inside a résumé render, and
   * neither may fail because a review did.
   */
  async review(
    target: OtherAnswerReviewTarget,
    ctx: AiRequestContext,
    config: OtherAnswerReviewConfig,
    already: OtherAnswerAlready,
  ): Promise<readonly string[] | null> {
    if (!config.WORK_HISTORY_POLISH_ENABLED) return null;
    if (already.declined) return null;
    const stored = readOtherAnswerReview(already.polished, target.ownText);
    if (stored !== null) return stored;

    const text = target.ownText.trim();
    const context = reviewContext(target.packId, target.item);
    if (!text || context === null) return null;

    let items: readonly string[];
    try {
      const out = await this.ai.reviewOtherAnswer(
        {
          schema_version: "oie.v1",
          // The billing and trace reference; nothing identity-shaped crosses beside the text.
          worker_ref: target.workerId,
          text: text.slice(0, 300),
          trade_label: context.trade,
          field_label: context.field,
          question_text: target.item.prompt_text.slice(0, 200),
          example_options: context.examples,
        },
        ctx,
      );

      // LEDGERED WHATEVER THE ANSWER WAS: a rejected review still spends tokens (#738). Under the
      // polish task it rides (owner decision 2026-10-22): the ai-service runs it as
      // `work_history_polish`, armed in production, and the ledger must name what was charged.
      await this.aiCost.record(
        out?.ai_metadata ?? null,
        "work_history_polish",
        null,
        ctx.correlationId ?? "",
        ctx.requestId ?? "",
        { workerId: target.workerId },
      );

      if (out === null || !out.reviewed) return null;
      items = out.items;
    } catch (err) {
      this.logger.warn(
        `'other' answer review threw for worker ${target.workerId} question ` +
          `${target.item.question_key}; printing nothing for it ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
      return null;
    }

    // BEST-EFFORT WRITE-BACK: a failed persist costs one more review on the next render, never
    // this call's already-settled answer.
    let saved = false;
    try {
      saved = await this.repo.savePolishedOtherAnswer(
        target.workerId,
        target.packId,
        target.item.question_key,
        encodeOtherAnswerReview(items, target.ownText),
        target.ownText,
      );
    } catch (err) {
      this.logger.warn(
        `could not store the 'other' answer review for worker ${target.workerId} question ` +
          `${target.item.question_key}; the next render reviews it again ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    // RECORDED ONCE, WHEN IT IS DURABLE. An unsaved review (a failed write, or the worker changed
    // his answer mid-flight) is reviewed again on the next render; emitting now would count it twice.
    if (saved) await this.emitReviewed(target, items, ctx);
    return items;
  }

  /**
   * Every typed answer on this worker's pack that may print, by question key, for HIS OWN
   * résumé render (#2409). Reviews what has no settled review yet, up to
   * {@link MAX_OTHER_ANSWER_REVIEWS_PER_RENDER}; an answer with no decision is left out, and the
   * row prints exactly what it printed before.
   *
   * A SETTLED EMPTY REVIEW IS INCLUDED AS `[]`. The worker's current answer to that question is
   * the typed text (the form keeps one value per question), so a stale ticked row for it must
   * not print in its place.
   *
   * NEVER THROWS: a failed read costs the typed answers, never the render.
   */
  async reviewedForResume(
    workerId: string,
    packId: string | null,
    ctx: AiRequestContext,
    config: OtherAnswerReviewConfig,
  ): Promise<Record<string, readonly string[]>> {
    const out: Record<string, readonly string[]> = {};
    // THE RENDERER HALF OF THE LOCK, as `polishEnabled` is for the work-history rewrite: off,
    // not even a stored review prints, so the switch reverts every sheet on its next render.
    if (!config.WORK_HISTORY_POLISH_ENABLED) return out;
    if (!packId || !tradeResumeMapFor(packId)) return out;
    try {
      const rows = await this.repo.listAnswers(workerId, packId);
      const pending: OtherAnswerReviewTarget[] = [];
      for (const row of rows) {
        if (row.status !== "answered" || !row.answerOtherText) continue;
        if (row.answerOtherTextPolishedDeclined) continue;
        const stored = readOtherAnswerReview(row.answerOtherTextPolished, row.answerOtherText);
        if (stored !== null) {
          out[row.questionKey] = stored;
          continue;
        }
        if (pending.length >= MAX_OTHER_ANSWER_REVIEWS_PER_RENDER) continue;
        const item = await this.packItem(row.packId, row.packVersion, row.questionKey);
        if (!item || reviewContext(packId, item) === null) continue;
        pending.push({
          workerId,
          packId,
          packVersion: row.packVersion,
          item,
          ownText: row.answerOtherText,
        });
      }
      for (let i = 0; i < pending.length; i += RENDER_REVIEW_CONCURRENCY) {
        const batch = pending.slice(i, i + RENDER_REVIEW_CONCURRENCY);
        const settled = await Promise.all(
          batch.map((target) =>
            this.review(target, ctx, config, { polished: null, declined: false }),
          ),
        );
        batch.forEach((target, index) => {
          const items = settled[index];
          if (items !== null && items !== undefined) out[target.item.question_key] = items;
        });
      }
    } catch (err) {
      this.logger.warn(
        `could not read the 'other' answers for worker ${workerId}; rendering without them ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    return out;
  }

  private async packItem(
    packId: string,
    version: number,
    questionKey: string,
  ): Promise<QuestionPackItem | undefined> {
    const pack = await this.packs.loadPinned(packId, version, Date.now());
    return pack?.items.find((item) => item.question_key === questionKey);
  }

  private async emitReviewed(
    target: OtherAnswerReviewTarget,
    items: readonly string[],
    ctx: AiRequestContext,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.other_answer_reviewed",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: target.workerId },
        // IDS, A CLOSED OUTCOME AND A COUNT. Never the typed text, never the printed names.
        payload: {
          worker_id: target.workerId,
          pack_id: target.packId,
          pack_version: target.packVersion,
          question_key: target.item.question_key,
          outcome: items.length > 0 ? "accepted" : "rejected",
          item_count: items.length,
        },
        // ONE REVIEW OF ONE TEXT IS ONE EVENT. The answer-time review and a render that starts
        // before it lands can both review the same words; the spine counts that once.
        idempotencyKey:
          `profile.other_answer_reviewed:${target.workerId}:${target.packId}:` +
          `${target.item.question_key}:${reviewedTextFingerprint(target.ownText)}`,
        correlationId: ctx.correlationId ?? undefined,
        requestId: ctx.requestId ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `the 'other' answer review for worker ${target.workerId} was not recorded ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }
}

/**
 * The two deciding inputs for one question, or `null` when the answer can never print: no role
 * descriptor for the pack (no trade to judge against) or no résumé row for the question.
 */
function reviewContext(
  packId: string,
  item: QuestionPackItem,
): { trade: string; field: string; examples: string[] } | null {
  const trade = descriptorForPack(packId)?.displayName;
  const field = tradeResumeMapFor(packId)?.capability.find(
    (row) => row.from === item.question_key,
  )?.label;
  if (!trade || !field) return null;
  return {
    trade: trade.slice(0, 80),
    field: field.slice(0, 80),
    // The pack's real options, not its escapes: "Koi aur machine" says nothing about the field.
    examples: item.options
      .filter((option) => !option.is_none_of_above)
      .map((option) => option.label_text.slice(0, 80))
      .filter((label) => label.length > 0)
      .slice(0, 30),
  };
}
