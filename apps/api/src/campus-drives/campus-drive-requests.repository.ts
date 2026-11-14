import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  auditLogs,
  campusDriveRequests,
  employerProfiles,
  jobPostings,
  payers,
  type CampusDriveRequestStatus,
  type Database,
  type PayerProfileVerificationStatus,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import { CAMPUS_STAFF_ACTOR_TYPE } from "../campus-link/campus-posting-review.repository";
import { redactQueryParams } from "../common/db-error";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { DriveCursor } from "./campus-drive-cursor";
import type { DriveCompanyStanding } from "./campus-drive-eligibility";
import type { DecisionTiming, DriveDecisionWrite } from "./campus-drive-transitions";

/** Postgres's microsecond UTC text for a timestamp: a cursor key (a JS `Date` keeps only ms). */
function microsecondText(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * The write stamp. `clock_timestamp()`, not `now()`: `now()` is the transaction's START, so a write
 * that waited on a row lock would be stamped before the wait and could land in Campus's feed behind
 * a row Campus has already passed. The stamp is taken when the statement runs.
 */
const WRITE_STAMP = sql`clock_timestamp()`;

/**
 * Every column a read returns, plus the timestamps as microsecond text (the two cursor keys, and
 * the decision and cancel times Campus reads). The contact leaves as CIPHERTEXT.
 */
const ROW_COLUMNS = {
  id: campusDriveRequests.id,
  payerId: campusDriveRequests.payerId,
  createdBy: campusDriveRequests.createdBy,
  jobPostingId: campusDriveRequests.jobPostingId,
  branchIds: campusDriveRequests.branchIds,
  preferredFrom: campusDriveRequests.preferredFrom,
  preferredTo: campusDriveRequests.preferredTo,
  openings: campusDriveRequests.openings,
  rolesNote: campusDriveRequests.rolesNote,
  contactNameEnc: campusDriveRequests.contactNameEnc,
  contactPhoneEnc: campusDriveRequests.contactPhoneEnc,
  contactErasedAt: campusDriveRequests.contactErasedAt,
  status: campusDriveRequests.status,
  scheduledOn: campusDriveRequests.scheduledOn,
  campusDriveRef: campusDriveRequests.campusDriveRef,
  decidedAt: campusDriveRequests.decidedAt,
  decidedByRef: campusDriveRequests.decidedByRef,
  decisionReason: campusDriveRequests.decisionReason,
  cancelledAt: campusDriveRequests.cancelledAt,
  isTest: campusDriveRequests.isTest,
  idempotencyKey: campusDriveRequests.idempotencyKey,
  createdAt: campusDriveRequests.createdAt,
  updatedAt: campusDriveRequests.updatedAt,
  createdKey: microsecondText(campusDriveRequests.createdAt),
  changedKey: microsecondText(campusDriveRequests.updatedAt),
  decidedKey: microsecondText(campusDriveRequests.decidedAt),
  cancelledKey: microsecondText(campusDriveRequests.cancelledAt),
};

/**
 * The company's standing, read in the SAME statement as the request (`payers` inner-joined,
 * `employer_profiles` left-joined): the create check's facts plus the account status, so Campus's
 * routes judge "withdrawn" (owner ruling R2) on exactly what the create check reads.
 */
const COMPANY_STANDING = {
  companyStatus: payers.status,
  companyRole: payers.role,
  companyVerification: employerProfiles.verificationStatus,
  companyHasGst: sql<boolean>`(${employerProfiles.gstNumberEnc} IS NOT NULL)`,
};

/** The standing columns as a row carries them (`companyVerification` is NULL with no record). */
export interface DriveCompanyColumns {
  companyStatus: PayerStatus;
  companyRole: PayerRole;
  companyVerification: PayerProfileVerificationStatus | null;
  companyHasGst: boolean;
}

/** One request as stored (contact as ciphertext), with its microsecond cursor keys. */
export interface DriveRequestRow {
  id: string;
  payerId: string;
  createdBy: string;
  jobPostingId: string | null;
  branchIds: number[];
  preferredFrom: string;
  preferredTo: string;
  openings: number;
  rolesNote: string | null;
  contactNameEnc: string | null;
  contactPhoneEnc: string | null;
  contactErasedAt: Date | null;
  status: CampusDriveRequestStatus;
  scheduledOn: string | null;
  campusDriveRef: string | null;
  decidedAt: Date | null;
  decidedByRef: string | null;
  decisionReason: string | null;
  cancelledAt: Date | null;
  isTest: boolean;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  /** `created_at`, microsecond UTC text: the company list's cursor key. */
  createdKey: string;
  /** `updated_at`, microsecond UTC text: Campus's `changed_at` and its feed's cursor key. */
  changedKey: string;
  /** `decided_at` / `cancelled_at`, microsecond UTC text; `null` when unset. */
  decidedKey: string | null;
  cancelledKey: string | null;
}

/**
 * A row of Campus's feed: the request, its company's name (ciphertext) and standing, both read
 * live. The item's `changed_at` and the cursor key are the request's own `changedKey`.
 */
export interface DriveFeedRow extends DriveRequestRow, DriveCompanyColumns {
  companyNameEnc: string;
}

/** The columns a create writes. The contact arrives ALREADY ENCRYPTED. */
export interface DriveRequestInsert {
  payerId: TenantKey;
  createdBy: string;
  jobPostingId: string | null;
  branchIds: number[];
  preferredFrom: string;
  preferredTo: string;
  openings: number;
  rolesNote: string | null;
  contactNameEnc: string;
  contactPhoneEnc: string;
  isTest: boolean;
  idempotencyKey: string;
}

/** The row under the decision's lock, with `decided_at` compared to the body's in SQL. */
export interface LockedForDecision extends DriveRequestRow, DriveCompanyColumns {
  timing: DecisionTiming;
}

/** The decision a Campus write stores. */
export interface DecisionStore extends DriveDecisionWrite {
  decidedAt: string;
  decidedByRef: string;
  decisionReason: string | null;
}

/** Campus's feed filter, already validated. */
export interface DriveFeedFilter {
  status?: CampusDriveRequestStatus;
  changedSince?: string;
  after?: DriveCursor;
}

/** The decision's own `audit_logs` row (the guard wrote the per-call row already). */
export interface DecisionAudit {
  driveRequestId: string;
  decidedByRef: string;
  metadata: Record<string, unknown>;
}

/** `audit_logs.action` of a Campus staff decision on a drive request. */
export const CAMPUS_DRIVE_DECISION_AUDIT_ACTION = "campus_link.drive_request_decided";

/**
 * #2746 PR 6 — `campus_drive_requests`. DATABASE ACCESS ONLY: who may ask, the ordering and the
 * transitions are the services' (`CampusDriveRequestsService`, `CampusDriveDecisionsService`).
 *
 * TENANCY IN THE QUERY. Every company read and write carries `payer_id = <tenant key>` in its WHERE
 * (ADR-0053 §5.2), so a foreign or unknown id reads nothing and the caller answers the same 404.
 * The tenant key is the branded `TenantKey` from `PayerTenantScopeService`, never a raw id.
 *
 * NO DECRYPT HERE. The contact and the company name leave as ciphertext for the service, which is
 * the one place that decides who may see them.
 *
 * ONE ROW LOCK. The decision and the company's cancel each take the request row `FOR UPDATE` first
 * (the decision's read joins the company, locking ONLY the request: `FOR UPDATE OF`) and touch no
 * other row lock (the event and audit inserts take none), so the two serialise on that row and
 * cannot deadlock.
 *
 * REDACTED ERRORS (security review M2). Every statement that binds the roles note, the contact
 * ciphertext or the placement team's reason rethrows a database error through `redactQueryParams`,
 * so a failure log carries the SQL text and the code, never the bound values.
 */
@Injectable()
export class CampusDriveRequestsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` in ONE transaction: the row, its event and its audit row commit together. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * The facts the create check reads, for the TENANT's own `payers` row (the org's anchor under
   * tenancy `on`, never the acting login's) and its company record (`employer_profiles`, 1:1):
   * the same four the R2 withdrawn rule reads on Campus's routes (role, account status,
   * verification, GSTIN), so a request is never created withdrawn (migration review L2). No row at
   * all reads as "not an employer, not active, not verified".
   */
  async requesterFacts(
    tenant: TenantKey,
  ): Promise<DriveCompanyStanding & { isTestAccount: boolean }> {
    const rows = await this.db
      .select({
        role: payers.role,
        status: payers.status,
        isTestAccount: payers.isTestAccount,
        verificationStatus: employerProfiles.verificationStatus,
        hasGstNumber: sql<boolean>`(${employerProfiles.gstNumberEnc} IS NOT NULL)`,
      })
      .from(payers)
      .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
      .where(eq(payers.id, tenant))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return {
        role: null,
        status: null,
        isTestAccount: false,
        verificationStatus: null,
        hasGstNumber: false,
      };
    }
    return { ...row, hasGstNumber: row.hasGstNumber === true };
  }

  /** Is `postingId` one of the tenant's own postings? `payer_id` is in the WHERE. */
  async isOwnPosting(tenant: TenantKey, postingId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, postingId), eq(jobPostings.payerId, tenant)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The create, on the caller's transaction. `ON CONFLICT (payer_id, idempotency_key) DO NOTHING`:
   * a key already used by this tenant inserts nothing and returns `undefined` (a concurrent insert
   * under the same key waits for that one to commit first), and the caller reads the row it made.
   */
  async insert(tx: Database, row: DriveRequestInsert): Promise<DriveRequestRow | undefined> {
    try {
      const rows = await tx
        .insert(campusDriveRequests)
        .values({ ...row, status: "requested", updatedAt: WRITE_STAMP })
        .onConflictDoNothing({
          target: [campusDriveRequests.payerId, campusDriveRequests.idempotencyKey],
        })
        .returning(ROW_COLUMNS);
      return rows[0];
    } catch (err) {
      throw redactQueryParams(err, "campus drive request insert");
    }
  }

  /** The tenant's request made under `idempotencyKey`, if any. */
  async findByIdempotencyKey(
    tenant: TenantKey,
    idempotencyKey: string,
  ): Promise<DriveRequestRow | undefined> {
    const rows = await this.db
      .select(ROW_COLUMNS)
      .from(campusDriveRequests)
      .where(
        and(
          eq(campusDriveRequests.payerId, tenant),
          eq(campusDriveRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** One of the tenant's own requests. A foreign or unknown id reads nothing. */
  async findOwn(tenant: TenantKey, id: string): Promise<DriveRequestRow | undefined> {
    const rows = await this.db
      .select(ROW_COLUMNS)
      .from(campusDriveRequests)
      .where(and(eq(campusDriveRequests.id, id), eq(campusDriveRequests.payerId, tenant)))
      .limit(1);
    return rows[0];
  }

  /**
   * The tenant's requests, newest first (`created_at DESC, id DESC`, served by
   * `campus_drive_requests_payer_idx`), after the cursor. Reads `limit + 1` so the caller knows
   * whether another page exists.
   */
  async listOwn(
    tenant: TenantKey,
    after: DriveCursor | undefined,
    limit: number,
  ): Promise<DriveRequestRow[]> {
    const keyset =
      after === undefined
        ? undefined
        : sql`(${campusDriveRequests.createdAt}, ${campusDriveRequests.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`;
    return this.db
      .select(ROW_COLUMNS)
      .from(campusDriveRequests)
      .where(and(eq(campusDriveRequests.payerId, tenant), keyset))
      .orderBy(desc(campusDriveRequests.createdAt), desc(campusDriveRequests.id))
      .limit(limit + 1);
  }

  /** The tenant's request under `SELECT … FOR UPDATE`, on the cancel's transaction. */
  async lockOwn(tx: Database, tenant: TenantKey, id: string): Promise<DriveRequestRow | undefined> {
    try {
      const rows = await tx
        .select(ROW_COLUMNS)
        .from(campusDriveRequests)
        .where(and(eq(campusDriveRequests.id, id), eq(campusDriveRequests.payerId, tenant)))
        .limit(1)
        .for("update");
      return rows[0];
    } catch (err) {
      throw redactQueryParams(err, "campus drive request cancel lock");
    }
  }

  /**
   * The cancel, guarded on the open statuses in the WHERE as well as by the caller's lock. Nothing
   * else moves: the last decision's columns stay as history.
   */
  async markCancelled(tx: Database, id: string): Promise<DriveRequestRow | undefined> {
    try {
      const rows = await tx
        .update(campusDriveRequests)
        .set({ status: "cancelled", cancelledAt: WRITE_STAMP, updatedAt: WRITE_STAMP })
        .where(
          and(
            eq(campusDriveRequests.id, id),
            inArray(campusDriveRequests.status, ["requested", "scheduled"]),
          ),
        )
        .returning(ROW_COLUMNS);
      return rows[0];
    } catch (err) {
      throw redactQueryParams(err, "campus drive request cancel");
    }
  }

  /**
   * Campus's feed: EVERY request (owner ruling R1: no switch filter, so nothing is skipped), in
   * change order (`updated_at` ASC, id ASC: `campus_drive_requests_changed_idx`), with each
   * company's name as ciphertext and its standing, read live. Reads `limit + 1`.
   *
   * The order, filter and cursor read the REQUEST's `updated_at` only (migration review M1). Every
   * writer of a company's standing re-stamps its requests in its own transaction
   * (`restampCompanyDriveRequests`, `campus-drive-feed-stamp.ts`), so a withdrawal or a
   * reinstatement moves the request, on the database's clock, like any request write.
   */
  async listFeed(filter: DriveFeedFilter, limit: number): Promise<DriveFeedRow[]> {
    const keyset =
      filter.after === undefined
        ? undefined
        : sql`(${campusDriveRequests.updatedAt}, ${campusDriveRequests.id}) > (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)`;
    return this.db
      .select({
        ...ROW_COLUMNS,
        ...COMPANY_STANDING,
        companyNameEnc: payers.orgNameEnc,
      })
      .from(campusDriveRequests)
      .innerJoin(payers, eq(payers.id, campusDriveRequests.payerId))
      .leftJoin(employerProfiles, eq(employerProfiles.payerId, campusDriveRequests.payerId))
      .where(
        and(
          filter.status === undefined ? undefined : eq(campusDriveRequests.status, filter.status),
          filter.changedSince === undefined
            ? undefined
            : gte(campusDriveRequests.updatedAt, sql`${filter.changedSince}::timestamptz`),
          keyset,
        ),
      )
      .orderBy(asc(campusDriveRequests.updatedAt), asc(campusDriveRequests.id))
      .limit(limit + 1);
  }

  /**
   * The request under `SELECT … FOR UPDATE`, with the body's `decided_at` compared to the stored one
   * by Postgres (microsecond exact; a JS `Date` keeps only milliseconds).
   */
  async lockForDecision(
    tx: Database,
    id: string,
    decidedAt: string,
  ): Promise<LockedForDecision | undefined> {
    const at = sql`${decidedAt}::timestamptz`;
    try {
      const rows = await tx
        .select({
          ...ROW_COLUMNS,
          ...COMPANY_STANDING,
          timing: sql<DecisionTiming>`CASE
            WHEN ${campusDriveRequests.decidedAt} IS NULL THEN 'none'
            WHEN ${at} < ${campusDriveRequests.decidedAt} THEN 'older'
            WHEN ${at} = ${campusDriveRequests.decidedAt} THEN 'same'
            ELSE 'newer' END`,
        })
        .from(campusDriveRequests)
        .innerJoin(payers, eq(payers.id, campusDriveRequests.payerId))
        .leftJoin(employerProfiles, eq(employerProfiles.payerId, campusDriveRequests.payerId))
        .where(eq(campusDriveRequests.id, id))
        .limit(1)
        .for("update", { of: campusDriveRequests });
      const row = rows[0];
      return row && { ...row, companyHasGst: row.companyHasGst === true };
    } catch (err) {
      throw redactQueryParams(err, "campus drive decision lock");
    }
  }

  /** The decision, on the transaction that locked the row. */
  async writeDecision(
    tx: Database,
    id: string,
    write: DecisionStore,
  ): Promise<DriveRequestRow | undefined> {
    try {
      const rows = await tx
        .update(campusDriveRequests)
        .set({
          status: write.status,
          scheduledOn: write.scheduledOn,
          campusDriveRef: write.campusDriveRef,
          decidedAt: sql`${write.decidedAt}::timestamptz`,
          decidedByRef: write.decidedByRef,
          decisionReason: write.decisionReason,
          updatedAt: WRITE_STAMP,
        })
        .where(
          and(eq(campusDriveRequests.id, id), eq(campusDriveRequests.status, write.previousStatus)),
        )
        .returning(ROW_COLUMNS);
      return rows[0];
    } catch (err) {
      throw redactQueryParams(err, "campus drive decision write");
    }
  }

  /**
   * The decision's `audit_logs` row, on the decision's transaction. Ids, enums and dates only. The
   * actor type is the review's (`CAMPUS_STAFF_ACTOR_TYPE`), so every Campus staff decision filters
   * as one actor.
   */
  async writeDecisionAudit(tx: Database, audit: DecisionAudit): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: CAMPUS_STAFF_ACTOR_TYPE,
      actorId: audit.decidedByRef,
      action: CAMPUS_DRIVE_DECISION_AUDIT_ACTION,
      entityType: "campus_drive_request",
      entityId: audit.driveRequestId,
      metadata: audit.metadata,
    });
  }
}
