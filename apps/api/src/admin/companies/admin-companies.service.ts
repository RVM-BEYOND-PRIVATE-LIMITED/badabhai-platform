import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { CompanyChangedField, PayloadInputOf } from "@badabhai/event-schema";
import type { Database, PayerRole } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { EventsService } from "../../events/events.service";
import { PayersRepository } from "../../payers/payers.repository";
import { PayerOrgsRepository } from "../../payers/payer-orgs.repository";
import { PayerSessionService } from "../../payers/payer-session.service";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin-action-codes";
import { AdminActionsRepository } from "../admin-actions.repository";
import { AdminIdentityService } from "../admin-identity.service";
import { AdminPayerLoginsService } from "../admin-payer-logins.service";
import { NameTokenService } from "../candidate-index/name-token.service";
import {
  AdminCompaniesRepository,
  type CompanyFilter,
  type CompanyMemberRow,
  type CompanyProfileColumns,
  type CompanyRow,
} from "./admin-companies.repository";
import {
  AGENCY_ONLY_FIELDS,
  EMPLOYER_ONLY_FIELDS,
  type AdminCompaniesPage,
  type AdminCompaniesQueryDto,
  type AdminCompanyChanges,
  type AdminCompanyDetail,
  type AdminCompanyListItem,
  type AdminCompanyMember,
  type AdminCompanyReasonDto,
  type AdminCompanyWriteResult,
  type AdminCreateCompanyDto,
  type AdminCreateCompanyResponse,
  type AdminUpdateCompanyDto,
} from "./admin-companies.dto";

/**
 * #2564 (B10) — the admin COMPANY RECORD.
 *
 * Reads (list, detail) sit on the `read_entities` floor. The company NAME rides the existing
 * `payers` identity surface and the contact fields the `company_profiles` surface — both behind
 * `read_identity`, the per-admin budget and audit-before-decrypt in `AdminIdentityService`.
 *
 * Writes (`manage_companies`) each commit, in ONE transaction: the system-of-record change, an
 * `audit_logs` row with the written reason, EXACTLY ONE `admin.action_performed`, and the domain
 * event(s) — actor = the session admin.
 *
 * CREATE reuses #2563's `createLogin` (the company's first login is created exactly as today).
 * ARCHIVE is the ADR-0037 suspension cascade applied to EVERY login of the organisation — the
 * founder and each active team member — plus `status = archived` and `previous_status`; RESTORE
 * returns each login to its `previous_status`. Nothing is ever hard-deleted.
 */
@Injectable()
export class AdminCompaniesService {
  private readonly logger = new Logger(AdminCompaniesService.name);

  constructor(
    private readonly repo: AdminCompaniesRepository,
    private readonly actions: AdminActionsRepository,
    private readonly payerLogins: AdminPayerLoginsService,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly identity: AdminIdentityService,
    private readonly nameTokens: NameTokenService,
    private readonly sessions: PayerSessionService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  // ----- reads -----------------------------------------------------------------

  /**
   * GET /admin/companies — one row per ORGANISATION, its team logins nested. Numbered pages.
   *
   * Name search is whole-word exact through keyed tokens. With the token keys unset it is
   * UNAVAILABLE: a `name` filter is refused with 503 (never a silently empty page), and every
   * other filter still works.
   */
  async listCompanies(
    admin: AuthenticatedAdmin,
    dto: AdminCompaniesQueryDto,
    ctx: RequestContext,
  ): Promise<AdminCompaniesPage> {
    const nameSearchAvailable = this.nameTokens.keyring() !== null;
    const filter: CompanyFilter = {
      kind: dto.kind,
      status: dto.status,
      verification: dto.verification,
      city: dto.city,
      gstHash: dto.gst === undefined ? undefined : this.pii.hashGstin(dto.gst),
    };
    if (dto.name !== undefined) {
      const tokens = this.nameTokens.queryTokens(dto.name, "company");
      if (!tokens.available) {
        throw new ServiceUnavailableException("Company name search is unavailable");
      }
      if (tokens.perKey.every((k) => k.hashes.length === 0)) {
        throw new BadRequestException("Search by a name word of at least two letters");
      }
      filter.nameTokens = tokens.perKey.filter((k) => k.hashes.length > 0);
    }

    const { rows, total } = await this.repo.listCompanies(
      filter,
      dto.sort,
      (dto.page - 1) * dto.page_size,
      dto.page_size,
    );
    const members = await this.repo.listMembers(
      rows.flatMap((r) => (r.orgId === null ? [] : [r.orgId])),
    );
    const names = await this.identity.resolve(
      admin,
      "payers",
      rows.map((r) => r.id),
      null,
      ctx,
    );
    return {
      items: rows.map((row) => AdminCompaniesService.listItem(row, members, names)),
      page: dto.page,
      page_size: dto.page_size,
      total,
      total_pages: Math.ceil(total / dto.page_size),
      name_search_available: nameSearchAvailable,
    };
  }

  /** GET /admin/companies/:id — the company, its team, its record, and (when permitted) contact PII. */
  async getCompany(
    admin: AuthenticatedAdmin,
    id: string,
    ctx: RequestContext,
  ): Promise<AdminCompanyDetail> {
    const row = await this.repo.findCompany(id);
    if (!row) throw new NotFoundException("Company not found");
    const members = await this.repo.listMembers(row.orgId === null ? [] : [row.orgId]);
    const profile = await this.repo.findProfile(row.role, id);
    const names = await this.identity.resolve(admin, "payers", [id], id, ctx);
    const contact = await this.identity.discloseCompanyProfile(
      admin,
      id,
      {
        gst_number: profile?.gstCipher ?? null,
        address: profile?.addressCipher ?? null,
        phone: profile?.phoneCipher ?? null,
        email: profile?.emailCipher ?? null,
        contact_person: profile?.contactCipher ?? null,
      },
      ctx,
    );

    const detail: AdminCompanyDetail = {
      ...AdminCompaniesService.listItem(row, members, names),
      has_profile: profile !== undefined,
      website: profile?.website ?? null,
      industry: profile?.industry ?? null,
      company_size: profile?.companySize ?? null,
      hiring_locations: AdminCompaniesService.strings(profile?.hiringLocations),
      agency_type: profile?.agencyType ?? null,
      operating_cities: AdminCompaniesService.strings(profile?.operatingCities),
      recruiter_count: profile?.recruiterCount ?? null,
      profile_updated_at: profile?.updatedAt ?? null,
    };
    if (contact !== null) detail.contact = contact;
    return detail;
  }

  // ----- writes ----------------------------------------------------------------

  /**
   * POST /admin/companies — a company or agency AND its first login. The login half is #2563's
   * `createLogin`, reused unchanged (same 409s, activation, temporary password, audit, events);
   * this service adds the company record, its own audit reason and `admin.action_performed`
   * INSIDE that transaction through the create hook, so either everything exists or nothing does.
   */
  async createCompany(
    admin: AuthenticatedAdmin,
    dto: AdminCreateCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminCreateCompanyResponse> {
    const profile = dto.profile ?? {};
    AdminCompaniesService.assertKindFields(dto.kind, profile);
    const profileFields = Object.keys(profile) as CompanyChangedField[];

    const login = await this.payerLogins.createLogin(
      admin,
      {
        email: dto.email,
        phone: dto.phone,
        role: dto.kind,
        org_name: dto.org_name,
        reason_code: "login_created",
        reason_text: dto.reason_text,
      },
      ctx,
      {
        withinTransaction: async (tx, companyId) => {
          if (profileFields.length > 0) {
            await this.repo.upsertProfile(dto.kind, companyId, this.profileColumns(profile), tx);
          }
          await this.repo.writeAudit(tx, {
            adminId: admin.id,
            companyId,
            action: ADMIN_ACTION_CODES.company_created,
            reasonCode: dto.reason_code,
            reasonText: dto.reason_text,
            metadata: { kind: dto.kind, profile_fields: profileFields },
          });
          await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_created, companyId, ctx);
        },
      },
    );
    return { company_id: login.payer_id, login };
  }

  /**
   * PATCH /admin/companies/:id — edit the name and/or the company record. `payer.company_updated`
   * records the changed field KEYS (never a value). An archived company is read-only until
   * restored: editing a company that is off the platform would change a record nobody can use.
   */
  async updateCompany(
    admin: AuthenticatedAdmin,
    id: string,
    dto: AdminUpdateCompanyDto,
    ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    const company = await this.repo.findCompany(id);
    if (!company) throw new NotFoundException("Company not found");
    if (company.status === "archived") {
      throw new ConflictException("Company is archived; restore it before editing");
    }
    AdminCompaniesService.assertKindFields(company.role, dto.changes);
    const changedFields = Object.keys(dto.changes) as CompanyChangedField[];
    const { org_name: orgName, ...profileChanges } = dto.changes;

    await this.repo.withTransaction(async (tx) => {
      if (orgName !== undefined) {
        // The rename goes through the ONE writer of `payers.org_name_enc`, so its login lookup
        // hash and search tokens move in the same statement; the org row's copy follows.
        await this.payers.update(id, { orgName }, tx);
        await this.orgs.syncNameFromRoot(id, tx);
      }
      if (Object.keys(profileChanges).length > 0) {
        await this.repo.upsertProfile(company.role, id, this.profileColumns(profileChanges), tx);
      }
      await this.repo.writeAudit(tx, {
        adminId: admin.id,
        companyId: id,
        action: ADMIN_ACTION_CODES.company_updated,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { changed_fields: changedFields },
      });
      await this.emitDomain(
        tx,
        "payer.company_updated",
        id,
        { payer_id: id, changed_fields: changedFields },
        admin.id,
        ctx,
      );
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_updated, id, ctx);
      if ("verification_status" in profileChanges || "gst_number" in profileChanges) {
        // #2746 PR 6 (security re-check L1) — LAST statement before the commit: re-stamp the
        // company's drive requests so the changed_at Campus sees is taken after everything above
        // (Campus re-reads a two-minute window behind its last changed_at).
        await this.repo.restampDriveRequests(tx, id);
      }
    });
    return { company_id: id, changed: true };
  }

  /**
   * POST /admin/companies/:id/archive — take the WHOLE organisation off the platform.
   *
   * For the founder and every active team login: `status = archived` with `previous_status`
   * recorded, then the ADR-0037 inventory freeze keyed on that login (with org tenancy off a
   * member's postings carry the member's own id, so freezing the founder alone would leave them
   * live). Every login's sessions are revoked after commit. A login already `suspended` records
   * `suspended` as its previous status, so restore brings it back suspended — an admin's
   * suspension is not lifted by an archive round-trip.
   */
  async archiveCompany(
    admin: AuthenticatedAdmin,
    id: string,
    dto: AdminCompanyReasonDto,
    ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    const company = await this.repo.findCompany(id);
    if (!company) throw new NotFoundException("Company not found");
    if (company.status === "archived") return { company_id: id, changed: false };

    const archived: string[] = [];
    await this.repo.withTransaction(async (tx) => {
      const locked = await this.repo.lockRoot(id, tx);
      if (!locked || locked.status === "archived") return;
      const logins = [id, ...(await this.repo.teamLoginIds(id, tx))];
      // #2746 PR 6 (migration re-check F1) — every login's row, in id order, before any write.
      await this.repo.lockLogins(logins, tx);
      for (const payerId of logins) {
        const moved = await this.repo.archiveLogin(payerId, tx);
        if (!moved) continue;
        archived.push(payerId);
        await this.emitDomain(
          tx,
          "payer.archived",
          payerId,
          { payer_id: payerId, previous_status: moved.leftStatus, new_status: "archived" },
          admin.id,
          ctx,
        );
        const inventory = await this.actions.suspendPayerInventory(payerId, tx);
        await this.emitDomain(
          tx,
          "payer.inventory_suspended",
          payerId,
          {
            payer_id: payerId,
            postings_affected: inventory.postings,
            jobs_affected: inventory.jobs,
          },
          admin.id,
          ctx,
        );
      }
      await this.repo.writeAudit(tx, {
        adminId: admin.id,
        companyId: id,
        action: ADMIN_ACTION_CODES.company_archived,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { logins_archived: archived.length, previous_status: company.status },
      });
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_archived, id, ctx);
      // #2746 PR 6 (security re-check L1) — LAST statement before the commit: re-stamp the
      // company's drive requests so the changed_at Campus sees is taken after everything above
      // (Campus re-reads a two-minute window behind its last changed_at).
      for (const payerId of archived) await this.repo.restampDriveRequests(tx, payerId);
    });

    if (archived.length === 0) return { company_id: id, changed: false };
    await this.revokeSessions(archived);
    return { company_id: id, changed: true };
  }

  /**
   * POST /admin/companies/:id/restore — return every archived login of the organisation to its
   * `previous_status`. Inventory is un-frozen only for a login that comes back USABLE: a login
   * that was suspended before the archive returns suspended with its postings still frozen.
   * Signing in again still needs the login's own credential (sessions were ended on archive).
   */
  async restoreCompany(
    admin: AuthenticatedAdmin,
    id: string,
    dto: AdminCompanyReasonDto,
    ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    const company = await this.repo.findCompany(id);
    if (!company) throw new NotFoundException("Company not found");
    if (company.status !== "archived") return { company_id: id, changed: false };

    const restored: string[] = [];
    await this.repo.withTransaction(async (tx) => {
      const locked = await this.repo.lockRoot(id, tx);
      if (!locked || locked.status !== "archived") return;
      const logins = [id, ...(await this.repo.teamLoginIds(id, tx))];
      // #2746 PR 6 (migration re-check F1) — every login's row, in id order, before any write.
      await this.repo.lockLogins(logins, tx);
      for (const payerId of logins) {
        const moved = await this.repo.restoreLogin(payerId, tx);
        if (!moved) continue;
        restored.push(payerId);
        await this.emitDomain(
          tx,
          "payer.restored",
          payerId,
          { payer_id: payerId, previous_status: "archived", new_status: moved.status },
          admin.id,
          ctx,
        );
        if (moved.status !== "suspended") {
          const inventory = await this.actions.reinstatePayerInventory(payerId, tx);
          await this.emitDomain(
            tx,
            "payer.inventory_reinstated",
            payerId,
            {
              payer_id: payerId,
              postings_affected: inventory.postings,
              jobs_affected: inventory.jobs,
            },
            admin.id,
            ctx,
          );
        }
      }
      await this.repo.writeAudit(tx, {
        adminId: admin.id,
        companyId: id,
        action: ADMIN_ACTION_CODES.company_restored,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { logins_restored: restored.length },
      });
      await this.emitAction(tx, admin.id, ADMIN_ACTION_CODES.company_restored, id, ctx);
      // #2746 PR 6 (security re-check L1) — LAST statement before the commit: re-stamp the
      // company's drive requests so the changed_at Campus sees is taken after everything above
      // (Campus re-reads a two-minute window behind its last changed_at).
      for (const payerId of restored) await this.repo.restampDriveRequests(tx, payerId);
    });
    return { company_id: id, changed: restored.length > 0 };
  }

  // ----- helpers ---------------------------------------------------------------

  /** An employer's record has no agency columns and vice versa: refuse the other kind's fields. */
  private static assertKindFields(kind: PayerRole, fields: Partial<AdminCompanyChanges>): void {
    const foreign: readonly string[] =
      kind === "employer" ? AGENCY_ONLY_FIELDS : EMPLOYER_ONLY_FIELDS;
    const wrong = Object.keys(fields).filter((k) => foreign.includes(k));
    if (wrong.length > 0) {
      throw new BadRequestException(
        `${wrong.join(", ")} cannot be set on ${kind === "employer" ? "a company" : "an agency"}`,
      );
    }
  }

  /**
   * Map the contract's fields onto profile columns: contact PII is ENCRYPTED here (never stored
   * as plaintext), the GSTIN also gets its keyed lookup hash, and `null` clears.
   */
  private profileColumns(
    fields: Omit<Partial<AdminCompanyChanges>, "org_name">,
  ): CompanyProfileColumns {
    const enc = (v: string | null | undefined): string | null | undefined =>
      v === undefined ? undefined : v === null ? null : this.pii.encrypt(v);
    const out: CompanyProfileColumns = {};
    if (fields.gst_number !== undefined) {
      out.gstNumberEnc = enc(fields.gst_number);
      out.gstNumberHash = fields.gst_number === null ? null : this.pii.hashGstin(fields.gst_number);
    }
    if (fields.address !== undefined) out.addressEnc = enc(fields.address);
    if (fields.phone !== undefined) out.companyPhoneEnc = enc(fields.phone);
    if (fields.email !== undefined) out.companyEmailEnc = enc(fields.email);
    if (fields.contact_person !== undefined) out.contactPersonEnc = enc(fields.contact_person);
    if (fields.website !== undefined) out.website = fields.website;
    if (fields.verification_status !== undefined)
      out.verificationStatus = fields.verification_status;
    if (fields.industry !== undefined) out.industry = fields.industry;
    if (fields.company_size !== undefined) out.companySize = fields.company_size;
    if (fields.hiring_locations !== undefined) out.hiringLocations = [...fields.hiring_locations];
    if (fields.agency_type !== undefined) out.agencyType = fields.agency_type;
    if (fields.operating_cities !== undefined) out.operatingCities = [...fields.operating_cities];
    if (fields.recruiter_count !== undefined) out.recruiterCount = fields.recruiter_count;
    return out;
  }

  private static strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  }

  private static listItem(
    row: CompanyRow,
    members: readonly CompanyMemberRow[],
    names: ReadonlyMap<string, string | null> | null,
  ): AdminCompanyListItem {
    const team: AdminCompanyMember[] = members
      .filter((m) => row.orgId !== null && m.orgId === row.orgId)
      .map((m) => ({
        member_id: m.memberId,
        payer_id: m.payerId,
        org_role: m.orgRole,
        member_status: m.memberStatus,
        payer_status: m.payerStatus,
        last_login_at: m.lastLoginAt,
        invited_at: m.invitedAt,
        accepted_at: m.acceptedAt,
      }));
    const item: AdminCompanyListItem = {
      id: row.id,
      org_id: row.orgId,
      kind: row.role,
      status: row.status,
      previous_status: row.previousStatus,
      verification_status: row.verificationStatus,
      cities: AdminCompaniesService.strings(row.cities),
      member_count: team.length,
      members: team,
      last_login_at: row.lastLoginAt,
      created_at: row.createdAt,
    };
    if (names !== null) item.org_name = names.get(row.id) ?? null;
    return item;
  }

  /**
   * End every session of each archived login. AFTER the commit and best-effort, exactly like the
   * ADR-0037 suspension: enforcement does not depend on it — `PayerAuthGuard` reads the CURRENT
   * status on every request and admits `active` only — so a Redis failure is logged loudly
   * rather than reporting an archive that DID happen as failed.
   */
  private async revokeSessions(payerIds: readonly string[]): Promise<void> {
    for (const payerId of payerIds) {
      try {
        await this.sessions.revokeAllForPayer(payerId);
      } catch (err) {
        this.logger.error(
          `company archive: session sweep failed for payer=${payerId.slice(0, 8)}… ` +
            `(${err instanceof Error ? err.name : "unknown"}); the guard still refuses it`,
        );
      }
    }
  }

  private emitDomain<
    N extends
      | "payer.archived"
      | "payer.restored"
      | "payer.inventory_suspended"
      | "payer.inventory_reinstated"
      | "payer.company_updated",
  >(
    tx: Database,
    eventName: N,
    payerId: string,
    payload: PayloadInputOf<N>,
    adminId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
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

  private emitAction(
    tx: Database,
    adminId: string,
    actionCode: AdminActionCode,
    companyId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: "payer",
      target_id: companyId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: companyId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${companyId}:${ctx.requestId}`,
      tx,
    });
  }
}
