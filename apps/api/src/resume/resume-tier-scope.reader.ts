import { Inject, Injectable } from "@nestjs/common";

import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";
import { TradeFormRepository } from "../profiling/form/trade-form.repository";
import {
  effectiveTier,
  packIsTagged,
  sharedFieldIncluded,
} from "../profiling/tiers/profiling-tier.policy";
import { ProfilingTierRepository } from "../profiling/tiers/profiling-tier.repository";
import type { ResumeTierScope } from "./resume-tier-scope";

/**
 * Loads a sheet's tier scope — the I/O half of `applyTierScope`, shared by the worker's own render
 * and the employer disclosure so the two copies can never print different tiers.
 *
 * NULL WHILE `PROFILING_TIERS_ENABLED` IS OFF, and nothing is queried: the sheet is then exactly
 * today's, and migration 0126 need not be applied. NULL TOO for a sheet whose pack carries no
 * tags (a trade with no form, or a pack not yet re-seeded). Otherwise a worker with no tier row
 * renders at Hard — every row he has, plus the "BadaBhai Standard profile" footer label.
 *
 * MAY THROW; callers degrade a failure to a null scope (today's sheet, no tier label) on the same
 * one-load-one-section rule as every other read the render worker makes.
 */
@Injectable()
export class ResumeTierScopeReader {
  constructor(
    private readonly tiers: ProfilingTierRepository,
    private readonly answers: TradeFormRepository,
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "PROFILING_TIERS_ENABLED">,
  ) {}

  async forWorker(workerId: string, packId: string | null): Promise<ResumeTierScope | null> {
    if (this.config.PROFILING_TIERS_ENABLED !== true) return null;

    // NO TIER WITHOUT A TAGGED PACK. A sheet whose pack carries no tags — a trade with no form, or
    // a form pack not yet re-seeded — was never profiled by tier, so it renders exactly as today:
    // no rows dropped and no tier label.
    const itemTiers = packId ? await this.tiers.findActiveItemTiers(packId) : new Map();
    if (!packIsTagged(itemTiers)) return null;
    const row = await this.tiers.findForWorker(workerId);
    const tier = effectiveTier(row?.tier);

    // D1 — only a tier that keeps just the latest job needs the stated total; everywhere else the
    // work-history sum is the total and this read would be wasted.
    let statedExperienceYears: number | null = null;
    if (!sharedFieldIncluded("previous_jobs", tier)) {
      const answer = await this.answers.findLatestAnswerByQuestionKey(workerId, "experience_years");
      if (
        answer?.status === "answered" &&
        typeof answer.answerNumber === "number" &&
        Number.isFinite(answer.answerNumber) &&
        answer.answerNumber >= 0
      ) {
        statedExperienceYears = answer.answerNumber;
      }
    }
    return { tier, itemTiers, statedExperienceYears };
  }
}
