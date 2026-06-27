import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { AdminActionsRepository } from "./admin-actions.repository";
import type {
  AdminActionResult,
  AdminChangeRoleDto,
  AdminFlagWorkerDto,
  AdminGrantCreditsDto,
  AdminInviteDto,
} from "./admin-actions.dto";

/**
 * The closed set of admin action CODES recorded on the spine (`admin.action_performed.action_code`).
 * One per route outcome; a CODE only — the action_code is the WHAT, never the value (the new
 * status, the amount, the reason). Pinned here so a typo can't drift the audited code.
 */
export const ADMIN_ACTION_CODES = {
  payer_suspended: "payer_suspended",
  payer_reinstated: "payer_reinstated",
  credits_granted: "credits_granted",
  posting_force_closed: "posting_force_closed",
  worker_flagged: "worker_flagged",
  worker_unflagged: "worker_unflagged",
  admin_invited: "admin_invited",
  admin_role_changed: "admin_role_changed",
  admin_suspended: "admin_suspended",
} as const;
export type AdminActionCode = (typeof ADMIN_ACTION_CODES)[keyof typeof ADMIN_ACTION_CODES];

/** The faceless event subject for each action's target entity (one of the registered subjects). */
type AdminActionSubjectType = "payer" | "job_posting" | "worker" | "admin_session";

/**
 * Governed admin entity actions (ADR-0025 ADMIN-3a, Decision 3/5/6). Each method mutates a
 * SYSTEM-OF-RECORD table (payers.status / credit_ledger / job_postings.status / worker_flags /
 * admin_users) and emits EXACTLY ONE registry-validated `admin.action_performed` carrying the
 * action CODE + the opaque target id ONLY.
 *
 * VALUE-FREE SPINE (Decision 5/6 + CLAUDE.md invariant #2): the new status, the credit amount,
 * the flag/grant reason CODE, the admin's email — NONE reach the event. They live ONLY on the
 * SoR row (status column / ledger row / worker_flags row / admin_users row). The `.strict()`
 * `AdminActionPerformedPayload` is the structural backstop (any extra key fails validation).
 *
 * ACTOR / TARGET: the actor is ALWAYS the session admin id the controller passes from
 * `@CurrentAdmin().id` (never a body); the target id is the validated PATH param. Neither is
 * spoofable from the request body.
 *
 * IDEMPOTENCY (terminal actions): suspend/reinstate payer, force-close posting, flag/unflag
 * worker, and suspend admin are guarded at the SoR so a re-invoke against an already-terminal
 * state is a NO-OP success — no SoR change AND no duplicate event ({@link AdminActionResult}
 * `changed:false`). The event is emitted ONLY when the SoR row actually changed.
 */
@Injectable()
export class AdminActionsService {
  constructor(
    private readonly actions: AdminActionsRepository,
    private readonly admins: AdminRepository,
    private readonly events: EventsService,
  ) {}

  // ----- payers: suspend / reinstate ----------------------------------------

  async suspendPayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: already suspended → no-op success, no event.
    if (current.status === "suspended") return { target_id: payerId, changed: false };
    const moved = await this.actions.suspendPayer(payerId);
    if (!moved) {
      // pending (never-active) cannot be suspended — a defined, value-free conflict.
      throw new ConflictException("Payer is not active and cannot be suspended");
    }
    await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_suspended, "payer", payerId, ctx);
    return { target_id: payerId, changed: true };
  }

  async reinstatePayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: already active → no-op success, no event.
    if (current.status === "active") return { target_id: payerId, changed: false };
    const moved = await this.actions.reinstatePayer(payerId);
    if (!moved) {
      throw new ConflictException("Payer is not suspended and cannot be reinstated");
    }
    await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_reinstated, "payer", payerId, ctx);
    return { target_id: payerId, changed: true };
  }

  // ----- credits: grant -----------------------------------------------------

  /**
   * Grant credits — a POSITIVE, additive credit movement (NOT terminal/idempotent): each grant
   * appends its own ledger row and emits its own event. The amount + reason live on the ledger
   * (the SoR); the event carries action_code + the opaque payer target id ONLY (NEVER the
   * amount or the reason). The ledger row id is returned to the caller for reference.
   */
  async grantCredits(
    adminId: string,
    payerId: string,
    dto: AdminGrantCreditsDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult & { ledger_id: string; balance: number }> {
    const exists = await this.actions.findPayerStatus(payerId);
    if (!exists) throw new NotFoundException("Payer not found");
    const { ledgerId, balance } = await this.actions.grantCredits(payerId, dto.amount);
    await this.emitAction(adminId, ADMIN_ACTION_CODES.credits_granted, "payer", payerId, ctx);
    return { target_id: payerId, changed: true, ledger_id: ledgerId, balance };
  }

  // ----- job_postings: force-close ------------------------------------------

  async forceClosePosting(
    adminId: string,
    postingId: string,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const current = await this.actions.findPostingStatus(postingId);
    if (!current) throw new NotFoundException("Job posting not found");
    // Idempotent: already closed → no-op success, no event.
    if (current.status === "closed") return { target_id: postingId, changed: false };
    const closed = await this.actions.forceClosePosting(postingId, new Date());
    // A concurrent close raced us → still a no-op success (terminal state reached).
    if (!closed) return { target_id: postingId, changed: false };
    await this.emitAction(
      adminId,
      ADMIN_ACTION_CODES.posting_force_closed,
      "job_posting",
      postingId,
      ctx,
    );
    return { target_id: postingId, changed: true };
  }

  // ----- worker_flags: flag / unflag ----------------------------------------

  async flagWorker(
    adminId: string,
    workerId: string,
    dto: AdminFlagWorkerDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const opened = await this.actions.openFlag(workerId, dto.reason_code, adminId);
    // Idempotent: a worker already has an OPEN flag → no new row, no event.
    if (!opened) return { target_id: workerId, changed: false };
    await this.emitAction(adminId, ADMIN_ACTION_CODES.worker_flagged, "worker", workerId, ctx);
    return { target_id: workerId, changed: true };
  }

  async unflagWorker(adminId: string, workerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const resolved = await this.actions.resolveFlag(workerId, adminId);
    // Idempotent: no open flag to resolve → no-op success, no event.
    if (!resolved) return { target_id: workerId, changed: false };
    await this.emitAction(adminId, ADMIN_ACTION_CODES.worker_unflagged, "worker", workerId, ctx);
    return { target_id: workerId, changed: true };
  }

  // ----- admin_users: invite / change role / suspend (manage_admins) --------

  /**
   * Invite a new admin (status defaults 'pending' — invite-then-activate). The email is
   * ADMIN-class PII: encrypted at rest in admin_users, NEVER echoed into the event/response.
   * Returns the new opaque admin id (the audit target). A duplicate email surfaces as a 23505
   * from the repository — mapped to a value-free conflict (no enumeration of which email).
   */
  async inviteAdmin(adminId: string, dto: AdminInviteDto, ctx: RequestContext): Promise<{ admin_id: string }> {
    let created: { id: string };
    try {
      created = await this.admins.create({ role: dto.role, email: dto.email });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException("An admin with that email already exists");
      throw err;
    }
    // The target of an admin-management action is the affected admin (the admin_session subject).
    await this.emitAction(
      adminId,
      ADMIN_ACTION_CODES.admin_invited,
      "admin_session",
      created.id,
      ctx,
    );
    return { admin_id: created.id };
  }

  async changeAdminRole(
    adminId: string,
    targetAdminId: string,
    dto: AdminChangeRoleDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const updated = await this.admins.updateRole(targetAdminId, dto.role);
    if (!updated) throw new NotFoundException("Admin not found");
    await this.emitAction(
      adminId,
      ADMIN_ACTION_CODES.admin_role_changed,
      "admin_session",
      targetAdminId,
      ctx,
    );
    return { target_id: targetAdminId, changed: true };
  }

  async suspendAdmin(
    adminId: string,
    targetAdminId: string,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const existing = await this.admins.findById(targetAdminId);
    if (!existing) throw new NotFoundException("Admin not found");
    // Idempotent: already suspended → no-op success, no event.
    if (existing.status === "suspended") return { target_id: targetAdminId, changed: false };
    const suspended = await this.admins.suspend(targetAdminId);
    if (!suspended) return { target_id: targetAdminId, changed: false };
    await this.emitAction(
      adminId,
      ADMIN_ACTION_CODES.admin_suspended,
      "admin_session",
      targetAdminId,
      ctx,
    );
    return { target_id: targetAdminId, changed: true };
  }

  // ----- single emit chokepoint (value-free spine) --------------------------

  /**
   * Emit EXACTLY ONE `admin.action_performed` — code + opaque ids ONLY. The payload shape is
   * the FULL `AdminActionPerformedPayload` ({admin_id, action_code, target_type, target_id});
   * `.strict()` rejects any extra key, so a value can never be smuggled onto the spine.
   *
   * `idempotencyKey` makes the spine write exactly-once under an at-least-once retry of the SAME
   * logical mutation (action + actor + target + request), without suppressing a legitimately
   * repeated grant (different request id → different key).
   */
  private emitAction(
    adminId: string,
    actionCode: AdminActionCode,
    subjectType: AdminActionSubjectType,
    targetId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: subjectType,
      target_id: targetId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: subjectType, subject_id: targetId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${targetId}:${ctx.requestId}`,
    });
  }
}

/** Postgres unique-violation (23505) — a duplicate admin email on invite. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
