import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  computeIndustryTenure,
  deriveWorkerSkills,
  wantedSkillIds,
  workerSkillDeriveInput,
  type WorkerSkillRow,
} from "@badabhai/match-engine";
import { isMatchSkillId, matchSkillLabel, type MatchSkillId } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { MatchConfigService } from "./match-config.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/** What a rebuild actually changed — PII-free counts, safe to log and to event. */
export interface RebuildResult {
  workerId: string;
  skillCount: number;
  industryCount: number;
  /** How many open/paused postings the worker can now be reached through. */
  reachedPostings: number;
}

/** One row of the worker's own match-skills page, in the page's wire vocabulary. */
export interface WorkerMatchSkillView {
  skill_id: string;
  label: string;
  wants: boolean;
}

/** The result of one wants flip — the id and the state it now holds. */
export interface SetWantsResult {
  skill_id: string;
  wants: boolean;
}

/**
 * MOMENTS ① AND ② — the worker-profile write side of Matching V1 (spec Part 6).
 *
 *   ① "Worker profiled." Every match skill the profile implies becomes a `worker_skill`
 *      row. `wants` defaults true. Months bucketed to 6.
 *   ② "`worker_industry_tenure` rebuilt." Merge overlapping ranges per industry, sum the
 *      merged length, apply the E8 clamp. Runs on profile write.
 *
 * ...plus the tail neither moment names but both depend on: **reconciling this worker's
 * rows in `job_reach`**. `job_reach` is materialized when a POSTING is published, so a
 * worker profiled afterwards is invisible to every posting that already exists. Without
 * the reconciliation the feed does not fail loudly — it silently rots.
 *
 * WHY THIS LIVES IN `apps/api/src/match/` AND NOT IN `profiles/`:
 * it is not a profile concern. It reads a profile, but everything it writes
 * (`worker_skill`, `worker_industry_tenure`, `job_reach`) belongs to the matching layer,
 * it is the exact live-path twin of the `db:backfill:worker-skills` batch runner, and it
 * shares `MatchConfigService` + `WorkerSkillsRepository` with the publish/feed/apply
 * paths. Putting it in `profiles/` would make `ProfilesModule` depend on the match
 * config, the reach table and the posting table to serve a profile read.
 *
 * COARSE AT LAUNCH, HONESTLY (ADR-0036 "Coarse history at launch"): the derivation gives
 * every derived skill the SAME bucketed total, `last_worked_at` is null, and stint dates
 * are null — because the extraction does not carry per-skill durations. The alternative,
 * splitting a total across skills by a rule nobody told the worker about, would invent
 * history. When per-stint capture lands, only the INPUT to `deriveWorkerSkills` changes.
 *
 * PII: nothing here reads or writes a name/phone/employer. Ids, enums and integers only.
 * Invariant #4: `deriveWorkerSkills` / `computeIndustryTenure` are pure deterministic
 * functions from `@badabhai/match-engine`. No LLM ranks, scores or decides anything.
 */
@Injectable()
export class WorkerSkillsService {
  private readonly logger = new Logger(WorkerSkillsService.name);

  constructor(
    private readonly repo: WorkerSkillsRepository,
    private readonly config: MatchConfigService,
    private readonly events: EventsService,
  ) {}

  /**
   * Rebuild everything Matching V1 knows about one worker's supply, then reconcile his
   * reach. Idempotent: running it twice on an unchanged profile writes the same rows.
   *
   * Returns `null` only when the worker has no profile row, no pack evidence and no declared
   * occupation — i.e. nothing to derive from at all. That is a legitimate state, not a failure. A worker
   * with pack answers and no profile row (every trade-form completion) is NOT that case.
   */
  async rebuildForWorker(workerId: string, ctx?: RequestContext): Promise<RebuildResult | null> {
    const cfg = await this.config.get();
    const signals = await this.repo.findLatestProfileSignals(workerId);

    // ⓪ B0b — the role pack's answers join the profile's own attribute ids.
    //
    // A trade form (and a structured-answer chat on a role pack) leaves its evidence in
    // `worker_attributes`, keyed by pack. `PACK_ANSWER_SKILLS` (@badabhai/taxonomy) is a
    // closed-set lookup over option keys the worker TAPPED — no inference, so invariant #4 is
    // untouched and the engine below is still the only thing deciding reach. Most chips imply a
    // corpus `skill_*` id (attribute bridge); a chip naming an occupation with no corpus id
    // (`hmc`) implies a `role_*` id and rides the role bridge like a declared occupation does.
    const [packAnswers, secondaryRoleIds] = await Promise.all([
      this.repo.findPackAttributeOptions(workerId),
      // Layer A (f) — the worker's DECLARED extra occupations (migration 0114). Read here, on
      // every rebuild, so the live path and the batch path see the same rows; each id rides the
      // existing role bridge in `deriveWorkerSkills` below. Closed ids only, no free text.
      this.repo.findSecondaryRoleIds(workerId),
    ]);

    // ONE ASSEMBLY, SHARED WITH `db:backfill:worker-skills` — see `workerSkillDeriveInput`. It
    // unions the three sources and owns the guard below; the batch runner calls the same function,
    // so the nightly repair can no longer prune what this path writes.
    //
    // THE GUARD (M1): `null` = no profile row, no pack evidence, no declared occupation. The
    // rebuild is delete-then-insert, so running it on NOTHING would DELETE the rows a worker
    // mid-extraction already has. A form worker has no profile row by design (the handover
    // switches extraction off, trade-form.service.ts) — his pack answers ARE the evidence.
    const input = workerSkillDeriveInput({
      profile: signals ?? null,
      secondaryRoleIds,
      packAnswers,
    });
    if (input === null) return null;

    // ① The set: role bridge ∪ secondary-role bridge ∪ attribute bridge (profile skills ∪ pack
    //    answers). EMPTY is a legitimate answer — a worker whose roles and attributes imply no
    //    postable skill reaches nothing, and we never fabricate a skill to give a man a feed.
    //    A form-only worker has no role and no total-years; `deriveWorkerSkills` handles both
    //    (a null role contributes nothing, a null tenure buckets to zero).
    const derived: WorkerSkillRow[] = deriveWorkerSkills(input, cfg);

    // ② Tenure, per industry, from the SAME rows the engine just produced (so the E8
    //    clamp compares a skill against tenure in that skill's OWN industry — E7).
    const tenure = computeIndustryTenure(derived, signals?.totalYears ?? null, cfg.monthBucket);

    await this.repo.replaceDerivedSkillsAndTenure(
      workerId,
      derived.map((r) => ({
        skillId: r.skillId,
        industryId: r.industryId,
        monthsBucketed: r.monthsBucketed,
      })),
      [...tenure.entries()].map(([industryId, calendarMonths]) => ({
        industryId,
        calendarMonths,
      })),
      new Date(),
    );

    // THE TAIL. Read `wants` back from the DB rather than assuming it from `derived`:
    // an `interview`/`ops` row this writer must not touch still supplies reach, and a
    // worker who turned a skill OFF must leave the reach set even though the derivation
    // would have re-proposed it with `wants: true`.
    const wanted = await this.repo.listWantedSkillIds(workerId);
    await this.repo.reconcileReachForWorker(workerId, wanted);

    const reachedPostings = (await this.repo.listPostingIdsReaching(wanted)).length;
    const result: RebuildResult = {
      workerId,
      skillCount: derived.length,
      industryCount: tenure.size,
      reachedPostings,
    };

    await this.emitRebuilt(result, ctx);
    return result;
  }

  /**
   * THE WANTS TOGGLE — the worker's own yes/no over one kind of work (E4 item 1).
   *
   * Everything HARD about this already lives in the repository method it calls: the flip and
   * the `job_reach` reconcile commit in ONE transaction, the wanted set is read back from the
   * database rather than assumed from the flip, and the row is stamped `source='interview'`
   * so no future coarse re-derivation may re-propose the skill he just declined. This method
   * is the closed-set check, the 404, and the event.
   *
   * 400 AND 404 ARE DIFFERENT QUESTIONS. An id outside the closed `mskill_*` vocabulary can
   * never name a row in this system, so it is a 400 (`assertMatchSkill`); a real id the worker
   * does not hold is a 404 with no oracle — exactly the neutral shape
   * `WorkerAnswerSourceService.setTextSource` returns for a key that is nobody's.
   */
  async setWants(
    workerId: string,
    skillId: string,
    wants: boolean,
    ctx?: RequestContext,
  ): Promise<SetWantsResult> {
    const skill = this.assertMatchSkill(skillId);
    const updated = await this.repo.setWantsAndReconcile(workerId, skill, wants, new Date());
    if (!updated) {
      throw new NotFoundException(`match skill ${skill} is not one of this worker's skills`);
    }

    await this.emitWantsSet(workerId, skill, wants, ctx);
    this.logger.log(`match skill wants=${wants} for worker=${workerId} skill=${skill}`);
    return { skill_id: skill, wants };
  }

  /**
   * THE CLEAR-ALL EXIT — one call turns EVERY skill off and reconciles `job_reach` once.
   *
   * It is not garnish: a worker with eight derived rows would otherwise tap eight times, and a
   * partial failure would leave him half-visible with no way to tell. The exit has to be as
   * easy as the entry was (E4 item 3).
   *
   * UPDATE, NOT DELETE, and the difference is durability: deleting the rows would let the next
   * profile write recreate them `wants: true`, so the exit would silently undo itself.
   *
   * `cleared` IS THE NUMBER OF HIS MATCH SKILLS THIS CALL SWITCHED FROM ON TO OFF (#1850): rows
   * that were `wants = true` before it AND sit in the closed `mskill_*` vocabulary — exactly the
   * set `listMatchSkillsForWorker` renders as switches. Every row is still re-stamped (see the
   * repository), but an already-off row was not cleared by this call, and an out-of-vocabulary
   * row can never be matched on, so counting either over-reports what the exit did. A repeat
   * call therefore reports 0. It emits regardless, because the worker's request is itself the
   * fact being recorded.
   */
  async clearAllWants(workerId: string, ctx?: RequestContext): Promise<{ cleared: number }> {
    const switchedOff = await this.repo.clearAllWantsAndReconcile(workerId, new Date());
    const cleared = switchedOff.filter(isMatchSkillId).length;
    await this.emitWantsSet(workerId, null, false, ctx);
    this.logger.log(`match skills cleared for worker=${workerId} cleared=${cleared}`);
    return { cleared };
  }

  /**
   * The worker's own match skills, for the page the toggles and the clear-all live on.
   *
   * WITHOUT THIS THE TOGGLES HAVE NOTHING TO RENDER FROM. `worker_skill` is the only place a
   * worker's match skills exist and no worker-facing route served it, so a per-skill toggle
   * with no list is not an exit a screen can offer. Kept on the wire vocabulary the page
   * submits (`mskill_*`), filtered to the CLOSED SET: a retired or out-of-vocabulary row can
   * never be matched on, and listing it as a toggle would offer a switch the API must reject.
   *
   * PII-FREE: closed-set ids, their checked-in labels and a boolean. No name, no phone, and no
   * count of who can see him — this read has no reason to expose supply breadth to the worker.
   */
  async listMatchSkillsForWorker(workerId: string): Promise<WorkerMatchSkillView[]> {
    const rows = await this.repo.listSkillRows(workerId);
    return rows
      .flatMap((row): WorkerMatchSkillView[] =>
        isMatchSkillId(row.skillId)
          ? [
              {
                skill_id: row.skillId,
                label: matchSkillLabel(row.skillId) ?? row.skillId,
                wants: row.wants,
              },
            ]
          : [],
      )
      .sort((a, b) => (a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0));
  }

  /**
   * Rebuild without ever failing the caller. The extraction processor uses this: a
   * matching-projection rebuild must NEVER turn a successful profile extraction into a
   * failed one. `worker_skill` / `worker_industry_tenure` / `job_reach` are rebuildable
   * projections (the migration runbook §7 says so explicitly) — the nightly
   * `db:backfill:worker-skills` + `db:materialize:reach` runners repair anything missed,
   * and `db:verify:match-v1` fails the deploy gate if they did not.
   *
   * The failure is LOGGED (opaque worker id + error class only — never a transcript, a
   * name or a phone).
   */
  async rebuildQuietly(workerId: string, ctx?: RequestContext): Promise<void> {
    try {
      const result = await this.rebuildForWorker(workerId, ctx);
      if (result === null) return;
      this.logger.log(
        `match rebuild worker=${workerId} skills=${result.skillCount} ` +
          `industries=${result.industryCount} postings=${result.reachedPostings}`,
      );
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      const msg = err instanceof Error ? err.message : "unknown";
      this.logger.error(
        `match rebuild FAILED for worker=${workerId} (${cls}: ${msg}); extraction is unaffected — ` +
          `db:backfill:worker-skills + db:materialize:reach will repair it`,
      );
    }
  }

  /**
   * The spine record that a worker's matchable supply changed. Emitting even when the
   * rebuild found nothing is deliberate: "this worker derives ZERO skills" is exactly the
   * fact E17's `low_tag_worker` / `avg_skill_tags_per_worker` tracking needs, and it is
   * invisible if we only emit on success-with-rows.
   *
   * PII-FREE: an opaque worker id and three counts. No skill ids (the vocabulary is
   * public, but a per-worker skill list on the spine is a supply profile we have no
   * reader for), no name, no phone.
   */
  private async emitRebuilt(result: RebuildResult, ctx?: RequestContext): Promise<void> {
    const payload: PayloadInputOf<"worker.match_skills_rebuilt"> = {
      worker_id: result.workerId,
      skill_count: result.skillCount,
      industry_count: result.industryCount,
      reached_postings: result.reachedPostings,
    };
    await this.events.emit({
      event_name: "worker.match_skills_rebuilt",
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: result.workerId },
      payload,
      correlationId: ctx?.correlationId,
      requestId: ctx?.requestId,
    });
  }

  /**
   * The spine record of a VISIBILITY change (E4 item 4): the worker set `wants` on one skill,
   * or cleared every skill in one call (`skillId === null`). `wants` is half of ADR-0036's
   * visibility rule, so a change to it is a business action and this is its audit record.
   *
   * PII-FREE: an opaque worker id, a closed-set skill id (or null for the clear-all) and the
   * resulting boolean. No name, no phone — and deliberately NO count of who could see him.
   * The spine needs to know what he chose, not how wide the audience was.
   */
  private async emitWantsSet(
    workerId: string,
    skillId: string | null,
    wants: boolean,
    ctx?: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"worker.match_skill_wants_set"> = {
      worker_id: workerId,
      skill_id: skillId,
      wants,
    };
    await this.events.emit({
      event_name: "worker.match_skill_wants_set",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx?.correlationId,
      requestId: ctx?.requestId,
    });
  }

  /** Closed-set check for a client-supplied skill id — never free text (ADR-0030 SG-3). */
  private assertMatchSkill(skillId: string): MatchSkillId {
    if (!isMatchSkillId(skillId)) {
      throw new BadRequestException(`unknown match skill id: ${skillId}`);
    }
    return skillId;
  }
}

/** Re-exported so callers can name the engine's row type without a second import. */
export { wantedSkillIds };
