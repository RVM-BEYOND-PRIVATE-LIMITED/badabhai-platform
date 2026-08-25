import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isMatchSkillId, type MatchSkillId } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { MatchConfigService } from "./match-config.service";
import { MatchSkillsService } from "./match-skills.service";
import { ReachWidenRepository } from "./reach-widen.repository";
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

/** What one expiry-sweep tick retracted — counts only, safe to return/log. */
export interface WidenRetractSummary {
  /** Widen grants (rows) processed and stamped `retracted_at`. */
  grantsRetracted: number;
  /** Postings whose `reach_skill_ids` actually shrank + were re-materialized. */
  postingsShrunk: number;
  /** Postings skipped because they are not live (`open`/`paused`) — stamp-only. */
  postingsSkippedNotLive: number;
}

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
    private readonly widenRepo: ReachWidenRepository,
    private readonly matchConfig: MatchConfigService,
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
    * ALL THREE LEGS LIVE HERE NOW. The widen writes its PROVENANCE into
    * `job_reach_widen` (migration 0090) with an expiry taken from
    * `match_config.widen_expiry_hours`; the `reach-widen-expiry` sweep later retracts
    * expired grants via {@link retractExpiredWidens}. The widen itself stays
    * append-only: the added ids are unioned into the stored `reach_skill_ids`, nothing
    * is ever removed on this path, and the DTO has no field that could express a
    * removal.
    *
    * The provenance insert happens AFTER the reach write succeeds: a widen without a
    * provenance row simply never expires (the pre-0090 posture), which fails safe
    * toward MORE reach rather than silently narrowing one.
    *
    * WIDENED-IN SKILLS ARE NEVER ADDED TO THE POSTED SET: widening changes who can be
    * REACHED, never who counts as tier 1, so a widened-in skill always produces tier-2
    * rows and the E18 badge stays honest.
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

    // POLICY 27 "expiring" — record WHEN this grant ends. The sweep is the only reader;
    // see {@link retractExpiredWidens} for why a provenance row (not a TTL on reach
    // rows) is the shape that can actually retract.
    const config = await this.matchConfig.get();
    await this.widenRepo.insertGrant({
      jobPostingId,
      addedSkillIds: added as string[],
      expiresAt: new Date(Date.now() + config.widenExpiryHours * 3_600_000),
      opsActorId: actorId,
    });

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

  /** Due (expired, un-retracted) widen grants — the sweep's DRY-RUN report. Counts only. */
  async countDueWidenGrants(): Promise<number> {
    return this.widenRepo.countDue();
  }

  /**
   * POLICY 27 "expiring" — the sweep tick (TD127 closure). Retracts every widen grant
   * whose expiry has passed, re-materializing each affected posting from its shrunken
   * reach set.
   *
   * THE RETRACT SET IS PURE SUBTRACTION, deliberately. For a posting with due grants:
   *
   *   removed = ⋃(due grants' ids) − match_skill_ids − ⋃(still-active grants' ids)
   *   new_reach = current_reach_skill_ids − removed
   *
   * The reach set is NEVER re-derived from the taxonomy here. A re-derivation would
   * resurrect unticked related skills (the unticks were baked into the stored set at
   * publish time and are not persisted anywhere else) and would race any concurrent
   * publish edit; subtracting from the STORED set can only remove what a due grant
   * demonstrably added and nothing else protects. `materializeReachForPosting`'s purge
   * then drops the `job_reach` rows that only those skills qualified — including the
   * apply-gate rows, so an expired widen fails CLOSED for its workers.
   *
   * PROTECTION RULES (what can never be removed):
   *   - a POSTED skill (`match_skill_ids`) — ops never widened tier 1;
   *   - an id held by ANY still-active grant on the same posting — a newer re-widen
   *     outlives an older row's expiry;
   *   - an id another due grant on the same posting also added is removed ONCE, by the
   *     batch, not per row.
   *
   * NON-LIVE POSTINGS (draft/closed/suspended) get their provenance stamped only:
   * their sets are rebuilt or irrelevant at the next transition, and materializing
   * reach for them would fight the lifecycle writes.
   *
   * EVENTED: one `job_posting.reach_widen_expired` per shrunk posting, actor "system",
   * keyed `<posting>:<due-row ids>` so a crash between retraction and stamping replays
   * to the SAME event (the rows stay un-retracted until after the event lands) instead
   * of spamming duplicates. After shrinking, the E12/E13 alert re-check runs — a widen
   * that was masking an unsupplied trade must page someone when it stops masking it.
   */
  async retractExpiredWidens(batchLimit = 100): Promise<WidenRetractSummary> {
    const due = await this.widenRepo.findDueBatch(batchLimit);
    if (due.length === 0) return { grantsRetracted: 0, postingsShrunk: 0, postingsSkippedNotLive: 0 };

    const summary: WidenRetractSummary = {
      grantsRetracted: 0,
      postingsShrunk: 0,
      postingsSkippedNotLive: 0,
    };
    const processedRowIds: string[] = [];

    // Group the batch by posting — one read/decision/materialize per posting.
    const byPosting = new Map<string, typeof due>();
    for (const row of due) {
      processedRowIds.push(row.id);
      const group = byPosting.get(row.jobPostingId);
      if (group) group.push(row);
      else byPosting.set(row.jobPostingId, [row]);
    }

    const statuses = await this.widenRepo.statusForPostings([...byPosting.keys()]);
    // Every un-retracted grant on these postings EXCEPT this batch's own rows: an id a
    // still-active (future-expiry) widen granted must survive this retraction, while the
    // batch's own ids must not protect themselves.
    const activeIds = await this.widenRepo.activeIdsForPostings(
      [...byPosting.keys()],
      processedRowIds,
    );

    for (const [jobPostingId, rows] of byPosting) {
      const existing = await this.repo.findPostingSkillSets(jobPostingId);

      // Posting gone (FK cascade should have taken the rows, but be idempotent anyway).
      if (!existing) {
        await this.widenRepo.markRetracted(rows.map((r) => r.id));
        summary.grantsRetracted += rows.length;
        continue;
      }

      const status = statuses.get(jobPostingId)?.status ?? null;
      const live = status === "open" || status === "paused";

      const dueIds = new Set<string>();
      for (const r of rows) for (const id of r.addedSkillIds) dueIds.add(id);

      const posted = new Set<string>(existing.matchSkillIds);
      const protectedIds = new Set<string>([...posted, ...activeIds]);

      const current = new Set<string>(existing.reachSkillIds);
      // Provenance ids are validated as `mskill_*` at the widen entrypoint; the
      // intersection with the STORED reach set is what actually gets removed.
      const removed: string[] = [...dueIds].filter(
        (id) => !protectedIds.has(id) && current.has(id),
      );

      let shrunk = false;
      if (live && removed.length > 0) {
        const before = await this.repo.countReachForPosting(jobPostingId);
        const removedSet = new Set(removed);
        const shrunken = existing.reachSkillIds.filter((id) => !removedSet.has(id)).sort();
        await this.repo.setPostingSkillSets(jobPostingId, existing.matchSkillIds, shrunken, null);
        await this.repo.materializeReachForPosting(jobPostingId, existing.matchSkillIds, shrunken);
        const after = await this.repo.countReachForPosting(jobPostingId);

        const payload: PayloadInputOf<"job_posting.reach_widen_expired"> = {
          job_posting_id: jobPostingId,
          expired_skill_ids: [...removed].sort(),
          reach_before: before.total,
          reach_after: after.total,
        };
        await this.events.emitOnce({
          event_name: "job_posting.reach_widen_expired",
          actor: { actor_type: "system", actor_id: null },
          subject: { subject_type: "job_posting", subject_id: jobPostingId },
          payload,
          // Stable across retries: the due ROWS are the identity of this retraction,
          // and they stay un-retracted until after this emit resolves.
          idempotencyKey: `job_posting.reach_widen_expired:${jobPostingId}:${rows
            .map((r) => r.id)
            .sort()
            .join(",")}`,
          correlationId: randomUUID(),
          requestId: `reach-widen-expiry-sweep`,
        });
        shrunk = true;

        const result: MaterializeResult = {
          jobPostingId,
          matchSkillIds: existing.matchSkillIds,
          reachSkillIds: shrunken,
          appliedUntickedIds: [],
          reachTotal: after.total,
          reachTier1: after.tier1,
          reachTier2: after.total - after.tier1,
          zeroReach: after.total === 0,
        };
        await this.emitAlertIfShort(result, {
          correlationId: randomUUID(),
          requestId: "reach-widen-expiry-sweep",
        } as RequestContext);
      }

      await this.widenRepo.markRetracted(rows.map((r) => r.id));
      summary.grantsRetracted += rows.length;
      if (shrunk) summary.postingsShrunk += 1;
      else if (!live) summary.postingsSkippedNotLive += 1;
    }

    return summary;
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
