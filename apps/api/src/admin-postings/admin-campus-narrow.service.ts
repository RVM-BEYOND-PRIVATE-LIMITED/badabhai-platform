import { Injectable, Logger } from "@nestjs/common";
import { GENERAL_CNC_SKILL_ID } from "@badabhai/taxonomy";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database } from "@badabhai/db";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin/admin-action-codes";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { toJobPostingApi } from "../job-postings/job-postings.repository";
import type { UpdateJobPostingDto } from "../job-postings/job-postings.dto";
import { PostingTradesService } from "../posting-trades/posting-trades.service";
import { AdminPostingsRepository } from "./admin-postings.repository";
import {
  AdminCampusNarrowRepository,
  type LockedNarrowPosting,
} from "./admin-campus-narrow.repository";
import { decodeCursor, encodeCursor } from "./admin-posting-worker-visibility.service";
import type {
  NarrowQueueItem,
  NarrowQueueQueryDto,
  NarrowTradeDto,
  NarrowTradeOutcome,
  NarrowTradeResult,
} from "./admin-campus-narrow.dto";

/**
 * #3033 — the Campus narrow queue: old Campus jobs on the general CNC skill, and the admin
 * write that narrows one to a machine trade.
 *
 * An OLD Campus job whose role was "Machine Operator" or "CNC Operator" carries exactly the
 * general CNC skill (`mskill_cnc_operator_general`). The queue lists the OPEN ones, oldest
 * first, with the Campus role text they came with. Narrowing sets the job's trade (role kind
 * + optional ladder rung) to one of the six allowed kinds through the SAME
 * `prepareAdminEdit` → `normalizeSelection` path a company edit runs, so the trade's base
 * skill replaces the general one, the reach set is rebuilt, and the audit row plus the
 * existing `posting_edited` admin-action event record who narrowed it and from what.
 *
 * No new storage: the Campus mark is the existing `job_posting_worker_visibility` origin
 * (`campus_posted` / `campus_imported`), and the Campus role text is the posting's own
 * `role_title`. A narrowed row no longer carries the general skill, so it leaves the queue.
 *
 * A narrowed job that is already visible to BadaBhai workers gets its reach rebuilt (the
 * same post-commit materialization a company edit runs); a held one keeps no reach rows,
 * because the reach core applies the hold fragment itself.
 */
@Injectable()
export class AdminCampusNarrowService {
  private readonly logger = new Logger(AdminCampusNarrowService.name);

  constructor(
    private readonly repo: AdminCampusNarrowRepository,
    private readonly postingsRepo: AdminPostingsRepository,
    private readonly jobPostings: JobPostingsService,
    private readonly postingTrades: PostingTradesService,
    private readonly events: EventsService,
  ) {}

  async list(
    query: NarrowQueueQueryDto,
  ): Promise<{ postings: NarrowQueueItem[]; next_cursor: string | null }> {
    const rows = await this.repo.list({
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
        campus_role_text: row.roleTitle,
        origin: row.origin,
        posted_at: row.postedAt.toISOString(),
      })),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.postedAt, id: last.jobPostingId })
          : null,
    };
  }

  async narrow(
    adminId: string,
    jobPostingId: string,
    dto: NarrowTradeDto,
    ctx: RequestContext,
  ): Promise<NarrowTradeResult> {
    const current = await this.repo.findForNarrow(jobPostingId);
    if (current === undefined) return outcome(jobPostingId, "not_found", null, null);
    if (current.status !== "open") {
      // The queue lists open postings only, and the match-skill change lands through the
      // post-commit reach rebuild, which runs for an open posting: narrowing a paused one
      // would store the trade while its match columns still name the general skill (the
      // same lag a PATCH edit on a paused posting has). Resume it first, then narrow.
      return outcome(
        jobPostingId,
        current.status === "closed" ? "posting_closed" : "not_narrowable",
        current.roleKind,
        current.matchSkillIds,
      );
    }
    if (current.origin === null) {
      return outcome(jobPostingId, "not_campus_origin", current.roleKind, current.matchSkillIds);
    }
    if (!isGeneralCncAlone(current)) {
      return outcome(jobPostingId, "not_narrowable", current.roleKind, current.matchSkillIds);
    }
    // The translation table never attaches a Campus job to a trade companies cannot post
    // (#3014): a switched-off kind waits for the owner to switch its wave on (#3013).
    if (!(await this.postingTrades.isReleased(dto.role_kind))) {
      return outcome(jobPostingId, "trade_not_released", current.roleKind, current.matchSkillIds);
    }

    // The SAME trade-form path a company edit runs: derive the match set from the trade
    // (an empty answer map still carries the base skill), never from a client id list.
    const changes: UpdateJobPostingDto = {
      role_kind: dto.role_kind as UpdateJobPostingDto["role_kind"],
      ...(dto.trade_level !== undefined ? { trade_level: dto.trade_level } : {}),
      trade_answers: {},
    };
    const prepared = await this.jobPostings.prepareAdminEdit(jobPostingId, changes, ctx);
    const fromRoleKind = current.roleKind;
    const fromMatchSkillIds = current.matchSkillIds;
    const updated = await this.postingsRepo.withTransaction(async (tx) => {
      const row = await this.postingsRepo.updatePosting(jobPostingId, prepared.patch, tx);
      await this.postingsRepo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_edited,
        entityType: "job_posting",
        entityId: row.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: {
          narrowed_from_role_kind: fromRoleKind,
          narrowed_from_match_skill_ids: fromMatchSkillIds,
          narrowed_to_role_kind: prepared.tradeDto.role_kind ?? null,
          narrowed_to_match_skill_ids: prepared.tradeDto.match_skill_ids ?? null,
          campus_origin: current.origin,
        },
      });
      const payload: PayloadInputOf<"job_posting.updated"> = {
        job_posting_id: row.id,
        changed_fields: prepared.changedFields,
        status: row.status,
        vacancy_band: prepared.bandChanged ? row.vacancyBand : null,
      };
      await this.emitDomain(
        tx,
        "job_posting.updated",
        "job_posting",
        row.id,
        payload,
        adminId,
        ctx,
      );
      await this.emitAction(
        tx,
        adminId,
        ADMIN_ACTION_CODES.posting_edited,
        "job_posting",
        row.id,
        ctx,
      );
      return row;
    });
    // Post-commit and non-fatal, exactly as a #2566 edit: `job_reach` is a rebuildable cache,
    // and for an OPEN posting the skills change rebuilds it — including one already visible
    // to BadaBhai workers. The match-skill columns are written by that rebuild (never by the
    // row patch above, by Policy 10's design), so the result is read back after it.
    const after = toJobPostingApi(updated);
    try {
      await this.jobPostings.materializeAfterAdminEdit(
        { before: prepared.before, tradeDto: prepared.tradeDto },
        after,
        adminId,
        ctx,
      );
    } catch (err) {
      this.logger.error(
        `campus narrow: reach rebuild failed for posting ${jobPostingId}; ` +
          `db:materialize:reach repairs it`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    const fresh = await this.jobPostings.getOne(jobPostingId);
    return outcome(jobPostingId, "changed", fresh.role_kind, fresh.match_skill_ids);
  }

  private emitDomain<N extends Parameters<EventsService["emit"]>[0]["event_name"]>(
    tx: Database,
    eventName: N,
    subjectType: "job_posting",
    subjectId: string,
    payload: PayloadInputOf<N>,
    adminId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: subjectType, subject_id: subjectId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `${eventName}:${subjectId}:${ctx.requestId}`,
      tx,
    });
  }

  private emitAction(
    tx: Database,
    adminId: string,
    actionCode: AdminActionCode,
    targetType: "job_posting",
    targetId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: targetType,
      target_id: targetId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: targetType, subject_id: targetId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${targetId}:${ctx.requestId}`,
      tx,
    });
  }
}

/** Exactly the general CNC skill and nothing else. */
function isGeneralCncAlone(posting: LockedNarrowPosting): boolean {
  return (
    posting.matchSkillIds.length === 1 && posting.matchSkillIds[0] === GENERAL_CNC_SKILL_ID
  );
}

function outcome(
  postingId: string,
  result: NarrowTradeOutcome,
  roleKind: string | null,
  matchSkillIds: string[] | null,
): NarrowTradeResult {
  return { posting_id: postingId, outcome: result, role_kind: roleKind, match_skill_ids: matchSkillIds };
}
