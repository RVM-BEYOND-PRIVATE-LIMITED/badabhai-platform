import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { audienceReachesBadaBhaiWorkers, rvmReviewStateFor } from "@badabhai/db";
import { postingTradeFor } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { isCanonicalUuid } from "../common/uuid";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { AdminPostingsRepository } from "./admin-postings.repository";
import { AdminPostingWorkerVisibilityRepository } from "./admin-posting-worker-visibility.repository";
import type {
  WorkerVisibilityBulkDto,
  WorkerVisibilityListQueryDto,
  WorkerVisibilityResult,
  WorkerVisibilitySetDto,
} from "./admin-posting-worker-visibility.dto";

/** One Campus-origin posting on the admin list (wire shape). */
export interface WorkerVisibilityListItem {
  posting_id: string;
  company_id: string | null;
  company_label: string;
  title: string;
  city: string | null;
  role_kind: string | null;
  /** Names a posting trade, so `on` is allowed (#2635). */
  trade_ready: boolean;
  status: string;
  hidden: boolean;
  audience: string;
  /** The RVM review (#2746): governs RVM students, separate from this control. */
  rvm_review_state: "pending" | "approved" | "rejected" | null;
  origin: "campus_posted" | "campus_imported";
  worker_visibility: "on" | "off";
  decided_by_admin_id: string | null;
  decided_at: string | null;
  arrived_at: string;
}

/**
 * #2891 — an admin turns a Campus-origin posting's BadaBhai worker visibility on or off.
 *
 * Ruling of 17 Nov 2026: every Campus job comes to BadaBhai, held from BadaBhai workers until an
 * admin turns its visibility on; per posting, with a bulk action. While held, the posting behaves as
 * RVM-students-only on every worker path (`reachesBadaBhaiWorkers()`); turning it on builds reach,
 * turning it off clears it. The RVM review is a different control and is never touched here.
 *
 * Each change, in ONE transaction: lock the posting then its visibility row, record the decision,
 * write the `audit_logs` reason, and emit `admin.action_performed` (the code only). The reach
 * rebuild or clear runs AFTER the commit, because `job_reach` is a rebuildable cache and every
 * worker read applies the fragment anyway, so a late rebuild never shows a held posting.
 *
 * A bulk call is the single change per posting, each in its own transaction with its own audit
 * row, so one posting's refusal never undoes another's change.
 */
@Injectable()
export class AdminPostingWorkerVisibilityService {
  private readonly logger = new Logger(AdminPostingWorkerVisibilityService.name);

  constructor(
    private readonly repo: AdminPostingWorkerVisibilityRepository,
    private readonly postingsRepo: AdminPostingsRepository,
    private readonly jobPostings: JobPostingsService,
    private readonly events: EventsService,
  ) {}

  async list(
    query: WorkerVisibilityListQueryDto,
  ): Promise<{ postings: WorkerVisibilityListItem[]; next_cursor: string | null }> {
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
        status: row.status,
        hidden: row.hidden,
        audience: row.audience,
        rvm_review_state: rvmReviewStateFor(row.audience, row.rvmReviewStateNow),
        origin: row.origin,
        worker_visibility: row.state,
        decided_by_admin_id: row.decidedByAdminId,
        decided_at: row.decidedAt?.toISOString() ?? null,
        arrived_at: row.createdAt.toISOString(),
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
    dto: WorkerVisibilitySetDto,
    ctx: RequestContext,
  ): Promise<WorkerVisibilityResult> {
    const result = await this.repo.withTransaction(async (tx) => {
      const current = await this.repo.lock(tx, jobPostingId);
      if (current === undefined) return outcome(jobPostingId, "not_campus_origin", null);
      // A held posting no admin has decided on is WAITING: an `off` decision takes it off the
      // waiting list, so it is a change. Re-deciding what was already decided is not.
      if (current.state === dto.state && current.decided) {
        return outcome(jobPostingId, "unchanged", current.state);
      }
      if (dto.state === "on" && !audienceReachesBadaBhaiWorkers(current.audience)) {
        return outcome(jobPostingId, "audience_excludes_workers", current.state);
      }
      // #2635 — turning it on PUTS IT ON WORKER SURFACES, which is a publish to them: the same
      // posting-trade gate a company publish passes (owner ruling 2026-11-04).
      if (dto.state === "on" && postingTradeFor(current.roleKind) === undefined) {
        return outcome(jobPostingId, "trade_required", current.state);
      }
      const action =
        dto.state === "on"
          ? ADMIN_ACTION_CODES.posting_worker_visibility_on
          : ADMIN_ACTION_CODES.posting_worker_visibility_off;
      await this.repo.decide(tx, jobPostingId, dto.state, adminId);
      await this.postingsRepo.writeAudit(tx, {
        adminId,
        action,
        entityType: "job_posting",
        entityId: jobPostingId,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: {
          worker_visibility_before: current.state,
          worker_visibility_after: dto.state,
          first_decision: !current.decided,
          origin: current.origin,
        },
      });
      const payload: PayloadInputOf<"admin.action_performed"> = {
        admin_id: adminId,
        action_code: action,
        target_type: "job_posting",
        target_id: jobPostingId,
      };
      await this.events.emit({
        event_name: "admin.action_performed",
        actor: { actor_type: "admin", actor_id: adminId },
        subject: { subject_type: "job_posting", subject_id: jobPostingId },
        payload,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `admin_action:${action}:${adminId}:${jobPostingId}:${ctx.requestId}`,
        tx,
      });
      return outcome(jobPostingId, "changed", dto.state);
    });

    // Only a change that moved the state touches reach: a first `off` on a waiting posting never
    // had any (the hold has been in force since the posting existed).
    if (result.outcome === "changed") await this.syncReach(jobPostingId, dto.state, adminId, ctx);
    return result;
  }

  async setMany(
    adminId: string,
    dto: WorkerVisibilityBulkDto,
    ctx: RequestContext,
  ): Promise<{ results: WorkerVisibilityResult[] }> {
    const results: WorkerVisibilityResult[] = [];
    for (const id of dto.posting_ids) {
      results.push(
        await this.set(
          adminId,
          id,
          { state: dto.state, reason_code: dto.reason_code, reason_text: dto.reason_text },
          ctx,
        ),
      );
    }
    return { results };
  }

  /**
   * After the commit. `on`: rebuild as a publish (`materializeAfterWorkerVisibility`, already
   * non-fatal). `off`: clear every reach row. Either failing is logged, never thrown: the decision
   * has committed, `db:materialize:reach` repairs the cache, and the worker reads apply the fragment
   * so a leftover row shows nothing.
   */
  private async syncReach(
    jobPostingId: string,
    state: "on" | "off",
    adminId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      if (state === "on") {
        await this.jobPostings.materializeAfterWorkerVisibility(jobPostingId, adminId, ctx);
      } else {
        await this.repo.clearReach(jobPostingId);
      }
    } catch (err) {
      this.logger.error(
        `worker visibility ${state}: reach ${state === "on" ? "rebuild" : "clear"} failed for ` +
          `posting ${jobPostingId}; db:materialize:reach repairs it`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

function outcome(
  postingId: string,
  result: WorkerVisibilityResult["outcome"],
  state: "on" | "off" | null,
): WorkerVisibilityResult {
  return { posting_id: postingId, outcome: result, state };
}

/** An opaque list cursor: the last row's `(created_at, posting id)`. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    const createdAt = new Date(String(at));
    if (typeof id !== "string" || !isCanonicalUuid(id) || Number.isNaN(createdAt.getTime())) {
      throw new Error("shape");
    }
    return { createdAt, id };
  } catch {
    throw new BadRequestException({ code: "VALIDATION_FAILED", message: "cursor is not valid" });
  }
}
