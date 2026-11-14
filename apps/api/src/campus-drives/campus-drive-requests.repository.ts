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
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { DriveCursor } from "./campus-drive-cursor";
import type { DriveRequesterFacts } from "./campus-drive-eligibility";
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

/** A row of Campus's feed: the request and its company's name (ciphertext). */
export interface DriveFeedRow extends DriveRequestRow {
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
export interface LockedForDecision extends DriveRequestRow {
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
 * `audit_logs.actor_type` of a decision: a Campus placement-team member, by reference. The same
 * value as #2746 PR 5's `CAMPUS_STAFF_ACTOR_TYPE` (`campus-posting-review.repository.ts`, not on
 * this branch's base), so both kinds of staff decision filter as one actor.
 */
export const CAMPUS_STAFF_ACTOR_TYPE = "campus_staff";

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
 * and touch no other row lock (the event and audit inserts take none), so the two serialise on that
 * row and cannot deadlock.
 */
@Injectable()
export class CampusDriveRequestsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` in ONE transaction: the row, its event and its audit row commit together. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * The facts the verified-employer rule reads, for the tenant's own `payers` row and its company
   * record (`employer_profiles`, 1:1). No row at all reads as "not an employer, not verified".
   */
  async requesterFacts(
    tenant: TenantKey,
  ): Promise<DriveRequesterFacts & { isTestAccount: boolean }> {
    const rows = await this.db
      .select({
        role: payers.role,
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
      return { role: null, isTestAccount: false, verificationStatus: null, hasGstNumber: false };
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
    const rows = await tx
      .insert(campusDriveRequests)
      .values({ ...row, status: "requested", updatedAt: WRITE_STAMP })
      .onConflictDoNothing({
        target: [campusDriveRequests.payerId, campusDriveRequests.idempotencyKey],
      })
      .returning(ROW_COLUMNS);
    return rows[0];
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
    const rows = await tx
      .select(ROW_COLUMNS)
      .from(campusDriveRequests)
      .where(and(eq(campusDriveRequests.id, id), eq(campusDriveRequests.payerId, tenant)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * The cancel, guarded on the open statuses in the WHERE as well as by the caller's lock. Nothing
   * else moves: the last decision's columns stay as history.
   */
  async markCancelled(tx: Database, id: string): Promise<DriveRequestRow | undefined> {
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
  }

  /**
   * Campus's feed, in change order (`updated_at ASC, id ASC`, served by
   * `campus_drive_requests_changed_idx`), with each company's name as ciphertext. Reads `limit + 1`.
   * Every request is read; which companies Campus may see is the service's (the rollout switch).
   */
  async listFeed(filter: DriveFeedFilter, limit: number): Promise<DriveFeedRow[]> {
    const keyset =
      filter.after === undefined
        ? undefined
        : sql`(${campusDriveRequests.updatedAt}, ${campusDriveRequests.id}) > (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)`;
    return this.db
      .select({ ...ROW_COLUMNS, companyNameEnc: payers.orgNameEnc })
      .from(campusDriveRequests)
      .innerJoin(payers, eq(payers.id, campusDriveRequests.payerId))
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

  /** The request's owning tenant, unlocked: the decision's pre-check before any transaction. */
  async findOwner(id: string): Promise<{ payerId: string } | undefined> {
    const rows = await this.db
      .select({ payerId: campusDriveRequests.payerId })
      .from(campusDriveRequests)
      .where(eq(campusDriveRequests.id, id))
      .limit(1);
    return rows[0];
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
    const rows = await tx
      .select({
        ...ROW_COLUMNS,
        timing: sql<DecisionTiming>`CASE
          WHEN ${campusDriveRequests.decidedAt} IS NULL THEN 'none'
          WHEN ${at} < ${campusDriveRequests.decidedAt} THEN 'older'
          WHEN ${at} = ${campusDriveRequests.decidedAt} THEN 'same'
          ELSE 'newer' END`,
      })
      .from(campusDriveRequests)
      .where(eq(campusDriveRequests.id, id))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /** The decision, on the transaction that locked the row. */
  async writeDecision(
    tx: Database,
    id: string,
    write: DecisionStore,
  ): Promise<DriveRequestRow | undefined> {
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
  }

  /** The decision's `audit_logs` row, on the decision's transaction. Ids, enums and dates only. */
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
