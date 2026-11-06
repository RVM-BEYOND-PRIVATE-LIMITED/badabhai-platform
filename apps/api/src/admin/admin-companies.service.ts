import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { normCompanyName, normGstin, type Database } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import {
  CURRENT_PASSWORD_PEPPER_VERSION,
  generateTemporaryPassword,
} from "../common/password-policy";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { FreeTierService } from "../match/free-tier.service";
import { PayersRepository, type CreatePayerInput } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerSessionService } from "../payers/payer-session.service";
import { PayerSecurityNoticeService } from "../payers/payer-security-notice.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { AdminIdentityService, type AdminIdentityMap } from "./admin-identity.service";
import { AdminCompaniesRepository } from "./admin-companies.repository";
import {
  ADMIN_COMPANIES_IDENTITY_PAGE_MAX,
  type AdminArchiveCompanyDto,
  type AdminArchiveCompanyResponse,
  type AdminCompaniesPage,
  type AdminCompaniesQueryDto,
  type AdminCompanyDetail,
  type AdminCompanyListItem,
  type AdminCompanyMember,
  type AdminCreateCompanyDto,
  type AdminCreateCompanyResponse,
  type AdminRestoreCompanyDto,
  type AdminRestoreCompanyResponse,
  type AdminUpdateCompanyDto,
  type AdminUpdateCompanyResponse,
} from "./admin-companies.dto";

/** The normalized company record both profile tables reduce to (one is always absent). */
interface NormalizedProfile {
  gst: string | null;
  address: string | null;
  city: string | null;
  contactName: string | null;
  website: string | null;
  industry: string | null;
  companySize: string | null;
  hiringLocations: unknown[];
  agencyType: "placement_agency" | "contractor" | "training_partner" | "consultant" | null;
  serviceLocations: unknown[];
  operatingCities: unknown[];
  recruiterCount: number | null;
  sourceChannels: unknown[];
  verificationStatus: "pending" | "verified" | "rejected" | "suspended";
}

/**
 * #2564 B10 — company records for the Admin Portal (Companies tab).
 *
 * One row per ORGANISATION: create (with the first owner login, the #2563
 * temporary-password mechanism), edit, archive, restore, and the org list +
 * detail + team reads. Reads sit on `read_entities`; every WRITE sits on the new
 * `manage_companies` capability (super_admin, ops_admin, support) and carries a
 * written reason (code + text on the `audit_logs` row in the same transaction).
 *
 * ── ATOMICITY ─────────────────────────────────────────────────────────────────
 * Each write commits the system-of-record rows, the audit reason row and the
 * events in ONE Postgres transaction (the Redis session revocation runs after
 * the commit, with the credential/session epoch stamped in the same write so a
 * missed Redis delete still ends old sessions). The #2563 create contract is
 * mirrored verbatim, including the KNOWN BEHAVIOUR: the transaction commits
 * BEFORE the session sweep, so a post-commit failure leaves a known account with
 * an unknown temporary password — recover via re-issue, never re-create (409s).
 *
 * ── ARCHIVE SEMANTICS ─────────────────────────────────────────────────────────
 * Archive freezes EVERY member login (pending|active|suspended → `archived`,
 * stamping the current status as `previous_status` so the chain composes) plus
 * the live inventory (postings open|paused → `archived`, jobs open → `archived`).
 * Restore hands each archived login back to its own previous state and thaws
 * only `archived` inventory — the suspend/reinstate carve-outs are preserved
 * because the two freezes never share a state value. Billing history is
 * untouched: the ledger is never written here.
 */
@Injectable()
export class AdminCompaniesService {
  private readonly logger = new Logger(AdminCompaniesService.name);

  constructor(
    private readonly repo: AdminCompaniesRepository,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly sessions: PayerSessionService,
    private readonly identity: AdminIdentityService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly freeTier: FreeTierService,
    private readonly notice: PayerSecurityNoticeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * GET /admin/companies — one numbered page of organisations.
   *
   * Names ride the identity boundary (gated, budgeted, audited) and are ADDITIVE:
   * without `read_identity` the page is the identical faceless rows. The page is
   * clamped to the identity bound when names resolve, exactly like the entity
   * lists — an over-limit named page would silently charge the whole budget.
   */
  async listCompanies(
    admin: AuthenticatedAdmin,
    dto: AdminCompaniesQueryDto,
    ctx: RequestContext,
  ): Promise<AdminCompaniesPage> {
    const pageSize = this.identity.isPermitted(admin)
      ? Math.min(dto.pageSize, ADMIN_COMPANIES_IDENTITY_PAGE_MAX)
      : dto.pageSize;
    const normSearch = dto.search ? normCompanyName(dto.search) : "";
    const filter = {
      searchWords: normSearch ? this.pii.hashOrgNameWords(normSearch) : [],
      searchCity: dto.search?.trim() ? dto.search.trim() : null,
      searchGstHash: dto.search?.trim() ? this.pii.hashGstin(normGstin(dto.search)) : null,
      kind: dto.kind,
      status: dto.status,
      verification: dto.verification,
      sort: dto.sort,
    };
    const [total, rows] = await Promise.all([
      this.repo.countCompanies(filter),
      this.repo.listCompanies(filter, (dto.page - 1) * pageSize, pageSize + 1),
    ]);
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;

    const anchorIds = page.map((r) => r.anchorPayerId);
    const memberLists = await Promise.all(anchorIds.map((id) => this.memberPayerIds(id)));
    const memberIds = [...new Set(memberLists.flat())];
    const [balances, postingCounts, memberCounts, lastPayments, orgNames] = await Promise.all([
      this.repo.balancesByPayer(memberIds),
      this.repo.postingCountsByPayer(memberIds),
      this.repo.memberCountsByOrg(page.map((r) => r.orgId)),
      this.repo.lastPaymentByPayer(memberIds),
      this.identity.resolve(admin, "payers", anchorIds, null, ctx),
    ]);
    const memberByAnchor = new Map(anchorIds.map((id, i) => [id, memberLists[i]!] as const));

    return {
      items: page.map((r) => {
        const members = memberByAnchor.get(r.anchorPayerId) ?? [r.anchorPayerId];
        const balance = members.reduce((s, id) => s + (balances.get(id) ?? 0), 0);
        const counts = members.reduce(
          (s, id) => {
            const c = postingCounts.get(id);
            return { open: s.open + (c?.open ?? 0), total: s.total + (c?.total ?? 0) };
          },
          { open: 0, total: 0 },
        );
        const last = members
          .map((id) => lastPayments.get(id))
          .filter((d): d is Date => d !== undefined)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        const item: AdminCompanyListItem = {
          org_id: r.orgId,
          anchor_payer_id: r.anchorPayerId,
          kind: r.kind,
          status: r.status,
          verification: r.verification as AdminCompanyListItem["verification"],
          balance,
          open_postings: counts.open,
          total_postings: counts.total,
          last_payment_at: last ?? null,
          member_count: memberCounts.get(r.orgId) ?? members.length,
          created_at: r.anchorCreatedAt,
        };
        if (orgNames) item.org_name = orgNames.get(r.anchorPayerId) ?? null;
        return item;
      }),
      total,
      page: dto.page,
      page_size: pageSize,
    };
  }

  /**
   * GET /admin/companies/:id — the company record. `:id` may be any member login;
   * it resolves to the org anchor. Contact identifiers and profile PII decrypt
   * through the `company_profile` (+ `payers`) identity surfaces (read_identity
   * gate, per-field budget + audit) — without them the response is faceless.
   */
  async getCompany(
    admin: AuthenticatedAdmin,
    payerId: string,
    ctx: RequestContext,
  ): Promise<AdminCompanyDetail> {
    const { anchorPayerId: anchor, orgId } = await this.requireCompany(payerId);
    const [payer, profile, memberIds] = await Promise.all([
      this.payers.findById(anchor),
      this.readProfile(anchor),
      this.memberPayerIds(anchor),
    ]);
    if (!payer) throw new NotFoundException("Company not found");

    const [balances, postingCounts, lastPayments, orgNames, profilePii] = await Promise.all([
      this.repo.balancesByPayer(memberIds),
      this.repo.postingCountsByPayer(memberIds),
      this.repo.lastPaymentByPayer(memberIds),
      this.identity.resolve(admin, "payers", [anchor], anchor, ctx),
      this.identity.resolve(admin, "company_profile", [anchor], anchor, ctx),
    ]);
    const balance = memberIds.reduce((s, id) => s + (balances.get(id) ?? 0), 0);
    const counts = memberIds.reduce(
      (s, id) => {
        const c = postingCounts.get(id);
        return { open: s.open + (c?.open ?? 0), total: s.total + (c?.total ?? 0) };
      },
      { open: 0, total: 0 },
    );
    const last = memberIds
      .map((id) => lastPayments.get(id))
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const members = orgId ? await this.orgs.listMembers(orgId) : [];
    const contact = this.splitProfilePii(anchor, profilePii);

    const detail: AdminCompanyDetail = {
      org_id: orgId ?? anchor,
      anchor_payer_id: anchor,
      kind: payer.role,
      status: payer.status,
      verification: profile.verificationStatus,
      balance,
      open_postings: counts.open,
      total_postings: counts.total,
      last_payment_at: last ?? null,
      member_count: members.length > 0 ? members.length : 1,
      created_at: payer.createdAt,
      email: contact.email,
      phone: contact.phone,
      profile: {
        gst: contact.gst,
        address: contact.address,
        city: profile.city,
        contact_name: contact.contact,
        website: profile.website,
        industry: profile.industry,
        company_size: profile.companySize,
        hiring_locations: profile.hiringLocations,
        agency_type: profile.agencyType,
        service_locations: profile.serviceLocations,
        operating_cities: profile.operatingCities,
        recruiter_count: profile.recruiterCount,
        source_channels: profile.sourceChannels,
        verification_status: profile.verificationStatus,
      },
    };
    if (orgNames) detail.org_name = orgNames.get(anchor) ?? null;
    return detail;
  }

  /**
   * GET /admin/companies/:id/members — every non-removed login in the org, oldest
   * first. Faceless (opaque ids + roles + statuses + timestamps): login identifiers
   * come from the User accounts list (`GET /admin/accounts?org_id=`, the same
   * `read_identity` contract) — this endpoint deliberately does NOT re-disclose them.
   */
  async listMembers(payerId: string): Promise<AdminCompanyMember[]> {
    const { orgId } = await this.requireCompany(payerId);
    // A payer with no org row yet (pre-backfill gap) has no membership rows; the
    // company is its founder alone, shown on the detail without a members page.
    if (!orgId) return [];
    const members = await this.orgs.listMembers(orgId);
    return members.map((m) => ({
      member_id: m.id,
      member_payer_id: m.memberPayerId,
      org_role: m.orgRole,
      status: m.status,
      invited_at: m.invitedAt,
      accepted_at: m.acceptedAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * POST /admin/companies — create a company/agency with its first (owner) login.
   *
   * The account is ACTIVE immediately and the first credential is the #2563
   * temporary password (must-change on first sign-in): an admin just proved the
   * contact, so there is no mailbox round-trip to wait for. The owner path reuses
   * `createOrGet` + `ensureSoloOrg` + the free-tier grant, exactly like self-serve
   * signup and the #2563 create.
   *
   * 409 when the email/phone hash already exists — the accounts list already shows
   * the login, and silently resetting someone's password from a create form would
   * be a destructive surprise.
   */
  async createCompany(
    admin: AuthenticatedAdmin,
    dto: AdminCreateCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminCreateCompanyResponse> {
    const temporaryPassword = generateTemporaryPassword();
    const hash = this.pii.hashPassword(temporaryPassword);
    const loginId = dto.email ?? dto.phone!;
    const role = dto.kind;

    let payerId = "";
    let orgId = "";
    let conflictPayerId: string | null = null;

    try {
      await this.repo.withTransaction(async (tx) => {
        // The login ID must be free on BOTH channels (the #2563 pre-check, verbatim):
        // email has a unique index, phone does not, and `createOrGet` keys on email
        // when both are supplied.
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

        const createInput: CreatePayerInput = {
          role,
          email: dto.email,
          phone: dto.phone,
          orgName: dto.org_name,
        };
        const created = await this.payers.createOrGet(createInput, tx);
        if (!created.created) {
          conflictPayerId = created.id;
          throw new ConflictException("A login with this email or phone already exists");
        }
        payerId = created.id;

        const solo = await this.orgs.ensureSoloOrg(created.id, tx);
        if (!solo) throw new Error("created payer has no org");
        orgId = solo.orgId;

        const activated = await this.payers.activate(created.id, tx);
        if (activated) {
          await this.emitLifecycle(tx, admin.id, created.id, "payer.activated", ctx, {
            payer_id: created.id,
            previous_status: "pending",
            new_status: "active",
          });
        }

        await this.payers.setTemporaryPassword(
          created.id,
          { hash, pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION },
          tx,
        );

        await this.writeProfile(created.id, role, this.profilePatchFromCreate(dto), tx);

        await this.writeAuditReason(tx, {
          adminId: admin.id,
          payerId: created.id,
          action: ADMIN_ACTION_CODES.company_created,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
        });
        await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_created, created.id, ctx);
        await this.events.emit({
          event_name: "payer.created",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: created.id },
          payload: { payer_id: created.id, role, method: "password" } satisfies PayloadInputOf<"payer.created">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.created:${created.id}`,
          tx,
        });
      });
    } catch (err) {
      // The 409 transaction rolled back, so the existence check would leave no trace. Write a
      // SEPARATE, value-free audit row OUTSIDE it: admin id, action and the existing payer id
      // only — the #2563 conflict contract, verbatim.
      if (err instanceof ConflictException && conflictPayerId !== null) {
        await this.repo
          .writeConflictAudit(admin.id, conflictPayerId, ADMIN_ACTION_CODES.company_create_conflict)
          .catch(() => undefined);
      }
      throw err;
    }

    // After commit. The free tier belongs to the owner account, exactly like signup.
    await this.freeTier.grantQuietly(payerId);
    // No sessions exist for a just-created account, but the contract is "issue ends every
    // session" and this keeps that true if a retry races a login. Sweep first (never delayed
    // by mail); the notice is sent in `finally`, so it goes out even when the sweep throws.
    try {
      await this.sessions.revokeAllForPayer(payerId);
    } finally {
      await this.notice.notify(payerId, "setup");
    }

    return {
      org_id: orgId,
      anchor_payer_id: payerId,
      login_id: loginId,
      temporary_password: temporaryPassword,
      must_change_password: true,
    };
  }

  /**
   * PATCH /admin/companies/:id — edit the company record.
   *
   * Diffs the request against the stored row and writes ONLY what changed, in one
   * transaction with the audit row and the events. Emits `payer.profile_updated`
   * with the CHANGED KEYS only (never values), plus the value-free
   * `company_profile_updated` action. An empty diff is a 400, not a no-op write
   * with an audit row — an audit row must always describe a change.
   */
  async updateCompany(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminUpdateCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminUpdateCompanyResponse> {
    const { anchorPayerId: anchor } = await this.requireCompany(payerId);
    const payer = await this.payers.findById(anchor);
    if (!payer) throw new NotFoundException("Company not found");
    const contact = this.payers.decryptContact(payer);
    const profile = await this.readProfile(anchor);

    const changed = this.diffCompany(contact, profile, payer.role, dto);
    if (changed.fields.length === 0) {
      throw new BadRequestException("No effective changes to apply");
    }

    await this.repo.withTransaction(async (tx) => {
      if (changed.payerPatch.orgName !== undefined || changed.payerPatch.phone !== undefined) {
        await this.payers.update(anchor, changed.payerPatch, tx);
      }
      if (changed.email !== undefined) {
        const clash = await this.payers.findByEmail(changed.email);
        if (clash && clash.id !== anchor) {
          throw new ConflictException("A login with this email already exists");
        }
        await this.payers.updateLoginEmail(anchor, changed.email, tx);
      }
      if (changed.profilePatch) {
        await this.writeProfile(anchor, payer.role, changed.profilePatch, tx);
      }
      await this.writeAuditReason(tx, {
        adminId: admin.id,
        payerId: anchor,
        action: ADMIN_ACTION_CODES.company_profile_updated,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_profile_updated, anchor, ctx);
      await this.events.emit({
        event_name: "payer.profile_updated",
        actor: { actor_type: "admin", actor_id: admin.id },
        subject: { subject_type: "payer", subject_id: anchor },
        payload: {
          payer_id: anchor,
          changed_fields: changed.fields,
        } satisfies PayloadInputOf<"payer.profile_updated">,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
    });

    return { target_id: anchor, changed: true, changed_fields: changed.fields };
  }

  /**
   * POST /admin/companies/:id/archive — freeze the whole company.
   *
   * Every member login (pending|active|suspended → `archived`, previous stamped),
   * the live inventory (postings open|paused → `archived`, jobs open →
   * `archived`), the audit rows, and per-login `company_archived` +
   * `payer.archived` + `payer.inventory_archived` events commit in ONE
   * transaction. Session revocation runs after the commit (Redis is not
   * transactional with Postgres). Idempotent: a fully-archived company returns
   * `changed:false` with no write and no event.
   */
  async archiveCompany(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminArchiveCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminArchiveCompanyResponse> {
    const { anchorPayerId: anchor, memberPayerIds } = await this.requireCompany(payerId);
    const statuses = await this.repo.statusesByPayer(memberPayerIds);
    const targets = memberPayerIds.filter((id) => {
      const s = statuses.get(id);
      return s === "pending" || s === "active" || s === "suspended";
    });
    if (targets.length === 0) return { target_id: anchor, changed: false, archived_logins: [], postings_frozen: 0, jobs_frozen: 0 };

    let postings = 0;
    let jobs = 0;
    await this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.archiveLogins(targets, tx);
      for (const row of moved) {
        const previous = row.previousStatus;
        if (previous !== "pending" && previous !== "active" && previous !== "suspended") {
          // The WHERE admits only pending|active|suspended, so a NULL/unknown here
          // means the cascade wrote a state it cannot hand back — fail the whole
          // archive rather than strand the login.
          throw new InternalServerErrorException("Archive stamped an unrestorable status");
        }
        const frozen = await this.repo.archivePostings([row.id], tx);
        const frozenJobs = await this.repo.archiveJobs([row.id], tx);
        // The system-owned agency twins (payer_id NULL) freeze via their source jobs;
        // their count rides the postings leg of this login's inventory event.
        const frozenTwins = await this.repo.archiveTwins(frozenJobs.jobIds, tx);
        postings += frozen.postings + frozenTwins.postings;
        jobs += frozenJobs.jobs;
        await this.writeAuditReason(tx, {
          adminId: admin.id,
          payerId: row.id,
          action: ADMIN_ACTION_CODES.company_archived,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
        });
        await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_archived, row.id, ctx);
        await this.events.emit({
          event_name: "payer.archived",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: row.id },
          payload: {
            payer_id: row.id,
            previous_status: previous,
            new_status: "archived",
          } satisfies PayloadInputOf<"payer.archived">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.archived:${row.id}:${ctx.requestId}`,
          tx,
        });
        await this.events.emit({
          event_name: "payer.inventory_archived",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: row.id },
          payload: {
            payer_id: row.id,
            postings_affected: frozen.postings + frozenTwins.postings,
            jobs_affected: frozenJobs.jobs,
          } satisfies PayloadInputOf<"payer.inventory_archived">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.inventory_archived:${row.id}:${ctx.requestId}`,
          tx,
        });
      }
    });

    for (const id of targets) {
      try {
        await this.sessions.revokeAllForPayer(id);
      } catch (err) {
        this.logger.log(
          `company archived; session revocation FAILED payer=${id.slice(0, 8)}… reason=${err instanceof Error ? err.name : "unknown"}`,
        );
      }
    }
    return { target_id: anchor, changed: true, archived_logins: targets, postings_frozen: postings, jobs_frozen: jobs };
  }

  /**
   * POST /admin/companies/:id/restore — hand every archived login back to its own
   * previous usable state (NULL → `pending`, the fail-closed direction — the
   * reinstate rule, verbatim) and thaw only `archived` inventory. Suspended-for-
   * other-reasons rows never move. No session revocation (sessions are already
   * dead; the guard re-read makes restoration effective without re-login).
   */
  async restoreCompany(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminRestoreCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminRestoreCompanyResponse> {
    const { anchorPayerId: anchor, memberPayerIds } = await this.requireCompany(payerId);
    const statuses = await this.repo.statusesByPayer(memberPayerIds);
    const targets = memberPayerIds.filter((id) => statuses.get(id) === "archived");
    if (targets.length === 0) {
      return { target_id: anchor, changed: false, restored_logins: [], postings_restored: 0, jobs_restored: 0 };
    }

    let postings = 0;
    let jobs = 0;
    await this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.restoreLogins(targets, tx);
      for (const row of moved) {
        if (row.status !== "pending" && row.status !== "active" && row.status !== "suspended") {
          // Restore writes coalesce(previous, 'pending') over archived rows only, so any
          // other landing state means the cascade wrote what it cannot hand back — fail
          // the whole restore rather than strand the login.
          throw new InternalServerErrorException("Restore landed an unrestorable status");
        }
        const thawed = await this.repo.restorePostings([row.id], tx);
        const thawedJobs = await this.repo.restoreJobs([row.id], tx);
        // Thaw the system-owned twins frozen alongside this login's jobs.
        const thawedTwins = await this.repo.restoreTwins(thawedJobs.jobIds, tx);
        postings += thawed.postings + thawedTwins.postings;
        jobs += thawedJobs.jobs;
        await this.writeAuditReason(tx, {
          adminId: admin.id,
          payerId: row.id,
          action: ADMIN_ACTION_CODES.company_restored,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
        });
        await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_restored, row.id, ctx);
        await this.events.emit({
          event_name: "payer.restored",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: row.id },
          payload: {
            payer_id: row.id,
            previous_status: "archived",
            new_status: row.status,
          } satisfies PayloadInputOf<"payer.restored">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.restored:${row.id}:${ctx.requestId}`,
          tx,
        });
        await this.events.emit({
          event_name: "payer.inventory_restored",
          actor: { actor_type: "admin", actor_id: admin.id },
          subject: { subject_type: "payer", subject_id: row.id },
          payload: {
            payer_id: row.id,
            postings_affected: thawed.postings + thawedTwins.postings,
            jobs_affected: thawedJobs.jobs,
          } satisfies PayloadInputOf<"payer.inventory_restored">,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          idempotencyKey: `payer.inventory_restored:${row.id}:${ctx.requestId}`,
          tx,
        });
      }
    });

    return { target_id: anchor, changed: true, restored_logins: targets, postings_restored: postings, jobs_restored: jobs };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Resolve any member login to its org anchor (404 when the payer does not exist). */
  private async requireCompany(
    payerId: string,
  ): Promise<{ anchorPayerId: string; orgId: string | null; memberPayerIds: string[] }> {
    const resolved = await this.repo.resolveCompany(payerId);
    const anchor = await this.payers.findById(resolved.anchorPayerId);
    if (!anchor) throw new NotFoundException("Company not found");
    return resolved;
  }

  /** Active member logins (+ the anchor) whose wallets and postings roll up. */
  private async memberPayerIds(anchorPayerId: string): Promise<string[]> {
    return (await this.repo.resolveCompany(anchorPayerId)).memberPayerIds;
  }

  /** The normalized company record: exactly one of the two 1:1 profile tables. */
  private async readProfile(anchorPayerId: string): Promise<NormalizedProfile> {
    const [employer, agency] = await Promise.all([
      this.repo.findEmployerProfile(anchorPayerId),
      this.repo.findAgencyProfile(anchorPayerId),
    ]);
    const empty: NormalizedProfile = {
      gst: null,
      address: null,
      city: null,
      contactName: null,
      website: null,
      industry: null,
      companySize: null,
      hiringLocations: [],
      agencyType: null,
      serviceLocations: [],
      operatingCities: [],
      recruiterCount: null,
      sourceChannels: [],
      verificationStatus: "pending",
    };
    if (employer) {
      return {
        ...empty,
        ...(employer.gstNumberEnc ? { gst: this.pii.decrypt(employer.gstNumberEnc) } : {}),
        ...(employer.addressEnc ? { address: this.pii.decrypt(employer.addressEnc) } : {}),
        city: employer.city,
        ...(employer.contactNameEnc ? { contactName: this.pii.decrypt(employer.contactNameEnc) } : {}),
        website: employer.website,
        industry: employer.industry,
        companySize: employer.companySize,
        hiringLocations: (employer.hiringLocations ?? []) as unknown[],
        verificationStatus: employer.verificationStatus,
      };
    }
    if (agency) {
      return {
        ...empty,
        ...(agency.gstNumberEnc ? { gst: this.pii.decrypt(agency.gstNumberEnc) } : {}),
        ...(agency.addressEnc ? { address: this.pii.decrypt(agency.addressEnc) } : {}),
        city: agency.city,
        ...(agency.contactNameEnc ? { contactName: this.pii.decrypt(agency.contactNameEnc) } : {}),
        website: agency.website,
        agencyType: agency.agencyType,
        serviceLocations: (agency.serviceLocations ?? []) as unknown[],
        operatingCities: (agency.operatingCities ?? []) as unknown[],
        recruiterCount: agency.recruiterCount,
        sourceChannels: (agency.sourceChannels ?? []) as unknown[],
        verificationStatus: agency.verificationStatus,
      };
    }
    return empty;
  }

  /**
   * Split the `company_profile` identity map back into per-field plaintext.
   * Missing map (no `read_identity`) or missing key = undisclosed = null; an
   * ABSENT key on a present map would be a different fact, so the split is exact.
   */
  private splitProfilePii(
    anchorPayerId: string,
    resolved: AdminIdentityMap | null,
  ): { gst: string | null; address: string | null; contact: string | null; email: string | null; phone: string | null } {
    const none = { gst: null, address: null, contact: null, email: null, phone: null };
    if (!resolved) return none;
    const at = (field: string): string | null => {
      const key = `${anchorPayerId}:${field}`;
      return resolved.has(key) ? (resolved.get(key) ?? null) : null;
    };
    return { gst: at("gst"), address: at("address"), contact: at("contact"), email: at("email"), phone: at("phone") };
  }

  /** The create DTO's profile slice, for the initial profile write. */
  private profilePatchFromCreate(
    dto: AdminCreateCompanyDto,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (dto.gst !== undefined) {
      patch.gstNumberEnc = this.pii.encrypt(dto.gst);
      patch.gstNumberHash = this.pii.hashGstin(normGstin(dto.gst));
    }
    if (dto.address !== undefined) patch.addressEnc = this.pii.encrypt(dto.address);
    if (dto.contact_name !== undefined) patch.contactNameEnc = this.pii.encrypt(dto.contact_name);
    if (dto.city !== undefined) patch.city = dto.city;
    if (dto.website !== undefined) patch.website = dto.website;
    if (dto.verification !== undefined) patch.verificationStatus = dto.verification;
    if (dto.kind === "employer") {
      if (dto.industry !== undefined) patch.industry = dto.industry;
      if (dto.company_size !== undefined) patch.companySize = dto.company_size;
      if (dto.hiring_locations !== undefined) patch.hiringLocations = dto.hiring_locations;
    } else {
      if (dto.agency_type !== undefined) patch.agencyType = dto.agency_type;
      if (dto.service_locations !== undefined) patch.serviceLocations = dto.service_locations;
      if (dto.operating_cities !== undefined) patch.operatingCities = dto.operating_cities;
      if (dto.recruiter_count !== undefined) patch.recruiterCount = dto.recruiter_count;
      if (dto.source_channels !== undefined) patch.sourceChannels = dto.source_channels;
    }
    return patch;
  }

  /** Write the profile extension for the company's kind (upsert on the 1:1 PK). */
  private async writeProfile(
    anchorPayerId: string,
    kind: "employer" | "agent",
    patch: Record<string, unknown>,
    tx: Database,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    if (kind === "employer") {
      await this.repo.upsertEmployerProfile(anchorPayerId, patch, tx);
    } else {
      await this.repo.upsertAgencyProfile(anchorPayerId, patch, tx);
    }
  }

  /**
   * Diff the edit request against the stored record. Returns the changed KEYS (in
   * the canonical vocabulary order), the payers-row patch, the optional email
   * change, and the profile patch. Contact PII is DECRYPTED here for comparison
   * only — never logged, and only keys leave on the event.
   */
  private diffCompany(
    contact: { orgName: string; email: string | null; phone: string | null },
    profile: NormalizedProfile,
    kind: "employer" | "agent",
    dto: AdminUpdateCompanyDto,
  ): {
    fields: Array<
      | "org_name"
      | "phone"
      | "email"
      | "gst"
      | "address"
      | "city"
      | "website"
      | "industry"
      | "company_size"
      | "hiring_locations"
      | "contact_name"
      | "agency_type"
      | "service_locations"
      | "operating_cities"
      | "recruiter_count"
      | "source_channels"
      | "verification_status"
    >;
    payerPatch: { orgName?: string; phone?: string };
    email?: string;
    profilePatch: Record<string, unknown>;
  } {
    const fields: Array<
      | "org_name"
      | "phone"
      | "email"
      | "gst"
      | "address"
      | "city"
      | "website"
      | "industry"
      | "company_size"
      | "hiring_locations"
      | "contact_name"
      | "agency_type"
      | "service_locations"
      | "operating_cities"
      | "recruiter_count"
      | "source_channels"
      | "verification_status"
    > = [];
    const payerPatch: { orgName?: string; phone?: string } = {};
    let email: string | undefined;
    const profilePatch: Record<string, unknown> = {};
    const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

    if (dto.org_name !== undefined && dto.org_name !== contact.orgName) {
      fields.push("org_name");
      payerPatch.orgName = dto.org_name;
    }
    if (dto.phone !== undefined && dto.phone !== contact.phone) {
      fields.push("phone");
      payerPatch.phone = dto.phone;
    }
    if (dto.email !== undefined && dto.email !== (contact.email ?? null)) {
      fields.push("email");
      email = dto.email;
    }
    if (dto.gst !== undefined && normGstin(dto.gst) !== (profile.gst ? normGstin(profile.gst) : null)) {
      fields.push("gst");
      profilePatch.gstNumberEnc = this.pii.encrypt(dto.gst);
      profilePatch.gstNumberHash = this.pii.hashGstin(normGstin(dto.gst));
    }
    if (dto.address !== undefined && dto.address !== profile.address) {
      fields.push("address");
      profilePatch.addressEnc = this.pii.encrypt(dto.address);
    }
    if (dto.city !== undefined && dto.city !== profile.city) {
      fields.push("city");
      profilePatch.city = dto.city;
    }
    if (dto.website !== undefined && dto.website !== profile.website) {
      fields.push("website");
      profilePatch.website = dto.website;
    }
    if (dto.contact_name !== undefined && dto.contact_name !== profile.contactName) {
      fields.push("contact_name");
      profilePatch.contactNameEnc = this.pii.encrypt(dto.contact_name);
    }
    if (kind === "employer") {
      if (dto.industry !== undefined && dto.industry !== profile.industry) {
        fields.push("industry");
        profilePatch.industry = dto.industry;
      }
      if (dto.company_size !== undefined && dto.company_size !== profile.companySize) {
        fields.push("company_size");
        profilePatch.companySize = dto.company_size;
      }
      if (dto.hiring_locations !== undefined && !sameJson(dto.hiring_locations, profile.hiringLocations)) {
        fields.push("hiring_locations");
        profilePatch.hiringLocations = dto.hiring_locations;
      }
    } else {
      if (dto.agency_type !== undefined && dto.agency_type !== profile.agencyType) {
        fields.push("agency_type");
        profilePatch.agencyType = dto.agency_type;
      }
      if (dto.service_locations !== undefined && !sameJson(dto.service_locations, profile.serviceLocations)) {
        fields.push("service_locations");
        profilePatch.serviceLocations = dto.service_locations;
      }
      if (dto.operating_cities !== undefined && !sameJson(dto.operating_cities, profile.operatingCities)) {
        fields.push("operating_cities");
        profilePatch.operatingCities = dto.operating_cities;
      }
      if (dto.recruiter_count !== undefined && dto.recruiter_count !== profile.recruiterCount) {
        fields.push("recruiter_count");
        profilePatch.recruiterCount = dto.recruiter_count;
      }
      if (dto.source_channels !== undefined && !sameJson(dto.source_channels, profile.sourceChannels)) {
        fields.push("source_channels");
        profilePatch.sourceChannels = dto.source_channels;
      }
    }
    if (dto.verification !== undefined && dto.verification !== profile.verificationStatus) {
      fields.push("verification_status");
      profilePatch.verificationStatus = dto.verification;
    }
    return { fields, payerPatch, email, profilePatch };
  }

  /** The written reason for a company write — same contract as the #2563 login writes. */
  private async writeAuditReason(
    tx: Database,
    input: {
      adminId: string;
      payerId: string;
      action: string;
      reasonCode: string;
      reasonText: string;
    },
  ): Promise<void> {
    await this.repo.writeAuditReason(tx, input);
  }

  /** One value-free `admin.action_performed` on the caller's transaction. */
  private async emitAction(
    tx: Database,
    adminId: string,
    actionCode: (typeof ADMIN_ACTION_CODES)[keyof typeof ADMIN_ACTION_CODES],
    payerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emit({
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

  /** One PII-free `payer.activated` on the caller's transaction (create path only). */
  private async emitLifecycle(
    tx: Database,
    adminId: string,
    payerId: string,
    eventName: "payer.activated",
    ctx: RequestContext,
    payload: PayloadInputOf<"payer.activated">,
  ): Promise<void> {
    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `${eventName}:${payerId}:${ctx.requestId}`,
      tx,
    });
  }
}