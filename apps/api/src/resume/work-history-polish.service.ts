import { Injectable, Logger } from "@nestjs/common";

import type { ServerConfig } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import type { AiRequestContext } from "../ai/ai.service";
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
@Injectable()
export class WorkHistoryPolishService {
  private readonly logger = new Logger(WorkHistoryPolishService.name);

  constructor(
    private readonly ai: AiService,
    private readonly employments: WorkerEmploymentRepository,
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
    for (const role of pending) {
      // SEQUENTIAL, NOT PARALLEL. A worker has at most four employers and a handful of stints,
      // and firing them together would put a burst on the provider's per-minute quota for a
      // job that is already off the request path and in no hurry.
      const result = await this.polishOne(workerId, role.workDone as string, role.roleLabel, ctx);
      if (result !== null) polished.set(role.id as string, result);
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
