import { Injectable, Logger, NotFoundException } from "@nestjs/common";

import type { Database } from "@badabhai/db";
import { labelForTaxonomyId } from "@badabhai/taxonomy";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkerSkillsService } from "../match/worker-skills.service";
import { WorkersRepository } from "../workers/workers.repository";
import {
  OccupationEntrySchema,
  type MyOccupationView,
  type MyOccupationsResponse,
  type SetMyOccupationsDto,
} from "./worker-occupations.dto";
import { WorkerOccupationsRepository } from "./worker-occupations.repository";

/**
 * Records the worker's declared SECONDARY occupations (migration 0114, ADR-0042 D9 / Layer A (f)).
 *
 * ═══ TWO CONSUMERS, ONE WRITE ═══
 *
 * 1. DISPLAY — the GET returns the ids with their taxonomy labels.
 * 2. SUPPLY — `WorkerSkillsService.rebuildQuietly` re-derives the worker's `worker_skill` rows.
 *    The service reads the ids from the table on every rebuild, so a change here reaches reach
 *    through the existing `ROLE_TO_MATCH_SKILL` bridge; no new vocabulary, no new rank key.
 *
 * The rebuild is QUIET on purpose (the extraction processor's rule): a matching-layer hiccup must
 * never turn a successful profile edit into a failed one, and the nightly
 * `db:backfill:worker-skills` repairs a miss.
 *
 * ═══ NOTHING HERE TOUCHES A MODEL ═══
 *
 * Closed ids and an integer. No prompt is built, no pseudonymisation boundary is in the path.
 */
@Injectable()
export class WorkerOccupationsService {
  private readonly logger = new Logger(WorkerOccupationsService.name);

  constructor(
    private readonly occupations: WorkerOccupationsRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly workerSkills: WorkerSkillsService,
  ) {}

  async replaceForWorker(
    workerId: string,
    dto: SetMyOccupationsDto,
    ctx: RequestContext,
    // ADR-0046 — join the caller's transaction when the companion's edit card applies several
    // sections at once. The matching rebuild below is then the caller's (after commit), because
    // a rebuild inside a transaction that rolls back would leave reach describing rows that
    // never existed.
    opts: { tx?: Database } = {},
  ): Promise<{ worker_id: string; occupation_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const roleIds = dto.occupations.map((entry) => entry.role_id);
    const { occupationsWritten, replacedExisting } =
      opts.tx === undefined
        ? await this.occupations.replaceForWorker(workerId, roleIds)
        : await this.occupations.replaceForWorker(workerId, roleIds, opts.tx);

    await this.events.emit({
      event_name: "worker.occupations_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // COUNTS, NEVER THE ROLE IDS. The vocabulary is public, but a per-worker list of trades he
      // says he can also do is a supply profile the spine has no reader for — the same rule
      // `worker.match_skills_rebuilt` applies to skill ids.
      payload: {
        worker_id: workerId,
        occupation_count: occupationsWritten,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      ...(opts.tx === undefined ? {} : { tx: opts.tx }),
    });

    // Counts only — never a role id.
    this.logger.log(
      `secondary occupations recorded for worker ${workerId}: ${occupationsWritten} row(s)` +
        (replacedExisting ? ", replaced existing rows" : ""),
    );

    // Skipped on a joined transaction: the caller rebuilds the matching projection once the
    // transaction has COMMITTED, so reach never describes an uncommitted edit.
    if (opts.tx === undefined) await this.workerSkills.rebuildQuietly(workerId, ctx);

    return { worker_id: workerId, occupation_count: occupationsWritten };
  }

  /**
   * The caller's stored rows, labelled for display (#1545 consumes this).
   *
   * Each stored id is passed through the PUT's own entry schema; a row that no longer parses (an
   * id retired from the taxonomy) is withheld and counted rather than returned, so an unedited
   * save round-trips instead of 400-ing. See {@link MyOccupationsResponse}.
   *
   * NO EVENT (a read changes nothing) and a counts-only log line.
   */
  async getForWorker(workerId: string): Promise<MyOccupationsResponse> {
    const stored = await this.occupations.loadForWorker(workerId);

    const occupations: MyOccupationView[] = [];
    let droppedCount = 0;
    for (const roleId of stored) {
      const parsed = OccupationEntrySchema.safeParse({ role_id: roleId });
      if (parsed.success) {
        occupations.push({
          role_id: parsed.data.role_id,
          label: labelForTaxonomyId(parsed.data.role_id),
        });
      } else {
        droppedCount += 1;
      }
    }

    this.logger.log(
      `secondary occupations read for worker ${workerId}: ${occupations.length} row(s), ` +
        `${droppedCount} withheld`,
    );
    return { occupations, partial: droppedCount > 0, dropped_count: droppedCount };
  }
}
