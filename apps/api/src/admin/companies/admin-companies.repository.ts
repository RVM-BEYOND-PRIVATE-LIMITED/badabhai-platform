import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agencyProfiles,
  auditLogs,
  employerProfiles,
  payerMembers,
  payerOrgs,
  payers,
  type Database,
  type OrgRole,
  type PayerMemberStatus,
  type PayerProfileVerificationStatus,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import { restampCompanyDriveRequests } from "../../campus-drives/campus-drive-feed-stamp";
import { DATABASE } from "../../database/database.module";

/** The list/detail filter, already resolved to keyed lookups (no plaintext reaches SQL). */
export interface CompanyFilter {
  kind?: PayerRole;
  status?: PayerStatus;
  verification?: PayerProfileVerificationStatus;
  /** Whole-word tokens per key id (ADR-0062 §3.6 rotation: a row matches under its own kid). */
  nameTokens?: ReadonlyArray<{ kid: string; hashes: string[] }>;
  city?: string;
  gstHash?: string;
}

export interface CompanyRow {
  id: string;
  orgId: string | null;
  role: PayerRole;
  status: PayerStatus;
  previousStatus: PayerStatus | null;
  verificationStatus: PayerProfileVerificationStatus;
  cities: unknown;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CompanyMemberRow {
  memberId: string;
  orgId: string;
  payerId: string | null;
  orgRole: OrgRole;
  memberStatus: PayerMemberStatus;
  payerStatus: PayerStatus | null;
  lastLoginAt: Date | null;
  invitedAt: Date;
  acceptedAt: Date | null;
}

/** A profile row with its contact CIPHERTEXT (decrypted only by `AdminIdentityService`). */
export interface CompanyProfileRow {
  website: string | null;
  industry: string | null;
  companySize: string | null;
  hiringLocations: unknown;
  agencyType: string | null;
  operatingCities: unknown;
  recruiterCount: number | null;
  verificationStatus: PayerProfileVerificationStatus;
  updatedAt: Date;
  gstCipher: string | null;
  addressCipher: string | null;
  phoneCipher: string | null;
  emailCipher: string | null;
  contactCipher: string | null;
}

/** The profile columns an admin write may set (already encrypted / hashed by the service). */
export interface CompanyProfileColumns {
  gstNumberEnc?: string | null;
  gstNumberHash?: string | null;
  addressEnc?: string | null;
  companyPhoneEnc?: string | null;
  companyEmailEnc?: string | null;
  contactPersonEnc?: string | null;
  website?: string | null;
  verificationStatus?: PayerProfileVerificationStatus;
  industry?: string | null;
  companySize?: string | null;
  hiringLocations?: string[];
  agencyType?: "placement_agency" | "contractor" | "training_partner" | "consultant" | null;
  operatingCities?: string[];
  recruiterCount?: number | null;
}

/** The org row joined to its ROOT payer (aliased: the team-member subquery reads `payer_orgs` too). */
const companyOrg = alias(payerOrgs, "company_org");
/** A team member's own login row (aliased: the outer row is the company's ROOT payer). */
const memberLogin = alias(payers, "member_login");
/** The org a membership belongs to, inside the "is this login someone's team member" probe. */
const membershipOrg = alias(payerOrgs, "membership_org");

/**
 * #2564 — data access for the admin COMPANY RECORD.
 *
 * A company row is a `payers` row that is NOT an active team member of ANOTHER payer's org:
 * every founder (with their org), every self-serve account, and nothing else. That is what makes
 * the list "one row per organisation" — a recruiter login added to a company, and the orphan
 * solo org self-signup gave them before they joined, both fold under the company they belong to.
 *
 * NO PLAINTEXT AND NO DECRYPT HERE. Filters arrive as keyed hashes/tokens; contact fields leave as
 * CIPHERTEXT for `AdminIdentityService` to gate; the company NAME is read only through the
 * identity layer (this file never names `org_name_enc`).
 */
@Injectable()
export class AdminCompaniesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** The outer row is NOT an active team member of an org it does not found. */
  private notTeamMember(): SQL {
    return notExists(
      this.db
        .select({ one: sql`1` })
        .from(payerMembers)
        .innerJoin(membershipOrg, eq(membershipOrg.id, payerMembers.orgId))
        .where(
          and(
            eq(payerMembers.memberPayerId, payers.id),
            eq(payerMembers.status, "active"),
            ne(membershipOrg.rootPayerId, payers.id),
          ),
        ),
    );
  }

  private where(filter: CompanyFilter): SQL {
    const clauses: SQL[] = [this.notTeamMember()];
    if (filter.kind) clauses.push(eq(payers.role, filter.kind));
    if (filter.status) clauses.push(eq(payers.status, filter.status));
    if (filter.verification) {
      clauses.push(
        sql`coalesce(${employerProfiles.verificationStatus}, ${agencyProfiles.verificationStatus}, 'pending') = ${filter.verification}`,
      );
    }
    if (filter.nameTokens) {
      // Every query word must be one of the row's words, under the row's OWN key id.
      const perKey = filter.nameTokens.map(
        (k) =>
          and(
            eq(payers.orgNameTokenKeyId, k.kid),
            arrayContains(payers.orgNameTokenHashes, k.hashes),
          )!,
      );
      clauses.push(perKey.length === 1 ? perKey[0]! : or(...perKey)!);
    }
    if (filter.city) {
      clauses.push(sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          coalesce(${employerProfiles.hiringLocations}, ${agencyProfiles.operatingCities}, '[]'::jsonb)
        ) AS company_city(name)
        WHERE lower(company_city.name) = lower(${filter.city}::text)
      )`);
    }
    if (filter.gstHash) {
      clauses.push(
        or(
          eq(employerProfiles.gstNumberHash, filter.gstHash),
          eq(agencyProfiles.gstNumberHash, filter.gstHash),
        )!,
      );
    }
    return and(...clauses)!;
  }

  private static readonly projection = {
    id: payers.id,
    orgId: companyOrg.id,
    role: payers.role,
    status: payers.status,
    previousStatus: payers.previousStatus,
    verificationStatus: sql<PayerProfileVerificationStatus>`coalesce(${employerProfiles.verificationStatus}, ${agencyProfiles.verificationStatus}, 'pending')`,
    cities: sql<unknown>`coalesce(${employerProfiles.hiringLocations}, ${agencyProfiles.operatingCities}, '[]'::jsonb)`,
    lastLoginAt: payers.lastLoginAt,
    createdAt: payers.createdAt,
  };

  /** One page of companies plus the filter's total (for numbered pages). */
  async listCompanies(
    filter: CompanyFilter,
    sort: "newest" | "oldest",
    offset: number,
    limit: number,
  ): Promise<{ rows: CompanyRow[]; total: number }> {
    const where = this.where(filter);
    const order =
      sort === "oldest"
        ? [asc(payers.createdAt), asc(payers.id)]
        : [desc(payers.createdAt), desc(payers.id)];
    const [rows, totals] = await Promise.all([
      this.db
        .select(AdminCompaniesRepository.projection)
        .from(payers)
        .leftJoin(companyOrg, eq(companyOrg.rootPayerId, payers.id))
        .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
        .leftJoin(agencyProfiles, eq(agencyProfiles.payerId, payers.id))
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ n: count() })
        .from(payers)
        .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
        .leftJoin(agencyProfiles, eq(agencyProfiles.payerId, payers.id))
        .where(where),
    ]);
    return { rows, total: totals[0]?.n ?? 0 };
  }

  /** One company by its ROOT payer id; undefined when absent OR when the id is a team login. */
  async findCompany(id: string, tx: Database = this.db): Promise<CompanyRow | undefined> {
    const [row] = await tx
      .select(AdminCompaniesRepository.projection)
      .from(payers)
      .leftJoin(companyOrg, eq(companyOrg.rootPayerId, payers.id))
      .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
      .leftJoin(agencyProfiles, eq(agencyProfiles.payerId, payers.id))
      .where(and(eq(payers.id, id), this.notTeamMember()))
      .limit(1);
    return row;
  }

  /** Team logins (invited + active, never the founder, never removed) of the given orgs. */
  async listMembers(orgIds: readonly string[]): Promise<CompanyMemberRow[]> {
    if (orgIds.length === 0) return [];
    return this.db
      .select({
        memberId: payerMembers.id,
        orgId: payerMembers.orgId,
        payerId: payerMembers.memberPayerId,
        orgRole: payerMembers.orgRole,
        memberStatus: payerMembers.status,
        payerStatus: memberLogin.status,
        lastLoginAt: memberLogin.lastLoginAt,
        invitedAt: payerMembers.invitedAt,
        acceptedAt: payerMembers.acceptedAt,
      })
      .from(payerMembers)
      .innerJoin(payerOrgs, eq(payerOrgs.id, payerMembers.orgId))
      .leftJoin(memberLogin, eq(memberLogin.id, payerMembers.memberPayerId))
      .where(
        and(
          inArray(payerMembers.orgId, [...orgIds]),
          ne(payerMembers.status, "removed"),
          or(
            isNull(payerMembers.memberPayerId),
            ne(payerMembers.memberPayerId, payerOrgs.rootPayerId),
          ),
        ),
      )
      .orderBy(asc(payerMembers.invitedAt), asc(payerMembers.id));
  }

  /** The company record for its kind, with contact CIPHERTEXT; undefined when never saved. */
  async findProfile(role: PayerRole, payerId: string): Promise<CompanyProfileRow | undefined> {
    if (role === "employer") {
      const [row] = await this.db
        .select({
          website: employerProfiles.website,
          industry: employerProfiles.industry,
          companySize: employerProfiles.companySize,
          hiringLocations: employerProfiles.hiringLocations,
          agencyType: sql<string | null>`NULL`,
          operatingCities: sql<unknown>`'[]'::jsonb`,
          recruiterCount: sql<number | null>`NULL`,
          verificationStatus: employerProfiles.verificationStatus,
          updatedAt: employerProfiles.updatedAt,
          gstCipher: employerProfiles.gstNumberEnc,
          addressCipher: employerProfiles.addressEnc,
          phoneCipher: employerProfiles.companyPhoneEnc,
          emailCipher: employerProfiles.companyEmailEnc,
          contactCipher: employerProfiles.contactPersonEnc,
        })
        .from(employerProfiles)
        .where(eq(employerProfiles.payerId, payerId))
        .limit(1);
      return row;
    }
    const [row] = await this.db
      .select({
        website: agencyProfiles.website,
        industry: sql<string | null>`NULL`,
        companySize: sql<string | null>`NULL`,
        hiringLocations: sql<unknown>`'[]'::jsonb`,
        agencyType: agencyProfiles.agencyType,
        operatingCities: agencyProfiles.operatingCities,
        recruiterCount: agencyProfiles.recruiterCount,
        verificationStatus: agencyProfiles.verificationStatus,
        updatedAt: agencyProfiles.updatedAt,
        gstCipher: agencyProfiles.gstNumberEnc,
        addressCipher: agencyProfiles.addressEnc,
        phoneCipher: agencyProfiles.companyPhoneEnc,
        emailCipher: agencyProfiles.companyEmailEnc,
        contactCipher: agencyProfiles.contactPersonEnc,
      })
      .from(agencyProfiles)
      .where(eq(agencyProfiles.payerId, payerId))
      .limit(1);
    return row;
  }

  /**
   * Create-or-update the company record for its kind on the caller's transaction. An employer
   * writes `employer_profiles`, an agency `agency_profiles`; the service has already refused the
   * other kind's fields, so every column named here exists on the target table.
   *
   * #2746 PR 6 — an employer write that sets the verification or the GSTIN can withdraw the company
   * from Campus's drive feed or bring it back (owner ruling R2), so it re-stamps the company's drive
   * requests on the same `tx` (`restampCompanyDriveRequests`).
   */
  async upsertProfile(
    role: PayerRole,
    payerId: string,
    columns: CompanyProfileColumns,
    tx: Database,
  ): Promise<void> {
    const now = new Date();
    if (role === "employer") {
      const {
        agencyType: _a,
        operatingCities: _o,
        recruiterCount: _r,
        ...employerColumns
      } = columns;
      await tx
        .insert(employerProfiles)
        .values({ payerId, ...employerColumns, updatedAt: now })
        .onConflictDoUpdate({
          target: employerProfiles.payerId,
          set: { ...employerColumns, updatedAt: now },
        });
      if ("verificationStatus" in employerColumns || "gstNumberEnc" in employerColumns) {
        await restampCompanyDriveRequests(tx, payerId);
      }
      return;
    }
    const { industry: _i, companySize: _c, hiringLocations: _h, ...agencyColumns } = columns;
    await tx
      .insert(agencyProfiles)
      .values({ payerId, ...agencyColumns, updatedAt: now })
      .onConflictDoUpdate({
        target: agencyProfiles.payerId,
        set: { ...agencyColumns, updatedAt: now },
      });
  }

  /**
   * Lock the company's ROOT row for an archive/restore, so two concurrent archive or restore
   * calls serialise and the team list read next cannot change under them.
   */
  async lockRoot(id: string, tx: Database): Promise<{ status: PayerStatus } | undefined> {
    const [row] = await tx
      .select({ status: payers.status })
      .from(payers)
      .where(eq(payers.id, id))
      .for("update")
      .limit(1);
    return row;
  }

  /**
   * #2746 PR 6 (migration re-check F1) — lock EVERY login of an archive or restore, `FOR UPDATE`,
   * in id order, right after {@link lockRoot} and before the first write. So the transaction holds no
   * drive-request row (each login's archive re-stamps them) while it waits on a login's row: a QA
   * delete of a team member takes that login's `payers` row and then the requests it typed, and the
   * two would otherwise lock in opposite orders (40P01). Rows gone already are simply not returned.
   */
  async lockLogins(ids: readonly string[], tx: Database): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(inArray(payers.id, [...ids]))
      .orderBy(asc(payers.id))
      .for("update");
    return rows.map((r) => r.id);
  }

  /**
   * #2746 PR 6 (security re-check L1) — re-stamp the drive requests keyed on `payerId`, as the LAST
   * statement of an archive, restore or company-record transaction, so the `changed_at` Campus sees
   * is taken just before the commit, after the inventory freeze, the events and the audit row.
   */
  async restampDriveRequests(tx: Database, payerId: string): Promise<void> {
    await restampCompanyDriveRequests(tx, payerId);
  }

  /** The company's ACTIVE team logins (linked, not the founder) — the archive cascade's reach. */
  async teamLoginIds(rootPayerId: string, tx: Database): Promise<string[]> {
    const rows = await tx
      .select({ id: payerMembers.memberPayerId })
      .from(payerMembers)
      .innerJoin(payerOrgs, eq(payerOrgs.id, payerMembers.orgId))
      .where(
        and(
          eq(payerOrgs.rootPayerId, rootPayerId),
          eq(payerMembers.status, "active"),
          isNotNull(payerMembers.memberPayerId),
          ne(payerMembers.memberPayerId, rootPayerId),
        ),
      )
      .orderBy(asc(payerMembers.memberPayerId));
    return rows.flatMap((r) => (r.id === null ? [] : [r.id]));
  }

  /**
   * Archive ONE login: `status → archived`, `previous_status ← the status it left` (in-statement,
   * no read-then-write). Guarded on not-already-archived so a retry is a no-op. Returns the status
   * the login left, or undefined when nothing moved. A moved login re-stamps the drive requests
   * keyed on it (#2746 PR 6, owner ruling R2: an archived company is withdrawn from Campus).
   */
  async archiveLogin(
    id: string,
    tx: Database,
  ): Promise<{ id: string; leftStatus: PayerStatus } | undefined> {
    const [row] = await tx
      .update(payers)
      .set({ status: "archived", previousStatus: sql`${payers.status}`, updatedAt: new Date() })
      .where(and(eq(payers.id, id), ne(payers.status, "archived")))
      .returning({ id: payers.id, leftStatus: payers.previousStatus });
    if (!row) return undefined;
    await restampCompanyDriveRequests(tx, row.id);
    return { id: row.id, leftStatus: row.leftStatus ?? "pending" };
  }

  /**
   * Restore ONE login to the status it held before the archive. A NULL `previous_status` cannot
   * occur for a row this archive wrote; it falls back to `pending`, the fail-closed direction
   * (ADR-0037's reinstate rule). `previous_status` is cleared so it only ever describes a
   * CURRENT archive or suspension. A moved login re-stamps the drive requests keyed on it, as the
   * archive does.
   */
  async restoreLogin(
    id: string,
    tx: Database,
  ): Promise<{ id: string; status: PayerStatus } | undefined> {
    const [row] = await tx
      .update(payers)
      .set({
        status: sql`coalesce(${payers.previousStatus}, 'pending')`,
        previousStatus: null,
        updatedAt: new Date(),
      })
      .where(and(eq(payers.id, id), eq(payers.status, "archived")))
      .returning({ id: payers.id, status: payers.status });
    if (row) await restampCompanyDriveRequests(tx, row.id);
    return row;
  }

  /**
   * The written reason, on `audit_logs`, for a company write (target = the ROOT payer). Never
   * evented. `metadata` holds codes, counts and field KEYS only — never a contact value.
   */
  async writeAudit(
    tx: Database,
    input: {
      adminId: string;
      companyId: string;
      action: string;
      reasonCode: string;
      reasonText: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: input.adminId,
      action: input.action,
      entityType: "payer",
      entityId: input.companyId,
      metadata: {
        reason_code: input.reasonCode,
        reason_text: input.reasonText,
        ...(input.metadata ?? {}),
      },
    });
  }
}
