import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";
import { type Database, type PayerRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import {
  CURRENT_PASSWORD_PEPPER_VERSION,
  generateTemporaryPassword,
} from "../common/password-policy";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { FreeTierService } from "../match/free-tier.service";
import type { CreatePayerInput } from "../payers/payers.repository";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerSessionService } from "../payers/payer-session.service";
import { PayerPasswordStateService } from "../payers/payer-password-state.service";
import { PayerSecurityNoticeService } from "../payers/payer-security-notice.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { AdminIdentityService } from "./admin-identity.service";
import { AdminPayerLoginsRepository } from "./admin-payer-logins.repository";
import type {
  AdminAccountListItem,
  AdminAccountsPage,
  AdminAccountsQueryDto,
  AdminCreatePayerLoginDto,
  AdminCreatePayerLoginResponse,
  AdminIssueTemporaryPasswordDto,
  AdminIssueTemporaryPasswordResponse,
  AdminRevokePayerPasswordDto,
  AdminRevokePayerPasswordResponse,
} from "./admin-payer-logins.dto";

/**
 * #2563 — payer login administration (the Admin Portal's User accounts screen).
 *
 * ── WHAT AN ADMIN MAY DO ────────────────────────────────────────────────────────────────
 * Create an owner login or a team-member login, issue a temporary password, and revoke password
 * sign-in. The route capability is `manage_payer_credentials` (super_admin, ops_admin, support);
 * the accounts list's login IDs and organisation names are additionally gated by
 * `read_identity` inside {@link AdminIdentityService}, so the list degrades to a faceless
 * account state rather than leaking identity to a holder without that row.
 *
 * ── CREDENTIAL RULES ────────────────────────────────────────────────────────────────────
 * A temporary password is generated here with `crypto.randomInt`, stored ONLY as a scrypt hash,
 * marked `must_change_password`, and returned exactly once in the create/issue response. It is
 * never logged, evented, audited or thrown in an error. The caller must replace it before any
 * session is issued; the OTP door refuses such an account with 409 for the same reason.
 *
 * ── ATOMICITY ───────────────────────────────────────────────────────────────────────────
 * The payer row, org/membership, credential, `audit_logs` reason row and
 * `admin.action_performed` all commit in ONE Postgres transaction. Redis session revocation
 * runs after the commit: Redis is not transactional with Postgres, and a revoke inside the
 * transaction could undo a rollback. The credential-epoch watermark (`sessions_valid_after`)
 * is stamped in the same write, so a missed Redis delete still ends old sessions on their next
 * request.
 */
@Injectable()
export class AdminPayerLoginsService {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly repo: AdminPayerLoginsRepository,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly sessions: PayerSessionService,
    private readonly lockStates: PayerPasswordStateService,
    private readonly identity: AdminIdentityService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly freeTier: FreeTierService,
    private readonly notice: PayerSecurityNoticeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read: the User accounts list
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/accounts — one keyset page of payer logins.
   *
   * Login IDs and organisation names are resolved through the identity boundary, which checks
   * `read_identity`, the per-admin name budget and commits `admin.identity_viewed` BEFORE any
   * plaintext exists. Two resolutions at most: the login identifier on the payer ids, and the
   * organisation name on the ORG ROOT ids (a team member's organisation is the parent org, not
   * their own payer row). The page is clamped to 50 by the DTO, the same bound the identity
   * service enforces.
   */
  async listAccounts(
    admin: AuthenticatedAdmin,
    query: AdminAccountsQueryDto,
    ctx: RequestContext,
  ): Promise<AdminAccountsPage> {
    const { rows, nextCursor } = await this.repo.listAccounts({
      cursor: query.cursor,
      limit: query.limit,
      role: query.role,
      status: query.status,
      passwordState: query.password_state,
      orgId: query.org_id,
      tempPasswordCutoff: new Date(
        Date.now() - this.config.PAYER_TEMP_PASSWORD_TTL_HOURS * 3_600_000,
      ),
    });

    const ids = rows.map((row) => row.id);
    const [memberships, rootOrgs, lockStates] = await Promise.all([
      this.repo.activeMemberships(ids),
      this.repo.orgsByRootPayer(ids),
      this.lockStates.lockStates(ids),
    ]);
    const memberOrgIds = memberships.map((m) => m.orgId);
    const memberOrgs = await this.repo.orgsByIds(memberOrgIds);
    const orgById = new Map([...rootOrgs, ...memberOrgs].map((org) => [org.id, org]));

    const membershipByPayer = new Map(
      memberships
        .filter((m): m is typeof m & { memberPayerId: string } => m.memberPayerId !== null)
        .map((m) => [m.memberPayerId, m]),
    );
    const rootById = new Map(rootOrgs.map((org) => [org.rootPayerId, org]));

    const typeOf = (rowId: string, role: PayerRole): AdminAccountListItem["type"] => {
      if (rootById.has(rowId)) return role === "employer" ? "company_owner" : "agency_owner";
      if (membershipByPayer.has(rowId)) return "team_member";
      return role === "employer" ? "company_owner" : "agency_owner";
    };
    const orgIdOf = (rowId: string): string | null => {
      const root = rootById.get(rowId);
      if (root) return root.id;
      const membership = membershipByPayer.get(rowId);
      return membership?.orgId ?? null;
    };
    const rootIdOf = (rowId: string): string => {
      const membership = membershipByPayer.get(rowId);
      if (!membership) return rowId;
      return orgById.get(membership.orgId)?.rootPayerId ?? rowId;
    };

    const rootIds = [...new Set(ids.map(rootIdOf))];
    // Two identity resolutions, each independently gated and budgeted. Sequential on purpose:
    // the budget reservation is a read-modify-write in Redis, and two concurrent consumers for
    // the same admin would race a threshold that is meant to be exact.
    const loginIds = await this.identity.resolve(admin, "payer_logins", ids, null, ctx);
    const orgNames = await this.identity.resolve(admin, "payers", rootIds, null, ctx);

    const items: AdminAccountListItem[] = rows.map((row) => {
      const item: AdminAccountListItem = {
        id: row.id,
        type: typeOf(row.id, row.role),
        org_id: orgIdOf(row.id),
        role: row.role,
        status: row.status,
        last_login_at: row.lastLoginAt,
        password_state: this.passwordState(row),
        password_set_at: row.passwordSetAt,
        locked: lockStates.get(row.id) ?? null,
      };
      if (loginIds !== null) item.login_id = loginIds.get(row.id) ?? null;
      if (orgNames !== null) item.organisation = orgNames.get(rootIdOf(row.id)) ?? null;
      return item;
    });

    return { items, nextCursor };
  }

  /** Password state, resolved in the order the contract promises. */
  private passwordState(row: {
    mustChangePassword: boolean;
    passwordRevokedAt: Date | null;
    passwordSetAt: Date | null;
    hasPassword: boolean;
  }): AdminAccountListItem["password_state"] {
    if (row.mustChangePassword) {
      const ttlMs = this.config.PAYER_TEMP_PASSWORD_TTL_HOURS * 3_600_000;
      if (row.passwordSetAt === null || Date.now() - row.passwordSetAt.getTime() > ttlMs) {
        return "temporary_expired";
      }
      return "temporary_pending";
    }
    if (
      row.passwordRevokedAt !== null &&
      (row.passwordSetAt === null || row.passwordRevokedAt >= row.passwordSetAt)
    ) {
      return "revoked";
    }
    if (row.passwordSetAt !== null || row.hasPassword) return "set";
    return "none";
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/payers — create an owner or team-member login with a temporary password.
   *
   * The account is ACTIVE immediately (owner decision): an admin just proved the contact and
   * issued the credential, so there is no mailbox round-trip to wait for. The owner path reuses
   * `createOrGet` + `ensureSoloOrg` + the free-tier grant, exactly like self-serve signup; the
   * team-member path attaches an active membership with NO invite token.
   *
   * 409 when the email/phone hash already exists — the accounts list already shows the login,
   * and silently resetting someone's password from a "create" form would be a destructive
   * surprise. A concurrent insert is caught the same way: `createOrGet` returns `created:false`
   * and the transaction rolls back before any credential or event exists.
   *
   * KNOWN BEHAVIOUR: the transaction commits BEFORE the live-session sweep. If the session
   * store is unavailable at that point the admin receives a 500 and the temporary password is
   * not returned. The account exists with an unknown temporary password; the admin recovers by
   * calling the issue route (safe to retry, it replaces the credential) — never by re-running
   * create, which 409s.
   */
  async createLogin(
    admin: AuthenticatedAdmin,
    dto: AdminCreatePayerLoginDto,
    ctx: RequestContext,
  ): Promise<AdminCreatePayerLoginResponse> {
    const temporaryPassword = generateTemporaryPassword();
    const hash = this.pii.hashPassword(temporaryPassword);
    const loginId = dto.email ?? dto.phone!;

    let payerId = "";
    let conflictPayerId: string | null = null;
    let createdRole: PayerRole = dto.role ?? "employer";

    try {
      await this.repo.withTransaction(async (tx) => {
        // The login ID must be free on BOTH channels: email has a unique index, phone does not
        // (historical rows may share one), and `createOrGet` keys on email when both are supplied.
        // Without these reads a phone that already has an account would get a SECOND one under a
        // new email. The unique index still closes the email race; the phone race is closed by
        // `createOrGetByPhone`'s advisory lock on the phone-only path.
        if (dto.email !== undefined) {
          const existing = await this.payers.findByEmail(dto.email);
          if (existing !== undefined) {
            conflictPayerId = existing.id;
            throw new ConflictException("A login with this email or phone already exists");
          }
        }
        if (dto.phone !== undefined) {
          const matches = await this.payers.findByPhone(dto.phone);
          if (matches.length > 0) {
            conflictPayerId = matches[0]!.id;
            throw new ConflictException("A login with this email or phone already exists");
          }
        }

        let orgId: string | null = null;
        let createInput: CreatePayerInput;

        if (dto.member_of_org_id !== undefined) {
          const org = await this.orgs.findOrgById(dto.member_of_org_id);
          if (!org) throw new NotFoundException("Organisation not found");
          if (org.status !== "active") {
            throw new ConflictException("Organisation is suspended");
          }
          const root = await this.payers.findById(org.rootPayerId);
          if (!root) throw new NotFoundException("Organisation not found");
          createdRole = root.role;
          orgId = org.id;
          createInput = {
            role: root.role,
            email: dto.email,
            phone: dto.phone,
            // Copy the tenant's ciphertext: no admin-side decrypt, and no exact-name login hash
            // for a member (they sign in by email/phone, never by the company name).
            orgNameEnc: org.nameEnc ?? root.orgNameEnc,
          };
        } else {
          createInput = {
            role: dto.role!,
            email: dto.email,
            phone: dto.phone,
            orgName: dto.org_name!,
          };
        }

        const created = await this.payers.createOrGet(createInput, tx);
        if (!created.created) {
          conflictPayerId = created.id;
          throw new ConflictException("A login with this email or phone already exists");
        }
        payerId = created.id;

        if (orgId !== null) {
          const row = await this.payers.findById(created.id, tx);
          if (!row) throw new Error("payer created but not readable in the same transaction");
          await this.orgs.createActiveMember(
            {
              orgId,
              memberPayerId: created.id,
              emailEnc: row.emailEnc,
              emailHash: row.emailHash,
              // The founder stays the sole owner of the org (existing tenancy rule); an admin
              // can only add a recruiter, never a co-owner.
              orgRole: dto.org_role ?? "recruiter",
            },
            tx,
          );
        } else {
          await this.orgs.ensureSoloOrg(created.id, tx);
        }

        // BLOCKER #2563 review: `payers.status` defaults to `pending`. An admin just proved the
        // contact and issued the credential, so the account is ACTIVE immediately; leaving it
        // pending made both sign-in doors refuse the very login this route created.
        const activated = await this.payers.activate(created.id, tx);
        if (activated) {
          await this.emitActivated(tx, admin.id, created.id, ctx);
        }

        await this.payers.setTemporaryPassword(
          created.id,
          { hash, pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION },
          tx,
        );
        await this.repo.writeAuditReason(tx, {
          adminId: admin.id,
          payerId: created.id,
          action: ADMIN_ACTION_CODES.payer_login_created,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
        });
        await this.emitAction(
          tx,
          admin.id,
          ADMIN_ACTION_CODES.payer_login_created,
          created.id,
          ctx,
        );
        // The domain fact that an account exists. Admin-created logins are password logins;
        // `payer.created` carries no contact PII, only the opaque id and the role.
        await this.events.emit({
          event_name: "payer.created",
          actor: { actor_type: "payer", actor_id: created.id },
          subject: { subject_type: "payer", subject_id: created.id },
          payload: {
            payer_id: created.id,
            role: createdRole,
            method: "password",
          } satisfies PayloadInputOf<"payer.created">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.created:${created.id}`,
          tx,
        });
      });
    } catch (err) {
      // The 409 transaction rolled back, so the existence check would leave no trace. Write a
      // SEPARATE, value-free audit row OUTSIDE it: admin id, action and the existing payer id
      // only — no email, no phone, no reason text.
      if (err instanceof ConflictException && conflictPayerId !== null) {
        await this.repo.writeConflictAudit(admin.id, conflictPayerId).catch(() => undefined);
      }
      throw err;
    }

    // After commit. The free tier belongs to the OWNER account, exactly as signup grants it;
    // a team member spends the org's existing credits. `grantQuietly` never fails the creation.
    if (dto.member_of_org_id === undefined) await this.freeTier.grantQuietly(payerId);
    // No sessions exist for a just-created account, but the contract is "issue ends every
    // session" and this keeps that true if a retry races a login.
    await this.sessions.revokeAllForPayer(payerId);
    await this.notice.notify(payerId, "reset");

    return {
      payer_id: payerId,
      login_id: loginId,
      temporary_password: temporaryPassword,
      must_change_password: true,
    };
  }

  /**
   * POST /admin/payers/:id/password/temporary — replace the password with a new temporary one.
   * Every existing session ends: the old credential is gone, so a device still holding a
   * session must re-prove the new one.
   *
   * SAFE TO RETRY. The transaction replaces the credential and the lockout clear is idempotent;
   * a retry after a post-commit session-store failure issues a fresh temporary password and
   * sweeps again. The previous temporary password is invalid either way.
   */
  async issueTemporaryPassword(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminIssueTemporaryPasswordDto,
    ctx: RequestContext,
  ): Promise<AdminIssueTemporaryPasswordResponse> {
    const temporaryPassword = generateTemporaryPassword();
    const hash = this.pii.hashPassword(temporaryPassword);

    await this.repo.withTransaction(async (tx) => {
      const row = await this.payers.findById(payerId, tx);
      if (!row) throw new NotFoundException("Payer not found");
      if (row.status === "suspended") {
        throw new ConflictException("Account is suspended");
      }
      // An admin vouches for a pending self-signup by issuing its first credential; leaving it
      // pending would make the new temporary password unusable at both sign-in doors.
      const activated = await this.payers.activate(payerId, tx);
      if (activated) {
        await this.emitActivated(tx, admin.id, payerId, ctx);
      }
      await this.payers.setTemporaryPassword(
        payerId,
        { hash, pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION },
        tx,
      );
      await this.repo.writeAuditReason(tx, {
        adminId: admin.id,
        payerId,
        action: ADMIN_ACTION_CODES.payer_password_issued,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.payer_password_issued, payerId, ctx);
    });

    // The admin's new credential must be usable at once even if the payer was locked out on
    // the OLD one. Best-effort: the issue is safe to retry, which retries this clear too.
    await this.lockStates.clear(payerId);
    await this.sessions.revokeAllForPayer(payerId);
    await this.notice.notify(payerId, "reset");
    return { payer_id: payerId, temporary_password: temporaryPassword, must_change_password: true };
  }

  /**
   * POST /admin/payers/:id/password/revoke — close password sign-in. The email-code door stays
   * open, which is what lets the payer recover the account without an admin re-issuing a
   * credential. Idempotent in the write/event half: already revoked → `changed:false`; the
   * live-session sweep still runs so a retry closes any session that appeared in between.
   */
  async revokePassword(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminRevokePayerPasswordDto,
    ctx: RequestContext,
  ): Promise<AdminRevokePayerPasswordResponse> {
    let changed = false;
    await this.repo.withTransaction(async (tx) => {
      const row = await this.payers.findById(payerId, tx);
      if (!row) throw new NotFoundException("Payer not found");
      if (row.passwordRevokedAt !== null && !row.mustChangePassword) return;
      await this.payers.revokePassword(payerId, tx);
      changed = true;
      await this.repo.writeAuditReason(tx, {
        adminId: admin.id,
        payerId,
        action: ADMIN_ACTION_CODES.payer_password_revoked,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.payer_password_revoked, payerId, ctx);
    });

    // Idempotent in the SESSION half too: a retry on an already-revoked account still sweeps
    // every live session. The write/event half stays a no-op.
    await this.sessions.revokeAllForPayer(payerId);
    if (changed) await this.notice.notify(payerId, "revoked");
    return { payer_id: payerId, changed };
  }

  /** One value-free `admin.action_performed` on the caller's transaction. */
  private emitActivated(
    tx: Database,
    adminId: string,
    payerId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: "payer.activated",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: {
        payer_id: payerId,
        previous_status: "pending",
        new_status: "active",
      } satisfies PayloadInputOf<"payer.activated">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `payer.activated:${payerId}:admin:${ctx.requestId}`,
      tx,
    });
  }

  /** One value-free `admin.action_performed` on the caller's transaction. */
  private emitAction(
    tx: Database,
    adminId: string,
    actionCode:
      | typeof ADMIN_ACTION_CODES.payer_login_created
      | typeof ADMIN_ACTION_CODES.payer_password_issued
      | typeof ADMIN_ACTION_CODES.payer_password_revoked,
    payerId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: {
        admin_id: adminId,
        action_code: actionCode,
        target_type: "payer",
        target_id: payerId,
      } satisfies PayloadInputOf<"admin.action_performed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${payerId}:${ctx.requestId}`,
      tx,
    });
  }
}
