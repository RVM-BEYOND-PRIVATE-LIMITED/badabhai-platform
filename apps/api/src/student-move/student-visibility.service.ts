import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { WorkerSkillsService } from "../match/worker-skills.service";
import { studentMoveEnabled, type StudentMoveConfig } from "./student-move.flag";
import {
  StudentVisibilityRepository,
  type MovedStudentRow,
  type StudentSelector,
} from "./student-visibility.repository";

const UNDEFINED_TABLE = "42P01";

export interface MovedStudentPage {
  readonly students: readonly MovedStudentRow[];
  readonly nextCursor: string | null;
}

/**
 * #2887 — the moved students' visibility switch (ruling of 17 Nov 2026: shown to companies only
 * when an admin turns their visibility on).
 *
 *  - Off at import. While off, a moved student is out of matching (`job_reach`) and #2752's rules
 *    keep him from companies; on, he is an ordinary BadaBhai worker.
 *  - One student (`setOne`) or many (`setBulk`: one import run, branch or course). Only rows whose
 *    state changes are written, so a repeat is a no-op (`changed: 0`).
 *  - Each call writes the row changes, ONE `audit_logs` row (the admin's reason) and its event in
 *    ONE transaction. After commit, every changed student's reach is rebuilt (`rebuildQuietly`:
 *    on, he is reached by matching postings; off, his rows are removed). A failed rebuild is logged
 *    and repaired by the next rebuild or `db:materialize:reach`; it never fails the call.
 *
 * Everything answers 404 while STUDENT_MOVE_ENABLED is off (nothing reads the table before its
 * migration), and 503 with it on and the table missing.
 */
@Injectable()
export class StudentVisibilityService {
  private readonly logger = new Logger(StudentVisibilityService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly repo: StudentVisibilityRepository,
    private readonly events: EventsService,
    private readonly workerSkills: WorkerSkillsService,
    @Optional() @Inject(SERVER_CONFIG) config?: StudentMoveConfig,
  ) {
    this.enabled = studentMoveEnabled(config);
  }

  /** 404 unless STUDENT_MOVE_ENABLED is on: the routes do not exist while it is off. */
  assertLive(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  async list(filter: {
    batchId?: string;
    visible?: boolean;
    branch?: string;
    course?: string;
    cursor?: string;
    limit: number;
  }): Promise<MovedStudentPage> {
    this.assertLive();
    try {
      const rows = await this.repo.list({
        ...(filter.batchId !== undefined ? { batchId: filter.batchId } : {}),
        ...(filter.visible !== undefined ? { visible: filter.visible } : {}),
        ...(filter.branch !== undefined ? { branch: filter.branch } : {}),
        ...(filter.course !== undefined ? { course: filter.course } : {}),
        after: decodeEntityCursor(filter.cursor),
        limit: filter.limit + 1,
      });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        students: page,
        nextCursor:
          rows.length > filter.limit && last
            ? encodeEntityCursor({ createdAt: last.createdAt.toISOString(), id: last.workerId })
            : null,
      };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  /**
   * One student. 404 for a worker who was never moved (no visibility row).
   *
   * @returns the student's row after the call, and whether it changed.
   */
  async setOne(
    adminId: string,
    workerId: string,
    input: { readonly visible: boolean; readonly reason: string },
    ctx: RequestContext,
  ): Promise<{ student: MovedStudentRow; changed: boolean }> {
    this.assertLive();
    let changed: string[];
    try {
      changed = await this.repo.withTransaction(async (tx) => {
        if (!(await this.repo.findOne(workerId, tx))) throw new NotFoundException();
        const ids = await this.repo.set(
          tx,
          { kind: "worker", workerId },
          { visible: input.visible, adminId, reason: input.reason },
        );
        if (ids.length > 0) {
          await this.repo.audit(tx, {
            adminId,
            action: ADMIN_ACTION_CODES.student_visibility_changed,
            entityType: "worker",
            entityId: workerId,
            metadata: { visible: input.visible, reason_text: input.reason },
          });
          const payload: PayloadInputOf<"admin.student_visibility_changed"> = {
            worker_id: workerId,
            visible: input.visible,
          };
          await this.emit(tx, "admin.student_visibility_changed", adminId, workerId, payload, ctx);
        }
        return ids;
      });
    } catch (err) {
      throw this.missingTableAs503(err);
    }
    await this.rebuildReach(changed, ctx);
    const student = await this.repo.findOne(workerId);
    if (!student) throw new NotFoundException();
    return { student, changed: changed.length > 0 };
  }

  /** Many students: one import run, one branch or one course. Returns how many changed. */
  async setBulk(
    adminId: string,
    selector: StudentSelector,
    input: { readonly visible: boolean; readonly reason: string },
    ctx: RequestContext,
  ): Promise<{ changed: number }> {
    this.assertLive();
    const operationId = randomUUID();
    let changed: string[];
    try {
      changed = await this.repo.withTransaction(async (tx) => {
        const ids = await this.repo.set(tx, selector, {
          visible: input.visible,
          adminId,
          reason: input.reason,
        });
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.student_visibility_bulk_changed,
          entityType: "student_visibility_bulk",
          entityId: operationId,
          metadata: {
            operation_id: operationId,
            selector: selector.kind,
            ...(selector.kind === "batch" ? { batch_id: selector.batchId } : {}),
            ...(selector.kind === "branch" ? { branch: selector.branch } : {}),
            ...(selector.kind === "course" ? { course: selector.course } : {}),
            visible: input.visible,
            changed: ids.length,
            reason_text: input.reason,
          },
        });
        const payload: PayloadInputOf<"admin.student_visibility_bulk_changed"> = {
          selector: selector.kind,
          batch_id: selector.kind === "batch" ? selector.batchId : null,
          visible: input.visible,
          changed: ids.length,
        };
        await this.emit(tx, "admin.student_visibility_bulk_changed", adminId, null, payload, ctx, operationId);
        return ids;
      });
    } catch (err) {
      throw this.missingTableAs503(err);
    }
    await this.rebuildReach(changed, ctx);
    return { changed: changed.length };
  }

  /** After commit: rebuild each changed student's supply and reach. Never throws. */
  private async rebuildReach(workerIds: readonly string[], ctx: RequestContext): Promise<void> {
    for (const workerId of workerIds) {
      await this.workerSkills.rebuildQuietly(workerId, ctx);
    }
  }

  private async emit(
    tx: Database,
    eventName: "admin.student_visibility_changed" | "admin.student_visibility_bulk_changed",
    adminId: string,
    workerId: string | null,
    payload:
      | PayloadInputOf<"admin.student_visibility_changed">
      | PayloadInputOf<"admin.student_visibility_bulk_changed">,
    ctx: RequestContext,
    operationId?: string,
  ): Promise<void> {
    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject:
        workerId !== null
          ? { subject_type: "worker", subject_id: workerId }
          : { subject_type: "admin_session", subject_id: adminId },
      payload,
      idempotencyKey:
        workerId !== null
          ? `${eventName}:${workerId}:${randomUUID()}`
          : `${eventName}:${operationId ?? randomUUID()}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }

  private missingTableAs503(err: unknown): unknown {
    if (sqlStateOf(err) === UNDEFINED_TABLE) {
      this.logger.error(
        `student_visibility missing (sqlstate=${UNDEFINED_TABLE}); apply the student_move migration`,
      );
      return new ServiceUnavailableException();
    }
    return err;
  }
}
