import { Injectable, Logger } from "@nestjs/common";

import type { ServerConfig } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import type { AiRequestContext } from "../ai/ai.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * WORK-HISTORY POLISH — the one field on this sheet the model is allowed to COMPOSE (#1350).
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * §8 of the Resume Engine guideline, which every other printed string on this page obeys:
 *
 *   "The model extracts, normalises and classifies. It never composes. Every printed string on
 *    a BadaBhai resume originates from one of exactly three sources: a closed vocabulary label,
 *    a number the worker stated, or the worker's own words rendered verbatim. THERE IS NO
 *    FOURTH SOURCE."
 *
 * #1350 is the owner ruling that overrides that sentence for work-history descriptions and for
 * nothing else. Read it before reusing this anywhere.
 *
 * ── WHY IT RUNS HERE, ON THE RENDER, AND NOT AT CAPTURE ────────────────────────────────────
 *
 * The obvious home is `WorkerEmploymentService.replaceForWorker`, where the worker submits the
 * form. It is the wrong one: that is the worker's request path, on a phone, often on 2G, and a
 * model call there makes them wait on a rewrite whose only consumer is a PDF rendered later.
 * The render already runs on a queue, off that path, and already loads the employments.
 *
 * ONE CALL PER STINT, EVER, because the result is written back to `work_done_polished` and this
 * only visits stints where that column is null. A re-render of an unchanged history spends
 * nothing. An EDITED stint is re-polished for free: the writer replaces the whole history, so a
 * changed description arrives as a new row with a null polish.
 *
 * ── EVERY FAILURE COSTS POLISH, NEVER A DESCRIPTION ────────────────────────────────────────
 *
 * The far side returns null on a blocked input, a mock posture, a deadline, a decline, an
 * ungrounded digit, an over-length line, or a rewrite the gateway will not vouch for. Null
 * leaves `work_done_polished` null and the sheet prints the worker's own words — which is what
 * it printed before this existed. Nothing here may throw into the render: a resume that fails
 * to render is a strictly worse outcome than one that renders in Hinglish.
 */
/**
 * How long ONE render may spend rewriting work history, across every stint.
 *
 * A CEILING ON THE LOOP, not on a call — `WORK_HISTORY_POLISH_TIMEOUT_MS` bounds each call at
 * 23 s so the ai-service's own 20 s deadline is reachable. This bounds the SUM, because the loop
 * is sequential and a worker may file nine stints. 60 s buys the four-employer history the
 * guideline's zone map budgets for (§11 #7) with room for one slow provider retry, and stops the
 * tail from turning a render into a multi-minute job.
 *
 * NOT A FAILURE WHEN IT FIRES. The stints it skips keep a null polish, which is precisely the
 * work-list the next render reads — so the cost of the bound is one deferred rewrite, not a lost
 * one, and the sheet prints the worker's own words in the meantime.
 */
const POLISH_WALL_CLOCK_BUDGET_MS = 60_000;

@Injectable()
export class WorkHistoryPolishService {
  private readonly logger = new Logger(WorkHistoryPolishService.name);

  constructor(
    private readonly ai: AiService,
    private readonly employments: WorkerEmploymentRepository,
    private readonly attributes: WorkerAttributesRepository,
    private readonly aiCost: AiCostRecorder,
  ) {}

  /**
   * Polish every stint that has a description and no polish yet, and return the records with
   * the results folded in.
   *
   * RETURNS THE UPDATED RECORDS rather than asking the caller to re-read. The write-back is for
   * the NEXT render; this render uses what it just computed, so a first render prints polished
   * text rather than waiting for a second one to pick it up.
   */
  async polish(
    workerId: string,
    records: readonly WorkerEmploymentRecord[],
    ctx: AiRequestContext,
    config: Pick<ServerConfig, "WORK_HISTORY_POLISH_ENABLED">,
  ): Promise<readonly WorkerEmploymentRecord[]> {
    if (!config.WORK_HISTORY_POLISH_ENABLED) return records;

    const pending = records.flatMap((employment) =>
      employment.roles.filter(
        (role) =>
          role.id !== undefined &&
          (role.workDone?.trim().length ?? 0) > 0 &&
          (role.workDonePolished ?? null) === null &&
          // A REFUSAL IS NOT AN ABSENCE (#1354). Without this the worker's decision would
          // survive exactly until the next re-render: the polish is null because they declined
          // it, and a null polish is precisely what this filter treats as work to do.
          role.workDonePolishDeclined !== true,
      ),
    );
    if (pending.length === 0) return records;

    const polished = new Map<string, string>();
    const startedAt = Date.now();
    let abandoned = 0;
    for (const role of pending) {
      // SEQUENTIAL, NOT PARALLEL. A worker has at most four employers and a handful of stints,
      // and firing them together would put a burst on the provider's per-minute quota for a
      // job that is already off the request path and in no hurry.
      //
      // BOUNDED IN AGGREGATE, and that bound is what makes the per-call budget safe to raise.
      // `WORK_HISTORY_POLISH_TIMEOUT_MS` is 23 s so a slow rewrite ARRIVES rather than being
      // aborted into Hinglish; sequential x 23 s would put a nine-stint history at over three
      // minutes of provider wait on top of six DB loads and WeasyPrint. The stints that fit are
      // polished, the rest keep a null polish, and the NEXT render picks them up for free —
      // which is the same degrade this whole file is built on: a degrade costs polish, never a
      // description, and never the PDF.
      if (Date.now() - startedAt >= POLISH_WALL_CLOCK_BUDGET_MS) {
        abandoned += 1;
        continue;
      }
      const result = await this.polishOne(workerId, role.workDone as string, role.roleLabel, ctx);
      if (result !== null) polished.set(role.id as string, result);
    }

    // NEVER A SILENT PARTIAL. A sheet that prints one employer in English and the next in
    // Hinglish is the defect this service was reported for, and it was invisible because nothing
    // counted. COUNTS ONLY — a stint's description is the worker's own text and never reaches a
    // log line, an event or a metric.
    if (polished.size < pending.length) {
      this.logger.warn(
        `work-history polish covered ${polished.size}/${pending.length} stint(s) for worker ` +
          `${workerId}` +
          (abandoned > 0 ? `; ${abandoned} left for the next render (wall-clock budget)` : "") +
          `; the remainder print the worker's own words`,
      );
    }
    if (polished.size === 0) return records;

    // WRITE-BACK IS BEST-EFFORT. A failed persist costs one model call on the next render, not
    // this render's output — which is already computed and already correct.
    try {
      await this.employments.savePolishedDescriptions(polished);
    } catch (err) {
      this.logger.warn(
        `could not persist ${polished.size} polished description(s) for worker ${workerId}; ` +
          `this render is unaffected and the next one will retry ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }

    return records.map((employment) => ({
      ...employment,
      roles: employment.roles.map((role) =>
        role.id !== undefined && polished.has(role.id)
          ? { ...role, workDonePolished: polished.get(role.id) as string }
          : role,
      ),
    }));
  }

  /**
   * Rephrase ONE worker-typed text answer and store it beside that answer (#1350, extended to
   * the fresher block on the 2026-09-09 owner report).
   *
   * WHY IT IS HERE AND NOT A SECOND SERVICE. It is the same override of §8, the same route, the
   * same prompt, the same kill switch and the same fail-closed contract — a fresher's ITI
   * training description differs from an employment description only in which form collected it.
   * A parallel service would have been a second place to forget the switch.
   *
   * ONE CALL PER ANSWER, EVER, on the same mechanism as a stint: the result is written to
   * `worker_attributes.value_text_polished` and this returns early when one is already stored.
   * The upsert clears that column whenever the answer is re-written, so an EDITED answer is
   * re-polished for free and a re-render of an unchanged one spends nothing.
   *
   * NEVER THROWS, and returns the text to PRINT — the rewrite when there is one, otherwise null,
   * which the caller reads as "print what the worker wrote".
   */
  async polishAttribute(
    workerId: string,
    attributeKey: string,
    ownText: string | null | undefined,
    contextLabel: string,
    ctx: AiRequestContext,
    config: Pick<ServerConfig, "WORK_HISTORY_POLISH_ENABLED">,
    alreadyPolished: string | null | undefined,
  ): Promise<string | null> {
    if (!config.WORK_HISTORY_POLISH_ENABLED) return null;
    if ((alreadyPolished ?? "").trim() !== "") return (alreadyPolished as string).trim();
    const text = ownText?.trim();
    if (!text) return null;

    const result = await this.polishOne(workerId, text, contextLabel, ctx);
    if (result === null) return null;

    // WRITE-BACK IS BEST-EFFORT, exactly as for a stint: a failed persist costs one model call on
    // the next render, never this render's output — which is already computed and already right.
    try {
      await this.attributes.saveAttributePolish(workerId, attributeKey, result);
    } catch (err) {
      this.logger.warn(
        `could not persist the polished '${attributeKey}' for worker ${workerId}; this render ` +
          `is unaffected and the next one will retry ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
    return result;
  }

  /** One stint. Never throws — the caller is a render. */
  private async polishOne(
    workerId: string,
    workDone: string,
    roleLabel: string,
    ctx: AiRequestContext,
  ): Promise<string | null> {
    try {
      const out = await this.ai.polishWorkHistory(
        {
          schema_version: "oie.v1",
          // PSEUDONYMOUS BY CONSTRUCTION. The worker id is the reference the AI service bills
          // and traces against; the sheet's name, phone, employer, city and dates are rendered
          // deterministically here and never reach the model on this route.
          worker_ref: workerId,
          work_done: workDone.slice(0, 300),
          role_label: roleLabel.slice(0, 80),
        },
        ctx,
      );

      // LEDGER THE SPEND (#738's rule, applied to the route that arrived without it).
      //
      // `ai_metadata` was being dropped on the floor here, so a route that bills on EVERY stint
      // of EVERY worker's history produced no `ai.cost_recorded`, no totals accrual and nothing
      // in the admin cost dashboard — the exact failure `ai-cost-coverage.test.ts` exists to
      // catch, and it could not see this route until the task type became nameable.
      //
      // RECORDED WHATEVER THE ANSWER WAS, including a null rewrite: a declined or rejected
      // polish still burned tokens, and a ledger that only counts the successes understates the
      // cost of the ones that fail. `record` returns early on a null `meta`, which is the mock
      // and transport-failure case where there is genuinely nothing to bill.
      //
      // ATTRIBUTED TO THE WORKER, WITH NO SESSION, on the same reasoning `ResumeService` states
      // for `resume_generation`: a resume is rendered from a confirmed profile, possibly days
      // and several interviews after any of them, so naming one session would be a guess dressed
      // as a fact. `record` swallows its own failures — an observability write must never cost a
      // worker their resume.
      await this.aiCost.record(
        out?.ai_metadata ?? null,
        "work_history_polish",
        null,
        ctx.correlationId ?? "",
        ctx.requestId ?? "",
        { workerId },
      );

      const text = out?.work_done?.trim();
      return text ? text : null;
    } catch (err) {
      // `AiService.post` already collapses every transport failure to null, so reaching here at
      // all is unexpected — which is why it is logged rather than swallowed silently.
      this.logger.warn(
        `work-history polish threw for worker ${workerId}; printing the worker's own words ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
      return null;
    }
  }
}
