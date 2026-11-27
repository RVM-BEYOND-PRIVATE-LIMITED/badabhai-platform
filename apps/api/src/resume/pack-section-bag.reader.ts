import { Injectable } from "@nestjs/common";

import { TradeFormRepository } from "../profiling/form/trade-form.repository";

import { scopeSectionAttributesToPack, type StoredSectionAnswer } from "./pack-section-attributes";
import type { WorkerAttributeValues } from "./trade-resume-map";

/**
 * A trade section's attribute bag, scoped to the pack the section renders (#3086, option B).
 *
 * THE I/O HALF of `scopeSectionAttributesToPack`, on the same terms as `ResumeTierScopeReader`:
 * one reader, shared by the worker's own render and the employer disclosure so the two copies
 * can never print different sections. The pure helper decides the values; this only loads
 * them — the pack's own `worker_pack_answer` rows plus the active pack's
 * `question_key` → `target_field` map — and hands both over.
 *
 * MAY THROW; callers degrade a failure to the shared bag (today's sheet) on the same
 * one-load-one-section rule as every other read the render paths make. A section that cannot
 * prove its own answers prints the latest known values, never a failed render.
 */
@Injectable()
export class PackSectionBagReader {
  constructor(private readonly answers: TradeFormRepository) {}

  /**
   * The section bag for one worker's pack: the shared bag overlaid with the pack's own
   * answers. Throws when either read fails — the caller renders the shared bag instead.
   */
  async forWorker(
    workerId: string,
    packId: string,
    shared: WorkerAttributeValues,
  ): Promise<WorkerAttributeValues> {
    const rows = await this.answers.listAnswers(workerId, packId);
    return this.forAnswers(packId, shared, rows);
  }

  /**
   * The same scoping over already-loaded rows — the generate-time overlay's path, which
   * holds the pack's answers for its freshness gate and must not read them twice.
   * Throws when the item-target read fails.
   */
  async forAnswers(
    packId: string,
    shared: WorkerAttributeValues,
    answers: readonly StoredSectionAnswer[],
  ): Promise<WorkerAttributeValues> {
    if (answers.length === 0) return shared;
    const targets = await this.answers.listActiveItemTargets(packId);
    return scopeSectionAttributesToPack(shared, answers, (key) => targets.get(key) ?? null);
  }
}
