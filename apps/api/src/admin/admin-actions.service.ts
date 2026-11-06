import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database, PayerStatus } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayerSessionService } from "../payers/payer-session.service";
import { SessionService } from "../auth/session.service";
import { PinRepository } from "../auth/pin.repository";
import { AdminRepository } from "./admin.repository";
import { AdminActionsRepository } from "./admin-actions.repository";
import { AdminInviteService } from "./admin-invite.service";
import { assertNotAgencyTwin } from "../common/agency-twin-fence";
import type {
  AdminActionResult,
  AdminChangeRoleDto,
  AdminFlagWorkerDto,
  AdminGrantCreditsDto,
  AdminInviteDto,
  AdminWorkerPinResetDto,
  AdminWorkerSignOutAllDto,
  AdminWorkerSuspendDto,
  AdminWorkerUnsuspendDto,
} from "./admin-actions.dto";

import { ADMIN_ACTION_CODES, type AdminActionCode } from "./admin-action-codes";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
export { ADMIN_ACTION_CODES } from "./admin-action-codes";
export type { AdminActionCode } from "./admin-action-codes";

/**
 * The faceless event subject for each action's target entity (one of the registered subjects).
 *
 * `"skill_candidate"` (migration 0093) is listed here ONLY because it is now a real member of
 * `SUBJECT_TYPES` (packages/event-schema/src/enums.ts, verified on disk 2026-08-26 — 27 members).
 * The order matters and is not cosmetic: the envelope's `subject_type` is the CLOSED
 * `z.enum(SUBJECT_TYPES)` (envelope.ts:24-27), so widening this local union AHEAD of that list
 * produces a change that typechecks and then throws `EventValidationException` at
 * `stage:"envelope"` inside `createEvent` — before any insert, and INSIDE the caller's
 * transaction, which rolls the review decision back. Compile-clean, runtime-fatal, and invisible
 * to every unit test that stubs the emit.
 */
type AdminActionSubjectType =
  | "payer"
  | "job_posting"
  | "job"
  | "worker"
  | "admin_session"
  | "skill_candidate";

/**
 * Governed admin entity actions (ADR-0025 ADMIN-3a, Decision 3/5/6). Each method mutates a
 * SYSTEM-OF-RECORD (payers.status / credit_ledger / job_postings.status / worker_flags /
 * admin_users, and #2562's workers.status + worker_credentials + the worker session lineage)
 * and emits EXACTLY ONE registry-validated `admin.action_performed` carrying the
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
    // The accept-link seam (mint / hash / expire / render / deliver). Holds every rule about
    // where a raw invite token may travel.
    private readonly invites: AdminInviteService,
    // #2562 — WORKER sessions (a separate Redis lineage from the payer one above).
    private readonly workerSessions: SessionService,
    // #2562 — the worker's device-unlock PIN credential. An admin reset deletes it.
    private readonly pins: PinRepository,
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
    // #2564 - an ARCHIVED company is not suspendable: the guarded update admits pending/active
    // only, so without this the archive would surface as a misleading "changed concurrently".
    if (current.status === "archived") {
      throw new ConflictException("Payer is archived; restore the company first");
    }
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
    // #2564 - reinstate does NOT lift an archive (that is `restore`, which also brings the team
    // back). A silent no-op here would read as success on an account that is still archived.
    if (current.status === "archived") {
      throw new ConflictException("Payer is archived; restore the company instead");
    }
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
    // #2564 - an ARCHIVED company is barred the same way.
    if (isBarredPayerStatus(payer.status)) {
      throw new ConflictException(`Payer is ${payer.status}; credits cannot be granted`);
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
    // ADR-0050 §4.3 — a twin is closed by its source (the agency job), via the sync, never here.
    assertNotAgencyTwin(current.syncSource);
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

  // ----- workers: account actions (#2562, manage_worker_account) --------------

  /**
   * #2562 — end EVERY session and device the worker holds.
   *
   * The audit row and `admin.action_performed` commit in ONE transaction first; the Redis
   * sweep runs after it. Redis is not transactional with Postgres: sweeping first and then
   * failing the audit write would sign the worker out with no record of why, whereas a sweep
   * that runs a moment later still ends every session. `SessionService.revokeAll` is the same
   * seam the worker's own logout-all uses (sessions, refresh families, trusted devices, and
   * the push warning), so this action cannot drift from that contract.
   */
  async signOutAllWorker(
    adminId: string,
    workerId: string,
    dto: AdminWorkerSignOutAllDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const current = await this.actions.findWorkerStatus(workerId);
    if (!current) throw new NotFoundException("Worker not found");

    // SWEEP FIRST, STRICTLY. Redis is not transactional with Postgres, so a sweep failure
    // after the audit commit would report an action that did not happen. Running it first means
    // a failure writes nothing and returns 503; a retry is safe (the sweep and the watermark are
    // idempotent). The audit row + admin action then commit together.
    await this.revokeWorkerSessions(workerId, adminId, "sign-out-all");

    await this.actions.withTransaction(async (tx) => {
      await this.actions.writeAuditReason(tx, {
        adminId,
        workerId,
        action: ADMIN_ACTION_CODES.worker_signed_out_all,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.worker_signed_out_all,
        "worker",
        workerId,
        ctx,
        tx,
      );
    });

    return { target_id: workerId, changed: true };
  }

  /**
   * #2562 — reset the worker's PIN by DELETING the credential and ending every live session.
   *
   * WHY BOTH, and why this is the ADR-0062 §3.8 approval condition: `POST /auth/pin/set`
   * lets an ALREADY-AUTHENTICATED worker choose a PIN without a fresh OTP. If a session
   * survived the reset, its holder could set a PIN WITHOUT proving they hold the phone. The
   * sweep makes a new phone-code sign-in the only way back in, and that sign-in returns
   * `pin_set:false`, routing the worker to set-PIN. The credential is deleted in the same
   * transaction as the audit row + both events; the Redis sweep follows the commit.
   */
  async resetWorkerPin(
    adminId: string,
    workerId: string,
    dto: AdminWorkerPinResetDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const current = await this.actions.findWorkerStatus(workerId);
    if (!current) throw new NotFoundException("Worker not found");

    // SWEEP FIRST, STRICTLY — see signOutAllWorker. The durable PIN-reset audit row is written
    // only after every session is provably gone; a Redis failure returns 503 and no reset.
    await this.revokeWorkerSessions(workerId, adminId, "PIN reset");

    await this.actions.withTransaction(async (tx) => {
      await this.pins.deleteByWorkerId(workerId, tx);
      await this.actions.writeAuditReason(tx, {
        adminId,
        workerId,
        action: ADMIN_ACTION_CODES.worker_pin_reset,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.worker_pin_reset,
        "worker",
        workerId,
        ctx,
        tx,
      );
      // The domain fact, alongside the admin-action record. Actor = the ADMIN: this reset
      // was not worker-initiated. Payload stays `{worker_id}` (never the PIN/hash).
      await this.events.emit({
        event_name: "worker.pin_reset",
        actor: { actor_type: "admin", actor_id: adminId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `worker.pin_reset:${workerId}:${ctx.requestId}`,
        tx,
      });
    });

    return { target_id: workerId, changed: true };
  }

  /**
   * #2562 — suspend a worker's account.
   *
   * The status write + audit row + `admin.action_performed` commit together; the session
   * sweep follows. Enforcement is not the sweep alone: the guard, refresh, OTP mint and PIN
   * unlock all read the CURRENT status, so a session that survives a failed Redis sweep
   * still cannot be used. Idempotent: already suspended → no-op success, no event.
   */
  async suspendWorker(
    adminId: string,
    workerId: string,
    dto: AdminWorkerSuspendDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const current = await this.actions.findWorkerStatus(workerId);
    if (!current) throw new NotFoundException("Worker not found");
    if (current.status === "suspended") return { target_id: workerId, changed: false };

    // SWEEP FIRST, STRICTLY. A session that survives a failed sweep must not exist after a
    // successful suspend, and a failed sweep must leave the worker un-suspended so the retry
    // can finish. The durable watermark makes a sweep that DID succeed hold even if a record
    // survives; the status write follows in its own transaction.
    await this.revokeWorkerSessions(workerId, adminId, "suspension");

    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.suspendWorker(workerId, tx);
      if (!moved) {
        // A concurrent writer moved the row between the read above and this update.
        conflict = true;
        return;
      }
      await this.actions.writeAuditReason(tx, {
        adminId,
        workerId,
        action: ADMIN_ACTION_CODES.worker_suspended,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.worker_suspended,
        "worker",
        workerId,
        ctx,
        tx,
      );
    });
    if (conflict) throw new ConflictException("Worker status changed concurrently; retry");

    return { target_id: workerId, changed: true };
  }

  /**
   * #2562 — restore a suspended worker's access. Unsuspend ALWAYS writes `active`: it is the
   * only status that carries access, there is no "previous status" column, and no migration
   * adds one. Re-suspending is a fresh admin action with its own reason, audit row and sweep.
   *
   * The sweep runs AGAIN (strictly) before the status write. Suspension already ended every
   * session, but a session that survived a failed suspend sweep must not come back to life;
   * if this sweep fails the worker stays `suspended`, so the operator's retry repeats the same
   * safe path. Signing in afterwards still requires a fresh OTP/MFA proof. Idempotent: an
   * already-active worker is a no-op.
   */
  async unsuspendWorker(
    adminId: string,
    workerId: string,
    dto: AdminWorkerUnsuspendDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult> {
    const current = await this.actions.findWorkerStatus(workerId);
    if (!current) throw new NotFoundException("Worker not found");
    if (current.status !== "suspended") return { target_id: workerId, changed: false };

    // #2562 — run the sweep AGAIN, strictly, before restoring the status. A suspend whose
    // sweep failed left the worker suspended (and returned 503); this retry kills any session
    // that survived it. Doing it before the status write keeps a failed sweep retry-safe: the
    // worker stays suspended, so a second unsuspend repeats the same path.
    await this.revokeWorkerSessions(workerId, adminId, "unsuspend");

    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.reinstateWorker(workerId, tx);
      if (!moved) {
        conflict = true;
        return;
      }
      await this.actions.writeAuditReason(tx, {
        adminId,
        workerId,
        action: ADMIN_ACTION_CODES.worker_reinstated,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.worker_reinstated,
        "worker",
        workerId,
        ctx,
        tx,
      );
    });
    if (conflict) throw new ConflictException("Worker status changed concurrently; retry");

    return { target_id: workerId, changed: true };
  }

  /**
   * #2562 — STRICT worker-session sweep for an admin account action. Unlike the worker's own
   * logout-all, a Redis failure must not be reported as success: the caller gets 503 and no
   * audit/SoR change (the sweep runs before those writes). The watermark and deletes are
   * idempotent, so the operator's retry is safe.
   *
   * The event's actor is the ADMIN, not the worker — the payload still carries only
   * `{worker_id, sessions_revoked}`.
   */
  private async revokeWorkerSessions(
    workerId: string,
    adminId: string,
    action: string,
  ): Promise<void> {
    try {
      const revoked = await this.workerSessions.revokeAllStrict(workerId, {
        actor_type: "admin",
        actor_id: adminId,
      });
      this.logger.log(`worker ${action}; sessions revoked worker=${workerId} count=${revoked}`);
    } catch (err) {
      this.logger.error(
        `worker ${action} aborted: session sweep FAILED worker=${workerId} ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      throw new ServiceUnavailableException(
        "The worker's sessions could not be ended. Try again.",
      );
    }
  }

  // ----- admin_users: invite / change role / suspend (manage_admins) --------

  /**
   * Invite a new admin (status defaults 'pending' — invite-then-activate). The email is
   * ADMIN-class PII: encrypted at rest in admin_users, NEVER echoed into the event.
   * A duplicate email is either a re-invite of a still-pending admin (refreshed in place) or a
   * value-free conflict (no enumeration of which email).
   *
   * WHAT CHANGED, AND WHY IT HAD TO: this flow previously created the `pending` row and
   * stopped. Nothing in the codebase ever moved an admin from `pending` to `active`
   * (`markActive` had no production caller), and only an `'active'` admin may authenticate —
   * so every invite ever issued was a dead end: the invitee requested a login code and got
   * the same neutral failure an unknown address gets, forever. The invite now mints a
   * single-use accept token that {@link AdminAuthService.acceptInvite} redeems for exactly
   * that missing transition.
   *
   * The RAW token leaves this method by two paths and no others: the invite email, and the
   * one-time `accept_url` in the response to the inviting super_admin. The second path is a
   * deliberate owner decision — it makes onboarding work with no email provider configured,
   * which is the alpha posture — and it is why only `manage_admins` (super_admin) can reach
   * this route. Only the HMAC is persisted; neither the token nor the link is ever logged or
   * evented.
   *
   * Delivery is best-effort and NON-FATAL: the invite is already committed and evented when
   * the mailer runs, so a send failure is logged (PII-free) and the caller still receives the
   * link to share out-of-band. Failing the request instead would roll nothing back — the
   * admin row would be committed — and would hand the super_admin an error for an invite that
   * actually exists, with no way to retrieve its link.
   */
  async inviteAdmin(
    adminId: string,
    dto: AdminInviteDto,
    ctx: RequestContext,
  ): Promise<{ admin_id: string; accept_url: string; expires_at: string }> {
    // Minted OUTSIDE the transaction: it is pure randomness, and holding a DB transaction open
    // across a CSPRNG call buys nothing.
    const rawToken = this.invites.mintToken();
    const expiresAt = this.invites.expiryFrom(new Date());

    const created = await this.admins.withTransaction(async (tx) => {
      const row = await this.createOrRefreshInvite(dto, rawToken, expiresAt, tx);
      // The target of an admin-management action is the affected admin (the admin_session subject).
      await this.emitAction(
        adminId,
        ADMIN_ACTION_CODES.admin_invited,
        "admin_session",
        row.id,
        ctx,
        tx,
      );
      return row;
    });

    const acceptUrl = this.invites.buildAcceptUrl(rawToken);
    await this.invites.deliver(dto.email, acceptUrl, created.id);

    return {
      admin_id: created.id,
      accept_url: acceptUrl,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Insert the invited admin, or refresh the token of one who is STILL PENDING.
   *
   * Re-inviting matters in practice: the 48h link lapses, or the first email never arrived,
   * and without this the super_admin would be permanently stuck on a 409 for an address that
   * can never be used. The refresh is guarded on `status = 'pending'` in the repository, so
   * an ACTIVE or SUSPENDED admin's email still conflicts — re-pointing a live admin account
   * at a fresh accept link would be an account-takeover primitive, not a convenience.
   */
  private async createOrRefreshInvite(
    dto: AdminInviteDto,
    rawToken: string,
    expiresAt: Date,
    tx: Database,
  ): Promise<{ id: string }> {
    const inviteTokenHash = this.invites.hashToken(rawToken);
    const created = await this.admins.createUnlessEmailTaken(
      { role: dto.role, email: dto.email, inviteTokenHash, inviteExpiresAt: expiresAt },
      tx,
    );
    if (created) return created;
    const refreshed = await this.admins.refreshInvite(
      this.admins.emailHash(dto.email),
      { role: dto.role, inviteTokenHash, inviteExpiresAt: expiresAt },
      tx,
    );
    // No pending row matched → the address belongs to an active/suspended admin. Value-free
    // so the response never confirms WHICH email is taken.
    if (!refreshed) throw new ConflictException("An admin with that email already exists");
    return refreshed;
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
