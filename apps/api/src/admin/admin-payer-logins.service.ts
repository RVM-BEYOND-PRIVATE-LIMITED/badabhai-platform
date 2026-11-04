import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { type Database, type PayerRole } from "@badabhai/db";
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
    private readonly repo: AdminPayerLoginsRepository,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly sessions: PayerSessionService,
    private readonly lockStates: PayerPasswordStateService,
    private readonly identity: AdminIdentityService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly freeTier: FreeTierService,
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
        password_state: AdminPayerLoginsService.passwordState(row),
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
  private static passwordState(row: {
    mustChangePassword: boolean;
    passwordRevokedAt: Date | null;
    passwordSetAt: Date | null;
    hasPassword: boolean;
  }): AdminAccountListItem["password_state"] {
    if (row.mustChangePassword) return "temporary_pending";
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
    let createdRole: PayerRole = dto.role ?? "employer";

    await this.repo.withTransaction(async (tx) => {
      // The login ID must be free on BOTH channels: email has a unique index, phone does not
      // (historical rows may share one), and `createOrGet` keys on email when both are supplied.
      // Without these reads a phone that already has an account would get a SECOND one under a
      // new email. The unique index still closes the email race; the phone race is closed by
      // `createOrGetByPhone`'s advisory lock on the phone-only path.
      if (dto.email !== undefined && (await this.payers.findByEmail(dto.email)) !== undefined) {
        throw new ConflictException("A login with this email or phone already exists");
      }
      if (dto.phone !== undefined && (await this.payers.findByPhone(dto.phone)).length > 0) {
        throw new ConflictException("A login with this email or phone already exists");
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
            orgRole: dto.org_role ?? "recruiter",
          },
          tx,
        );
      } else {
        await this.orgs.ensureSoloOrg(created.id, tx);
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
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.payer_login_created, created.id, ctx);
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

    // After commit. The free tier belongs to the OWNER account, exactly as signup grants it;
    // a team member spends the org's existing credits. `grantQuietly` never fails the creation.
    if (dto.member_of_org_id === undefined) await this.freeTier.grantQuietly(payerId);
    // No sessions exist for a just-created account, but the contract is "issue ends every
    // session" and this keeps that true if a retry races a login.
    await this.sessions.revokeAllForPayer(payerId);

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

    await this.sessions.revokeAllForPayer(payerId);
    return { payer_id: payerId, temporary_password: temporaryPassword, must_change_password: true };
  }

  /**
   * POST /admin/payers/:id/password/revoke — close password sign-in. The email-code door stays
   * open, which is what lets the payer recover the account without an admin re-issuing a
   * credential. Idempotent: already revoked → no write, no event, `changed:false`.
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

    if (changed) await this.sessions.revokeAllForPayer(payerId);
    return { payer_id: payerId, changed };
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
