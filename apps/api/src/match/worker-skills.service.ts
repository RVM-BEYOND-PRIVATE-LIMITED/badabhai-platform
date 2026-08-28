import { Injectable, Logger } from "@nestjs/common";
import {
  computeIndustryTenure,
  deriveWorkerSkills,
  wantedSkillIds,
  type WorkerSkillRow,
} from "@badabhai/match-engine";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { MatchConfigService } from "./match-config.service";
import { corpusSkillsForPackAttributes } from "./pack-attribute-skills";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/** What a rebuild actually changed — PII-free counts, safe to log and to event. */
export interface RebuildResult {
  workerId: string;
  skillCount: number;
  industryCount: number;
  /** How many open/paused postings the worker can now be reached through. */
  reachedPostings: number;
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
   * Returns `null` when the worker has no profile yet (nothing to derive) — that is a
   * legitimate state, not a failure.
   */
  async rebuildForWorker(workerId: string, ctx?: RequestContext): Promise<RebuildResult | null> {
    const cfg = await this.config.get();
    const signals = await this.repo.findLatestProfileSignals(workerId);
    if (!signals) return null;

    // ⓪ B0b — the role pack's answers join the profile's own attribute ids.
    //
    // The pack's fourteen answers live in `worker_attributes` and used to reach nothing, so the
    // most completely-profiled worker on the platform derived zero skills. `corpusSkillsForPack-
    // Attributes` is a closed-set lookup over option keys the worker TAPPED — no inference, so
    // invariant #4 is untouched and the engine below is still the only thing deciding reach.
    //
    // UNION, never replace: a worker can have both an extracted profile and a completed pack, and
    // whichever arrived second must not silently delete the other's evidence.
    const packSkills = corpusSkillsForPackAttributes(
      await this.repo.findPackAttributeOptions(workerId),
    );
    const profileSkills = [...new Set([...signals.profileSkills, ...packSkills])].sort();

    // ① The set: role bridge ∪ attribute bridge. EMPTY is a legitimate answer — a worker
    //    whose role and attributes imply no postable skill reaches nothing, and we never
    //    fabricate a skill to give a man a feed.
    const derived: WorkerSkillRow[] = deriveWorkerSkills(
      {
        canonicalRoleId: signals.canonicalRoleId,
        profileSkills,
        totalYears: signals.totalYears,
      },
      cfg,
    );

    // ② Tenure, per industry, from the SAME rows the engine just produced (so the E8
    //    clamp compares a skill against tenure in that skill's OWN industry — E7).
    const tenure = computeIndustryTenure(derived, signals.totalYears, cfg.monthBucket);

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
   * THE WANTS-TOGGLE SEAM — deliberately NOT wired to an endpoint in this change.
   *
   * Spec Part 2 makes `wants` half of the visibility rule, and E12 turns on it ("ten men
   * hold it, none has `wants = true`"). The worker-facing toggle (endpoint + Flutter UI)
   * is explicitly out of scope here, so this method exists as the seam that the endpoint
   * will call and NOTHING calls it yet.
   *
   * It is written now, rather than left to the endpoint, because the SAFE part is the
   * hard part: flipping `wants` must reconcile `job_reach` in the same breath, or the
   * worker keeps seeing (and can keep applying to) jobs for work he just said he does not
   * want. Doing it here means the future endpoint is a controller + a DTO.
   *
   * It writes `source='interview'` on the row it touches, because a worker answering
   * "do you want this work?" IS the interview speaking — and that is precisely the source
   * the coarse re-derivation is forbidden to overwrite.
   */
  async setWants(workerId: string, skillId: string, wants: boolean): Promise<void> {
    void workerId;
    void skillId;
    void wants;
    throw new Error(
      "WorkerSkillsService.setWants is an unwired seam: the wants-toggle endpoint is out " +
        "of scope for the Matching V1 API wiring change (ADR-0036). Wire it with its own " +
        "controller + DTO + guard-contract entry, and make it reconcile job_reach.",
    );
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
}

/** Re-exported so callers can name the engine's row type without a second import. */
export { wantedSkillIds };
