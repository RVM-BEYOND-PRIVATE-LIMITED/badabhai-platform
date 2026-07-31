import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isMatchSkillId, type MatchSkillId } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { MatchSkillsService } from "./match-skills.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/** What went live, in ids + counts. Returned so the caller can echo the warning. */
export interface MaterializeResult {
  jobPostingId: string;
  matchSkillIds: string[];
  reachSkillIds: string[];
  appliedUntickedIds: string[];
  reachTotal: number;
  reachTier1: number;
  reachTier2: number;
  /** E13 — the posting reaches nobody. Publishing into a void. */
  zeroReach: boolean;
}

/** Which write produced a reach set — carried onto the audit event. */
export type MaterializeTrigger = "publish" | "unpause" | "ops_widen" | "edit";

/**
 * MOMENT ③ — "Company publishes." (spec Part 6, ADR-0036 §4.)
 *
 * `reach_skill_ids` is resolved on the form; one indexed `INSERT..SELECT` writes the
 * whole reach set with its tier. This service owns that moment for every path that
 * can trigger it: draft→open, unpause, an edit that changed the skills, and the
 * ops-widen action.
 *
 * THREE RULES IT ENFORCES SERVER-SIDE, NOT BY TRUST:
 *  - the reach set is RESOLVED, never accepted. There is no client input anywhere in
 *    the system that sets `reach_skill_ids` directly (Policy 10).
 *  - an untick counts ONLY if it names a suggested related skill, and a POSTED skill
 *    can never be unticked (`resolveReachSet`).
 *  - E13, re-checked at publish: the form warns before payment, and this is the
 *    server-side re-check, so a client that skipped the preview cannot make the alert
 *    disappear. "Never take money for a posting into a void."
 *
 * PII-free: opaque posting ids, closed-set skill ids, integer counts.
 */
@Injectable()
export class PublishReachService {
  private readonly logger = new Logger(PublishReachService.name);

  constructor(
    private readonly skills: MatchSkillsService,
    private readonly repo: WorkerSkillsRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Resolve + persist + materialize a posting's reach set, then emit the audit event
   * and (when supply is short) the E12/E13 ops alert.
   *
   * `stampPublishedAt` is FIRST-OPEN-ONLY. An unpause must not restamp it, or a
   * posting could pause/resume its way back to the top of a newest-first feed — which
   * is a boost bought for free, and Policy 13 says money orders the feed, not
   * lifecycle games.
   */
  async materialize(
    jobPostingId: string,
    input: {
      matchSkillIds: readonly string[];
      untickedIds: readonly string[];
      trigger: MaterializeTrigger;
      actor: { actor_type: "ops" | "payer"; actor_id: string };
    },
    ctx: RequestContext,
  ): Promise<MaterializeResult> {
    const resolved = await this.skills.resolveForPublish(input.matchSkillIds, input.untickedIds);

    const existing = await this.repo.findPostingSkillSets(jobPostingId);
    if (!existing) throw new NotFoundException("Job posting not found");

    await this.repo.setPostingSkillSets(
      jobPostingId,
      resolved.postedSkillIds,
      resolved.reachSkillIds,
      // FIRST OPEN ONLY.
      input.trigger === "publish" && existing.publishedAt === null ? new Date() : null,
    );

    await this.repo.materializeReachForPosting(
      jobPostingId,
      resolved.postedSkillIds,
      resolved.reachSkillIds,
    );

    const counts = await this.repo.countReachForPosting(jobPostingId);
    const result: MaterializeResult = {
      jobPostingId,
      matchSkillIds: resolved.postedSkillIds,
      reachSkillIds: resolved.reachSkillIds,
      appliedUntickedIds: resolved.appliedUntickedIds,
      reachTotal: counts.total,
      reachTier1: counts.tier1,
      reachTier2: counts.total - counts.tier1,
      zeroReach: counts.total === 0,
    };

    const materialized: PayloadInputOf<"job_posting.reach_materialized"> = {
      job_posting_id: jobPostingId,
      match_skill_count: resolved.postedSkillIds.length,
      reach_skill_count: resolved.reachSkillIds.length,
      unticked_count: resolved.appliedUntickedIds.length,
      reach_total: result.reachTotal,
      reach_tier1: result.reachTier1,
      reach_tier2: result.reachTier2,
      trigger: input.trigger,
    };
    await this.events.emit({
      event_name: "job_posting.reach_materialized",
      actor: input.actor,
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload: materialized,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    await this.emitAlertIfShort(result, ctx);
    return result;
  }

  /**
   * POLICY 27 — "Ops may widen a reach set, never narrow one. Expiring, audited,
   * evented."
   *
   * SCOPE, STATED PLAINLY: the WIDEN and the AUDIT/EVENT are implemented; the EXPIRY
   * is NOT. An expiring widen needs a column to hold the expiry and a sweep to undo
   * it, i.e. a migration and a scheduled job — a database change is outside this
   * change's boundary (it escalates to the database architect) and inventing a
   * `job_reach`-level TTL in application code would be a second, undocumented source
   * of truth about what a posting's reach set is. So a widen applied here is
   * PERMANENT until an ops human re-materializes the posting from its posted skills,
   * which the publish path already does. That is a real, deliberate gap and it is
   * named here rather than left for a reader to discover.
   *
   * WIDENING IS APPEND-ONLY BY CONSTRUCTION: the added ids are unioned into the
   * stored `reach_skill_ids`; nothing is ever removed on this path, and the DTO has
   * no field that could express a removal.
   */
  async opsWiden(
    jobPostingId: string,
    addSkillIds: readonly string[],
    actorId: string,
    ctx: RequestContext,
  ): Promise<MaterializeResult> {
    const existing = await this.repo.findPostingSkillSets(jobPostingId);
    if (!existing) throw new NotFoundException("Job posting not found");

    const unknown = addSkillIds.filter((id) => !isMatchSkillId(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`unknown match skill id(s): ${unknown.join(", ")}`);
    }

    const before = await this.repo.countReachForPosting(jobPostingId);
    const current = new Set<string>(existing.reachSkillIds);
    const added = [...new Set(addSkillIds)].filter((id) => !current.has(id)) as MatchSkillId[];
    if (added.length === 0) {
      throw new BadRequestException("every requested skill is already in the reach set");
    }

    const widened = [...current, ...added].sort();
    // The POSTED skills are untouched: widening changes who can be REACHED, never who
    // counts as tier 1. A widened-in skill therefore always produces tier-2 rows, which
    // is what makes the E18 badge still honest after an ops widen.
    await this.repo.setPostingSkillSets(jobPostingId, existing.matchSkillIds, widened, null);
    await this.repo.materializeReachForPosting(jobPostingId, existing.matchSkillIds, widened);

    const after = await this.repo.countReachForPosting(jobPostingId);
    const payload: PayloadInputOf<"job_posting.reach_widened"> = {
      job_posting_id: jobPostingId,
      added_skill_ids: added,
      reach_before: before.total,
      reach_after: after.total,
    };
    await this.events.emit({
      event_name: "job_posting.reach_widened",
      actor: { actor_type: "ops", actor_id: actorId },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    const result: MaterializeResult = {
      jobPostingId,
      matchSkillIds: existing.matchSkillIds,
      reachSkillIds: widened,
      appliedUntickedIds: [],
      reachTotal: after.total,
      reachTier1: after.tier1,
      reachTier2: after.total - after.tier1,
      zeroReach: after.total === 0,
    };
    await this.emitAlertIfShort(result, ctx);
    return result;
  }

  /**
   * E13 (`zero_reach`) and E12 (`no_tier1_reach`) — the two ops alerts that replace
   * PACE's auto-widening. PACE widened a reach set by itself, which V1 forbids: a
   * company's approved reach set is frozen, and only an audited ops action may widen
   * it (Policy 27). So the system's job here is to TELL someone, not to fix it.
   *
   * Keyed idempotently on (posting, reason) so a republish of a still-thin posting
   * does not spam the spine with the same alert.
   */
  private async emitAlertIfShort(result: MaterializeResult, ctx: RequestContext): Promise<void> {
    const reason: "zero_reach" | "no_tier1_reach" | null =
      result.reachTotal === 0
        ? "zero_reach"
        : result.reachTier1 === 0
          ? "no_tier1_reach"
          : null;
    if (reason === null) return;

    this.logger.warn(
      `reach alert posting=${result.jobPostingId} reason=${reason} ` +
        `total=${result.reachTotal} tier1=${result.reachTier1}`,
    );

    const payload: PayloadInputOf<"job_posting.reach_alert"> = {
      job_posting_id: result.jobPostingId,
      reason,
      reach_total: result.reachTotal,
      reach_tier1: result.reachTier1,
      reach_skill_count: result.reachSkillIds.length,
    };
    await this.events.emit({
      event_name: "job_posting.reach_alert",
      actor: { actor_type: "system" },
      subject: { subject_type: "job_posting", subject_id: result.jobPostingId },
      payload,
      idempotencyKey: `job_posting.reach_alert:${result.jobPostingId}:${reason}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
