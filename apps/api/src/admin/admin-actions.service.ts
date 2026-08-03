import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database, PayerStatus } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayerSessionService } from "../payers/payer-session.service";
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
  admin_mfa_reset: "admin_mfa_reset",
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
 * ATOMICITY (must-fix H3): for each governed action the SoR write AND the `admin.action_performed`
 * emit commit inside ONE Drizzle transaction (the events table and the SoR tables are the same
 * Postgres DB) — so an emit-failure rolls back the SoR write (a retry re-does both) and there is
 * NO path where the SoR row changes but the spine misses the event.
 *
 * IDEMPOTENCY (terminal actions): suspend/reinstate payer, force-close posting, flag/unflag
 * worker, change-role, and suspend admin are guarded at the SoR so a re-invoke against an
 * already-terminal/same state is a NO-OP success — no SoR change AND no duplicate event
 * ({@link AdminActionResult} `changed:false`). The event is emitted ONLY when the SoR row actually
 * changed. Credit grants use a caller-supplied UUID key for exactly-once on BOTH ledger + spine.
 */
@Injectable()
export class AdminActionsService {
  private readonly logger = new Logger(AdminActionsService.name);

  constructor(
    private readonly actions: AdminActionsRepository,
    private readonly admins: AdminRepository,
    private readonly events: EventsService,
    // ADR-0037 — suspension must revoke every live payer session immediately.
    private readonly sessions: PayerSessionService,
  ) {}

  // ----- payers: suspend / reinstate ----------------------------------------

  /**
   * ADR-0037 — suspend a payer from EITHER `pending` or `active`.
   *
   * Before ADR-0037 this required `active`, and since NOTHING ever set `active`, it threw
   * 409 for every real payer: the action was simultaneously unreachable and unenforced.
   *
   * Emits TWO events, deliberately: `admin.action_performed` (value-free — "an admin did
   * this") and `payer.suspended` (the transition itself, with both ends). They answer
   * different questions and the audit mandate needs both.
   *
   * SESSION REVOCATION runs AFTER the transaction commits, not inside it. Redis is not
   * transactional with Postgres, so revoking inside would delete sessions that a rollback
   * then un-suspends — locking a still-active payer out with no record of why. Committing
   * first means the worst case is the reverse: the row says suspended while a session
   * briefly survives, and the per-request lifecycle gate in `PayerAuthGuard` closes that
   * window on the very next request. A revoke failure is surfaced, never swallowed.
   */
  async suspendPayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: already suspended → no-op success, no event, no revoke.
    if (current.status === "suspended") return { target_id: payerId, changed: false };
    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.suspendPayer(payerId, tx);
      if (!moved) {
        // Unreachable for pending/active (both now transition); retained as the guard for
        // a concurrent writer that moved the row between the read above and this update.
        conflict = true;
        return;
      }
      await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_suspended, "payer", payerId, ctx, tx);
      await this.emitLifecycle(
        "payer.suspended",
        adminId,
        payerId,
        moved.previousStatus ?? current.status,
        "suspended",
        ctx,
        tx,
      );
      // Decision 1 — freeze the inventory in the SAME transaction as the status change.
      // A suspended payer whose jobs stayed live would still be recruiting, so the two
      // must be all-or-nothing: a failure here rolls the suspension back rather than
      // leaving a payer marked suspended while their postings keep taking applications.
      const inventory = await this.actions.suspendPayerInventory(payerId, tx);
      await this.emitInventory("payer.inventory_suspended", adminId, payerId, inventory, ctx, tx);
    });
    if (conflict) throw new ConflictException("Payer status changed concurrently; retry");
    await this.revokeSessions(payerId);
    return { target_id: payerId, changed: true };
  }

  /**
   * ADR-0037 — reinstate a payer to the status they held BEFORE the suspension.
   *
   * Not necessarily `active`: a payer suspended while `pending` returns to `pending` and
   * must still complete OTP verification. Hardcoding `active` here would let suspend +
   * reinstate be used as a backdoor activation.
   */
  async reinstatePayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: not suspended → no-op success, no event.
    if (current.status !== "suspended") return { target_id: payerId, changed: false };
    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.reinstatePayer(payerId, tx);
      if (!moved) {
        conflict = true;
        return;
      }
      await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_reinstated, "payer", payerId, ctx, tx);
      await this.emitLifecycle(
        "payer.reinstated",
        adminId,
        payerId,
        "suspended",
        moved.status,
        ctx,
        tx,
      );
      // Decision 1 — thaw the inventory in the SAME transaction, restoring each posting to
      // the status it actually held (open stays open, paused stays paused). Runs even when
      // the payer is reinstated to `pending`: a pending payer cannot log in to republish,
      // so leaving their inventory frozen would strand it with no way to recover it.
      const inventory = await this.actions.reinstatePayerInventory(payerId, tx);
      await this.emitInventory("payer.inventory_reinstated", adminId, payerId, inventory, ctx, tx);
    });
    if (conflict) throw new ConflictException("Payer status changed concurrently; retry");
    return { target_id: payerId, changed: true };
  }

  /**
   * Kill every live session for a suspended payer. Logged, never silently swallowed: if
   * this fails the payer's existing tokens are still live until their next request hits
   * the lifecycle gate, and an operator needs to know that from the logs rather than
   * inferring it. PII-free — the opaque payer id only.
   */
  private async revokeSessions(payerId: string): Promise<void> {
    try {
      const revoked = await this.sessions.revokeAllForPayer(payerId);
      this.logger.log(`payer suspended; sessions revoked payer=${payerId} count=${revoked}`);
    } catch (err) {
      this.logger.error(
        `payer suspended but session revocation FAILED payer=${payerId}; existing tokens stay ` +
          `live until their next request is rejected by the lifecycle gate (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  /** Emit one PII-free `payer.*` lifecycle transition on the caller's transaction. */
  private async emitLifecycle(
    eventName: "payer.suspended" | "payer.reinstated",
    adminId: string,
    payerId: string,
    previousStatus: PayerStatus,
    newStatus: PayerStatus,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: { payer_id: payerId, previous_status: previousStatus, new_status: newStatus },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      // Keyed on the request so a retried admin call cannot double-record the transition.
      idempotencyKey: `${eventName}:${payerId}:${ctx.requestId}`,
      tx,
    });
  }

  /**
   * Emit one PII-free `payer.inventory_*` cascade record on the caller's transaction.
   *
   * Emitted UNCONDITIONALLY, including when both counts are zero. A zero-count event is
   * not noise — it is the positive evidence that the cascade ran and found nothing, which
   * is exactly what distinguishes "this payer had no live jobs" from "the cascade did not
   * execute". Suppressing it would make the two indistinguishable on the spine.
   */
  private async emitInventory(
    eventName: "payer.inventory_suspended" | "payer.inventory_reinstated",
    adminId: string,
    payerId: string,
    counts: { postings: number; jobs: number },
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: {
        payer_id: payerId,
        postings_affected: counts.postings,
        jobs_affected: counts.jobs,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `${eventName}:${payerId}:${ctx.requestId}`,
      tx,
    });
  }

  // ----- credits: grant -----------------------------------------------------

  /**
   * Grant credits — a POSITIVE, additive credit movement keyed for EXACTLY-ONCE (H2). The grant
   * SoR write (ledger + balance) AND the `credits_granted` event are keyed on the SAME caller-
   * supplied UUID (`dto.idempotency_key`) and commit in ONE transaction (H3). A retry with the
   * SAME key inserts NO second ledger row, moves the balance ZERO times, and emits NO second
   * event — exactly-once on BOTH ledger and spine (no double-spend, no money-vs-spine divergence).
   * A genuinely new grant (new key) = one ledger row + one balance move + one event. The amount +
   * reason live on the ledger (the SoR); the event carries action_code + the opaque payer id ONLY.
   */
  async grantCredits(
    adminId: string,
    payerId: string,
    dto: AdminGrantCreditsDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult & { ledger_id: string; balance: number }> {
    const payer = await this.actions.findPayerStatus(payerId);
    if (!payer) throw new NotFoundException("Payer not found");
    // ADR-0037 — this query already SELECTED the status; it used to bind the row to
    // `exists` and consume only `!exists`, so the status it fetched was computed and
    // thrown away and an admin could top up a SUSPENDED payer's balance. Granting credits
    // to an account that is barred from spending them is at best pointless and at worst a
    // way to pre-load a suspended account for the moment it is reinstated.
    // `pending` is allowed: crediting a not-yet-verified account is a legitimate
    // pre-provisioning move and it cannot be spent until they verify.
    if (payer.status === "suspended") {
      throw new ConflictException("Payer is suspended; credits cannot be granted");
    }
    const result = await this.actions.withTransaction(async (tx) => {
      const grant = await this.actions.grantCredits(payerId, dto.amount, dto.idempotency_key, tx);
      // Emit ONLY when the grant actually applied (a new ledger row). A deduped replay
      // (`applied:false`) emits nothing — and the event is keyed on the SAME value, so even if it
      // were re-attempted the spine would dedup to ONE row. No divergence in any case.
      if (grant.applied) {
        await this.emitAction(
          adminId,
          ADMIN_ACTION_CODES.credits_granted,
          "payer",
          payerId,
          ctx,
          tx,
          dto.idempotency_key,
        );
      }
      return grant;
    });
    return {
      target_id: payerId,
      changed: result.applied,
      ledger_id: result.ledgerId,
      balance: result.balance,
    };
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
    let changed = false;
    await this.actions.withTransaction(async (tx) => {
      const closed = await this.actions.forceClosePosting(postingId, new Date(), tx);
      // A concurrent close raced us → still a no-op success (terminal state reached).
      if (!closed) return;
      changed = true;
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.posting_force_closed,
        "job_posting",
        postingId,
        ctx,
        tx,
      );
    });
    return { target_id: postingId, changed };
  }

  // ----- worker_flags: flag / unflag ----------------------------------------

  async flagWorker(
    adminId: string,
    workerId: string,
    dto: AdminFlagWorkerDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    let changed = false;
    await this.actions.withTransaction(async (tx) => {
      const opened = await this.actions.openFlag(workerId, dto.reason_code, adminId, tx);
      // Idempotent: a worker already has an OPEN flag → no new row, no event.
      if (!opened) return;
      changed = true;
      await this.emitAction(adminId, ADMIN_ACTION_CODES.worker_flagged, "worker", workerId, ctx, tx);
    });
    return { target_id: workerId, changed };
  }

  async unflagWorker(adminId: string, workerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    let changed = false;
    await this.actions.withTransaction(async (tx) => {
      const resolved = await this.actions.resolveFlag(workerId, adminId, tx);
      // Idempotent: no open flag to resolve → no-op success, no event.
      if (!resolved) return;
      changed = true;
      await this.emitAction(adminId, ADMIN_ACTION_CODES.worker_unflagged, "worker", workerId, ctx, tx);
    });
    return { target_id: workerId, changed };
  }

  // ----- admin_users: invite / change role / suspend (manage_admins) --------

  /**
   * Invite a new admin (status defaults 'pending' — invite-then-activate). The email is
   * ADMIN-class PII: encrypted at rest in admin_users, NEVER echoed into the event/response.
   * Returns the new opaque admin id (the audit target). A duplicate email surfaces as a 23505
   * from the repository — mapped to a value-free conflict (no enumeration of which email).
   */
  async inviteAdmin(adminId: string, dto: AdminInviteDto, ctx: RequestContext): Promise<{ admin_id: string }> {
    return this.admins.withTransaction(async (tx) => {
      let created: { id: string };
      try {
        created = await this.admins.create({ role: dto.role, email: dto.email }, tx);
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
        tx,
      );
      return { admin_id: created.id };
    });
  }

  /**
   * Change an admin's RBAC role (super_admin only — `manage_admins`).
   *   - L1: reject demoting YOURSELF or the LAST active super_admin (org-wide lockout guard).
   *   - L2: a role X→X PATCH is a no-op (the repo guard matches no row → no bump, no event).
   *   - H3: the role write + the event commit in ONE transaction.
   */
  async changeAdminRole(
    adminId: string,
    targetAdminId: string,
    dto: AdminChangeRoleDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const target = await this.admins.findById(targetAdminId);
    if (!target) throw new NotFoundException("Admin not found");

    // L2: same-role PATCH → no-op success (no row bump, no event). Distinguish this from the
    // not-found case the repo's guarded update would otherwise conflate.
    if (target.role === dto.role) return { target_id: targetAdminId, changed: false };

    // L1: never demote yourself; never demote the last active super_admin → org-wide lockout.
    if (targetAdminId === adminId) {
      throw new ConflictException("An admin cannot change their own role");
    }
    if (target.role === "super_admin" && dto.role !== "super_admin") {
      const activeSupers = await this.admins.countActiveSuperAdmins();
      if (activeSupers <= 1) {
        throw new ConflictException("Cannot demote the last active super_admin");
      }
    }

    let changed = false;
    await this.admins.withTransaction(async (tx) => {
      const updated = await this.admins.updateRole(targetAdminId, dto.role, tx);
      // Guarded on role != newRole; the same-role no-op was already handled above, so undefined
      // here means a concurrent change raced us to the same role → still a no-op success.
      if (!updated) return;
      changed = true;
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.admin_role_changed,
        "admin_session",
        targetAdminId,
        ctx,
        tx,
      );
    });
    return { target_id: targetAdminId, changed };
  }

  /**
   * Suspend an admin (super_admin only — `manage_admins`).
   *   - L1: reject suspending YOURSELF or the LAST active super_admin (org-wide lockout guard).
   *   - idempotent: already suspended → no-op success, no event.
   *   - H3: the suspend write + the event commit in ONE transaction.
   */
  async suspendAdmin(
    adminId: string,
    targetAdminId: string,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const existing = await this.admins.findById(targetAdminId);
    if (!existing) throw new NotFoundException("Admin not found");
    // Idempotent: already suspended → no-op success, no event.
    if (existing.status === "suspended") return { target_id: targetAdminId, changed: false };

    // L1: never suspend yourself; never suspend the last active super_admin → org-wide lockout.
    if (targetAdminId === adminId) {
      throw new ConflictException("An admin cannot suspend themselves");
    }
    if (existing.role === "super_admin") {
      const activeSupers = await this.admins.countActiveSuperAdmins();
      if (activeSupers <= 1) {
        throw new ConflictException("Cannot suspend the last active super_admin");
      }
    }

    let changed = false;
    await this.admins.withTransaction(async (tx) => {
      const suspended = await this.admins.suspend(targetAdminId, tx);
      if (!suspended) return; // raced to suspended → no-op success
      changed = true;
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.admin_suspended,
        "admin_session",
        targetAdminId,
        ctx,
        tx,
      );
    });
    return { target_id: targetAdminId, changed };
  }

  /**
   * ADR-0038 — RESET an admin's second factor (super_admin only, `manage_admins`).
   *
   * WHY THIS HAS TO EXIST. A TOTP seed is shown once at enrolment and stored encrypted; it
   * is recoverable from nowhere. Before this, an admin who lost their phone was locked out
   * PERMANENTLY — `AdminMfaSecretStore.clear()` existed but had ZERO callers, and
   * `setMfaEnrolled` was only ever called with `true`. There was no reset route at all.
   *
   * Clearing the seed AND the flag together drops the admin back to the enrolment branch of
   * `verifyLogin`, so their next successful OTP hands them a fresh secret. Clearing only one
   * would be worse than nothing: seed-without-flag leaves an admin the MFA gate never
   * challenges (a silent second-factor bypass), and flag-without-seed locks them out exactly
   * as before.
   *
   * NOT self-service, deliberately. A route an admin can call for THEMSELVES would let
   * anyone holding a stolen session strip the second factor off the account they stole —
   * which is precisely what MFA is there to stop. Recovery is another human's decision.
   *
   * The LAST super_admin losing their device is still unrecoverable through this route (no
   * one is left who can call it); that case is the break-glass CLI, `db:admin:reset-mfa`.
   */
  async resetAdminMfa(
    adminId: string,
    targetAdminId: string,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const target = await this.admins.findById(targetAdminId);
    if (!target) throw new NotFoundException("Admin not found");

    // Self-reset is refused even for a super_admin — see above. The CLI covers the case
    // where refusing this would leave nobody able to recover the platform.
    if (targetAdminId === adminId) {
      throw new ConflictException(
        "An admin cannot reset their own second factor; ask another super_admin, or use the break-glass CLI",
      );
    }

    let changed = false;
    await this.admins.withTransaction(async (tx) => {
      // Idempotent: an admin with no enrolled factor is already in the state this produces.
      if (!target.mfaEnrolled) return;
      await this.admins.setMfaSecret(targetAdminId, null, tx);
      await this.admins.setMfaEnrolled(targetAdminId, false, tx);
      changed = true;
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.admin_mfa_reset,
        "admin_session",
        targetAdminId,
        ctx,
        tx,
      );
    });
    return { target_id: targetAdminId, changed };
  }

  // ----- single emit chokepoint (value-free spine) --------------------------

  /**
   * Emit EXACTLY ONE `admin.action_performed` — code + opaque ids ONLY. The payload shape is
   * the FULL `AdminActionPerformedPayload` ({admin_id, action_code, target_type, target_id});
   * `.strict()` rejects any extra key, so a value can never be smuggled onto the spine.
   *
   * `tx` (H3): the event row is inserted on the SAME transaction as the SoR write, so the two
   * commit atomically. `dedupKey` overrides the default per-request idempotency key — for the
   * money path it is the caller-supplied grant key, so ledger + spine dedup on the same value.
   *
   * The default `idempotencyKey` makes the spine write exactly-once under an at-least-once retry
   * of the SAME logical mutation (action + actor + target + request).
   */
  private emitAction(
    adminId: string,
    actionCode: AdminActionCode,
    subjectType: AdminActionSubjectType,
    targetId: string,
    ctx: RequestContext,
    tx?: Database,
    dedupKey?: string,
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
      idempotencyKey:
        dedupKey !== undefined
          ? `admin_action:${actionCode}:${dedupKey}`
          : `admin_action:${actionCode}:${adminId}:${targetId}:${ctx.requestId}`,
      tx,
    });
  }
}

/** Postgres unique-violation (23505) — a duplicate admin email on invite. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
