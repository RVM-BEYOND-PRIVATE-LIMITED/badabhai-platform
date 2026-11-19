import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  audienceReachesBadaBhaiWorkers,
  audienceReachesRvmStudents,
  isCampusWorkerVisibilityOrigin,
  rvmReviewStateFor,
  type JobPostingAudience,
  type JobWorkerVisibilityState,
} from "@badabhai/db";
import { postingTradeFor } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import {
  AUDIENCE_REFUSAL_REASONS,
  PostingAudienceService,
} from "../job-postings/posting-audience.service";
import { AdminPostingsRepository } from "./admin-postings.repository";
import {
  AdminPostingAudienceRepository,
  shownTo,
  type LockedAudiencePosting,
} from "./admin-posting-audience.repository";
import type {
  AudienceBulkDto,
  AudienceListQueryDto,
  AudienceOutcome,
  AudienceResult,
  AudienceSetDto,
  ShownTo,
} from "./admin-posting-audience.dto";
import { decodeCursor, encodeCursor } from "./admin-posting-worker-visibility.service";

/** One live posting on the admin "where jobs show" list (wire shape). */
export interface AudienceListItem {
  posting_id: string;
  company_id: string | null;
  company_label: string;
  title: string;
  city: string | null;
  role_kind: string | null;
  /** Names one of the 16 trades, so a choice that includes BadaBhai workers is allowed (#2635). */
  trade_ready: boolean;
  /** Its trade is on the Campus trade list (#2957), so a choice that includes Campus is allowed. */
  taught_at_campus: boolean;
  /** The openings band the company chose: what usually decides Campus only versus both. */
  vacancy_band: string;
  status: string;
  hidden: boolean;
  audience: JobPostingAudience;
  shown_to: ShownTo;
  rvm_branch_ids: number[];
  rvm_course_ids: string[];
  rvm_review_state: "pending" | "approved" | "rejected" | null;
  /** Non-null when the posting came from Campus (#2891); such a posting may go to Campus whatever its trade. */
  campus_origin: "campus_posted" | "campus_imported" | null;
  decided_by_admin_id: string | null;
  decided_at: string | null;
  /** An admin decided, and the company has changed what a student sees since. */
  changed_since_decision: boolean;
  created_at: string;
}

/** The Campus hold a decision implies: open to workers exactly when the choice includes them. */
function holdFor(audience: JobPostingAudience): JobWorkerVisibilityState {
  return audienceReachesBadaBhaiWorkers(audience) ? "on" : "off";
}

/** Whether BadaBhai workers see the posting, from its audience and its hold (the fragment's TS form). */
function workersSee(audience: JobPostingAudience, hold: JobWorkerVisibilityState | null): boolean {
  return audienceReachesBadaBhaiWorkers(audience) && (hold === null || hold === "on");
}

/**
 * #2956 — AN ADMIN DECIDES WHERE A POSTING SHOWS: Campus only, both, or BadaBhai only (owner
 * direction of 19 Nov 2026, #2959). The company does not choose.
 *
 * Each decision, in ONE transaction: lock the posting (then its Campus hold and decision rows),
 * check the rules, write the audience and targeting, approve the RVM part for the content as it is
 * now (the admin's choice is the approval; the placement team can still reject it from Campus),
 * set the Campus hold of a Campus-origin posting to match, record the decision, write the
 * `audit_logs` reason, and emit `job_posting.audience_set` (admin actor) and
 * `admin.action_performed`. The reach rebuild or clear runs AFTER the commit: `job_reach` is a
 * rebuildable cache and every worker read applies the fragment anyway.
 *
 * THE RULES, in order (each refusal stores nothing):
 *   - an agency job's synced copy stays BadaBhai only (`twin_not_allowed`);
 *   - a closed posting is not changed (`posting_closed`);
 *   - a choice that includes BadaBhai workers, on a live posting, needs one of the 16 trades
 *     (#2635, `trade_required`) — it is a publish to them;
 *   - a choice that includes Campus needs a trade RVM trains (#2957, `trade_not_taught_at_campus`;
 *     `trade_required` when the posting has no trade), except on a posting that came from Campus;
 *   - each branch or course id must be an active RVM option (`PostingAudienceService`).
 *
 * A bulk call is the single decision per posting, each in its own transaction with its own audit
 * row, so one posting's refusal never undoes another's change.
 */
@Injectable()
export class AdminPostingAudienceService {
  private readonly logger = new Logger(AdminPostingAudienceService.name);

  constructor(
    private readonly repo: AdminPostingAudienceRepository,
    private readonly postingsRepo: AdminPostingsRepository,
    private readonly audience: PostingAudienceService,
    private readonly jobPostings: JobPostingsService,
    private readonly events: EventsService,
  ) {}

  async list(
    query: AudienceListQueryDto,
  ): Promise<{ postings: AudienceListItem[]; next_cursor: string | null }> {
    const rows = await this.repo.list({
      filter: query.filter,
      limit: query.limit + 1,
      after: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      postings: page.map((row) => ({
        posting_id: row.jobPostingId,
        company_id: row.payerId,
        company_label: row.orgLabel,
        title: row.roleTitle,
        city: row.city,
        role_kind: row.roleKind,
        trade_ready: postingTradeFor(row.roleKind) !== undefined,
        taught_at_campus: row.taughtAtCampus,
        vacancy_band: row.vacancyBand,
        status: row.status,
        hidden: row.hidden,
        audience: row.audience,
        shown_to: row.shownTo,
        rvm_branch_ids: row.rvmBranchIds,
        rvm_course_ids: row.rvmCourseIds,
        rvm_review_state: rvmReviewStateFor(row.audience, row.rvmReviewStateNow),
        campus_origin: isCampusWorkerVisibilityOrigin(row.campusOrigin) ? row.campusOrigin : null,
        decided_by_admin_id: row.decidedByAdminId,
        decided_at: row.decidedAt?.toISOString() ?? null,
        changed_since_decision: row.changedSinceDecision,
        created_at: row.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.jobPostingId })
          : null,
    };
  }

  async set(
    adminId: string,
    jobPostingId: string,
    dto: AudienceSetDto,
    ctx: RequestContext,
  ): Promise<AudienceResult> {
    const committed = await this.repo.withTransaction(async (tx) => {
      const p = await this.repo.lock(tx, jobPostingId);
      if (p === undefined) return { result: outcome(jobPostingId, "not_found", null) };
      const holdNow = p.hold?.state ?? null;
      const shownNow = shownTo(audienceReachesRvmStudents(p.audience), workersSee(p.audience, holdNow));

      const refusal = await this.refusal(tx, p, dto.audience);
      if (refusal !== null) return { result: outcome(jobPostingId, refusal, shownNow) };

      // Targeting: the shared validation (active options, or ones the posting already holds).
      let write: Awaited<ReturnType<PostingAudienceService["resolveWrite"]>>;
      try {
        write = await this.audience.resolveWrite(
          {
            audience: dto.audience,
            rvm_branch_ids: dto.rvm_branch_ids,
            rvm_course_ids: dto.rvm_course_ids,
          },
          { audience: p.audience, rvm_branch_ids: p.rvmBranchIds, rvm_course_ids: p.rvmCourseIds },
          tx,
        );
      } catch (err) {
        if (refusedFor(err, AUDIENCE_REFUSAL_REASONS.targetingOptionNotOffered)) {
          return { result: outcome(jobPostingId, "targeting_option_not_offered", shownNow) };
        }
        throw err;
      }

      const toCampus = audienceReachesRvmStudents(dto.audience);
      const holdAfter = p.hold === null ? null : holdFor(dto.audience);
      const holdChanges = p.hold !== null && (p.hold.state !== holdAfter || !p.hold.decided);
      // The admin's choice is the RVM approval; an approval that still holds is kept (with any
      // narrowing the placement team stored) unless this decision changes the content.
      const approves = toCampus && (write !== null || p.reviewStateNow !== "approved");
      const decisionStale =
        p.decision === null ||
        p.decision.audience !== dto.audience ||
        p.decision.contentHash !== p.contentHashNow;
      if (write === null && !holdChanges && !approves && !decisionStale) {
        return { result: outcome(jobPostingId, "unchanged", shownNow) };
      }

      if (write !== null) await this.repo.writeAudience(tx, jobPostingId, write);
      if (approves) {
        await this.repo.approveAsAdmin(tx, jobPostingId, adminId);
      } else if (write !== null) {
        // The posting left Campus (or only its targeting moved): Campus's feed must read it again.
        await this.repo.touchReview(tx, jobPostingId);
      }
      if (holdChanges && holdAfter !== null) {
        await this.repo.decideHold(tx, jobPostingId, holdAfter, adminId);
      }
      await this.repo.recordDecision(tx, jobPostingId, dto.audience, adminId);

      const action = ADMIN_ACTION_CODES.posting_audience_set;
      await this.postingsRepo.writeAudit(tx, {
        adminId,
        action,
        entityType: "job_posting",
        entityId: jobPostingId,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: {
          audience_before: p.audience,
          audience_after: dto.audience,
          rvm_branch_ids_after: write?.rvmBranchIds ?? p.rvmBranchIds,
          rvm_course_ids_after: write?.rvmCourseIds ?? p.rvmCourseIds,
          campus_hold_before: p.hold?.state ?? null,
          campus_hold_after: holdAfter,
          rvm_approved_by_admin: approves,
          first_decision: p.decision === null,
        },
      });
      if (write !== null) {
        const payload: PayloadInputOf<"job_posting.audience_set"> = {
          job_posting_id: jobPostingId,
          audience: write.audience,
          previous_audience: p.audience,
          branch_ids: [...write.rvmBranchIds],
          course_ids: [...write.rvmCourseIds],
          review_state: rvmReviewStateFor(write.audience, approves ? "approved" : p.reviewStateNow),
        };
        await this.events.emit({
          event_name: "job_posting.audience_set",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "job_posting", subject_id: jobPostingId },
          payload,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
      }
      const performed: PayloadInputOf<"admin.action_performed"> = {
        admin_id: adminId,
        action_code: action,
        target_type: "job_posting",
        target_id: jobPostingId,
      };
      await this.events.emit({
        event_name: "admin.action_performed",
        actor: { actor_type: "admin", actor_id: adminId },
        subject: { subject_type: "job_posting", subject_id: jobPostingId },
        payload: performed,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `admin_action:${action}:${adminId}:${jobPostingId}:${ctx.requestId}`,
        tx,
      });

      const before = workersSee(p.audience, holdNow);
      const after = workersSee(dto.audience, holdAfter ?? holdNow);
      return {
        result: outcome(jobPostingId, "changed", shownTo(toCampus, after)),
        reach: before === after ? null : after ? ("rebuild" as const) : ("clear" as const),
      };
    });

    if (committed.reach !== undefined && committed.reach !== null) {
      await this.syncReach(jobPostingId, committed.reach, adminId, ctx);
    }
    return committed.result;
  }

  async setMany(
    adminId: string,
    dto: AudienceBulkDto,
    ctx: RequestContext,
  ): Promise<{ results: AudienceResult[] }> {
    const { posting_ids, ...decision } = dto;
    const results: AudienceResult[] = [];
    for (const id of posting_ids) results.push(await this.set(adminId, id, decision, ctx));
    return { results };
  }

  /** The first rule the decision breaks, or null. Reads the Campus trade list on the lock's transaction. */
  private async refusal(
    tx: Parameters<AdminPostingAudienceRepository["isCampusTrade"]>[0],
    p: LockedAudiencePosting,
    audience: JobPostingAudience,
  ): Promise<AudienceOutcome | null> {
    if (p.syncSource !== null) return "twin_not_allowed";
    if (p.status === "closed") return "posting_closed";
    // #2635 — reaching BadaBhai workers is a publish to them: the same 16-trade gate. A draft is
    // gated again by the company's own publish.
    if (
      audienceReachesBadaBhaiWorkers(audience) &&
      p.status !== "draft" &&
      postingTradeFor(p.roleKind) === undefined
    ) {
      return "trade_required";
    }
    // #2957 — only a trade RVM trains goes to Campus. A posting that came from Campus is exempt:
    // RVM's placement team made it for its own students. A company job held for a decision
    // (`company_rvm_trade`) is NOT Campus-origin and keeps the rule.
    if (audienceReachesRvmStudents(audience) && !isCampusWorkerVisibilityOrigin(p.hold?.origin)) {
      if (p.roleKind === null) return "trade_required";
      if (!(await this.repo.isCampusTrade(tx, p.roleKind))) return "trade_not_taught_at_campus";
    }
    return null;
  }

  /**
   * After the commit. `rebuild`: as a publish (`materializeAfterWorkerVisibility`, open postings
   * only; a paused one is rebuilt by its resume). `clear`: every reach row. Either failing is
   * logged, never thrown: the decision has committed, `db:materialize:reach` repairs the cache,
   * and the worker reads apply the fragment so a leftover row shows nothing.
   */
  private async syncReach(
    jobPostingId: string,
    reach: "rebuild" | "clear",
    adminId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      if (reach === "rebuild") {
        await this.jobPostings.materializeAfterWorkerVisibility(jobPostingId, adminId, ctx);
      } else {
        await this.repo.clearReach(jobPostingId);
      }
    } catch (err) {
      this.logger.error(
        `admin audience: reach ${reach} failed for posting ${jobPostingId}; ` +
          `db:materialize:reach repairs it`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

function outcome(postingId: string, result: AudienceOutcome, shown: ShownTo | null): AudienceResult {
  return { posting_id: postingId, outcome: result, shown_to: shown };
}

/** A `PostingAudienceService` 400 carrying this machine-readable `reason`. */
function refusedFor(err: unknown, reason: string): boolean {
  if (!(err instanceof BadRequestException)) return false;
  const body = err.getResponse();
  return typeof body === "object" && body !== null && (body as { reason?: unknown }).reason === reason;
}
