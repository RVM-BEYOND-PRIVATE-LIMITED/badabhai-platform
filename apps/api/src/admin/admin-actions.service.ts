import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
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
  constructor(
    private readonly actions: AdminActionsRepository,
    private readonly admins: AdminRepository,
    private readonly events: EventsService,
    // ADR-0027 B5.x Inc 2: resolves the OWNING org for the TARGET payer so a credit grant lands
    // on the ORG wallet (org_id is NOT NULL from Inc 0's migration 0034).
    private readonly payerOrgs: PayerOrgsRepository,
  ) {}

  // ----- payers: suspend / reinstate ----------------------------------------

  async suspendPayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: already suspended → no-op success, no event.
    if (current.status === "suspended") return { target_id: payerId, changed: false };
    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.suspendPayer(payerId, tx);
      if (!moved) {
        // pending (never-active) cannot be suspended — a defined, value-free conflict.
        conflict = true;
        return;
      }
      await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_suspended, "payer", payerId, ctx, tx);
    });
    if (conflict) throw new ConflictException("Payer is not active and cannot be suspended");
    return { target_id: payerId, changed: true };
  }

  async reinstatePayer(adminId: string, payerId: string, ctx: RequestContext): Promise<AdminActionResult> {
    const current = await this.actions.findPayerStatus(payerId);
    if (!current) throw new NotFoundException("Payer not found");
    // Idempotent: already active → no-op success, no event.
    if (current.status === "active") return { target_id: payerId, changed: false };
    let conflict = false;
    await this.actions.withTransaction(async (tx) => {
      const moved = await this.actions.reinstatePayer(payerId, tx);
      if (!moved) {
        conflict = true;
        return;
      }
      await this.emitAction(adminId, ADMIN_ACTION_CODES.payer_reinstated, "payer", payerId, ctx, tx);
    });
    if (conflict) throw new ConflictException("Payer is not suspended and cannot be reinstated");
    return { target_id: payerId, changed: true };
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
   *
   * ADR-0027 B5.x Inc 2 (wallet flip): the grant lands on the TARGET payer's ORG wallet. The org
   * is resolved BEFORE the transaction (mirrors the unlocks pre-tx resolve): `resolveOrgForPayer`
   * first, falling back to `ensureSoloOrg` for a payer created after the B5.1 backfill (idempotent
   * — a no-op when the solo org already exists). If NO org resolves the grant FAILS CLOSED (404,
   * the same NotFound the invalid-target path uses) — we NEVER write a half row without org_id
   * (which would 500 on the NOT-NULL column from Inc 0). BEHAVIOR-PRESERVING under solo orgs.
   */
  async grantCredits(
    adminId: string,
    payerId: string,
    dto: AdminGrantCreditsDto,
    ctx: RequestContext,
  ): Promise<AdminActionResult & { ledger_id: string; balance: number }> {
    const exists = await this.actions.findPayerStatus(payerId);
    if (!exists) throw new NotFoundException("Payer not found");

    // ADR-0027 B5.x Inc 2: resolve the TARGET payer's OWNING org BEFORE the tx (mirrors the
    // unlocks pre-tx resolve). resolveOrgForPayer (read) first; ensureSoloOrg (idempotent write)
    // is the backfill fallback for a payer created after B5.1. FAIL CLOSED on null — no org means
    // no wallet to credit, so we do NOT write a half row (org_id is NOT NULL); a 404 mirrors the
    // invalid-target path the admin grant already uses.
    const orgId =
      (await this.payerOrgs.resolveOrgForPayer(payerId))?.orgId ??
      (await this.payerOrgs.ensureSoloOrg(payerId))?.orgId ??
      null;
    if (orgId === null) throw new NotFoundException("Payer org not found");

    const result = await this.actions.withTransaction(async (tx) => {
      const grant = await this.actions.grantCredits(orgId, payerId, dto.amount, dto.idempotency_key, tx);
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
