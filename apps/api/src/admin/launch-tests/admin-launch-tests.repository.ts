import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  instituteCompanies,
  launchTestCohort as t,
  launchTestShares,
  paymentOrders,
  payers,
  workers,
  type Database,
} from "@badabhai/db";
import type { LaunchTestResult, UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";
import { DATABASE } from "../../database/database.module";
import type { EntityCursor } from "../admin-entities.cursor";
import {
  excludeLinkedRvmIdentities,
  excludeSampleWorkers,
  excludeTestPayers,
  excludeTestWorkers,
} from "../numbers/exclusions";
import { OPENED_UNLOCK_STATUSES } from "../../unlock-outcomes/unlock-outcomes.repository";
import type {
  FactoryState,
  HireRecordRow,
  OpenedContactRow,
  PaymentOrderFacts,
  PhoneHolder,
  ShareWorkerFacts,
} from "./launch-test-rules";

/** One factory row as the list and the writes read it: never its name or phone ciphertext. */
export interface CohortRow extends FactoryState {
  readonly id: string;
  readonly hasPhone: boolean;
  readonly cityGroup: string;
  readonly tradeGroup: string;
  readonly sentByAdminId: string;
  readonly sentAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string;
}

/** A list row, plus the full-precision `created_at` the next page's cursor is built from. */
export interface CohortListRow extends CohortRow {
  readonly sortKey: string;
}

/** What a replayed create is compared on, read without the phone hash leaving the database. */
export interface CohortReplayFacts {
  /** The stored phone hash equals the asked one (both null counts as equal). */
  readonly samePhone: boolean;
  readonly cityGroup: string;
  readonly tradeGroup: string;
  readonly sentAt: Date;
  readonly workerIds: string[];
}

/** A new factory row: the ciphertexts and the hash are made by the service. */
export interface CohortInsert {
  readonly id: string;
  readonly factoryNameEnc: string;
  readonly factoryPhoneEnc: string | null;
  readonly factoryPhoneHash: string | null;
  readonly cityGroup: string;
  readonly tradeGroup: string;
  readonly payerId: string | null;
  readonly sentByAdminId: string;
  readonly sentAt: Date;
  readonly paymentLinkRef: string | null;
  readonly linkCreatedAt: Date | null;
}

/**
 * Microsecond ISO-8601 of a timestamptz, made by POSTGRES (a JS Date keeps milliseconds only).
 * The format string is the house one (`unlock-outcomes.repository.ts`, the inbox keysets).
 */
const US_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The first confirming source of a hire (`hire-state.ts`): the earliest of the three stamps. */
const CONFIRMED_AT = sql.raw(
  `LEAST("h"."company_marked_at", "h"."company_answered_at", "h"."desk_confirmed_at")`,
);

/**
 * #2754's IMPORT LEDGER HOOK for launch test B: the opens carried over by the company-move import
 * are left out of the contacts a company opened. The ledger does not exist yet, so nothing is left
 * out; when it lands, this becomes `NOT EXISTS (... the ledger row for "u"."id" ...)`.
 */
const NOT_AN_IMPORTED_OPEN: SQL = sql`TRUE`;

/**
 * #2755 part D — data access for `/admin/launch-tests/*`.
 *
 * ── WHAT IT NEVER SELECTS ────────────────────────────────────────────────────────────────────
 * The factory's name and phone ciphertext (`factory_name_enc`, `factory_phone_enc`): the name is
 * read ONLY by `AdminIdentityRepository.launchTestFactoryNames`, behind the audited identity
 * pipeline, and the phone by nothing. The phone's keyed hash is written here and compared here
 * (the one-row rule, a replay) without being projected. From `payers`, only the id, filtered by
 * the phone hash; never a name, contact or credential.
 *
 * ── TEST B ──────────────────────────────────────────────────────────────────────────────────
 * Two read-only statements over `hires`, `unlocks` and `unlock_outcomes` (its own queries; the
 * unlocks code is not called), in one REPEATABLE READ read-only transaction so the contacts are
 * read against the same hires. The rule halves that are pure live in `launch-test-rules.ts`.
 */
@Injectable()
export class AdminLaunchTestsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** One transaction for a write and its events. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  private static readonly SORT_KEY = sql<string>`to_char(${t.createdAt} at time zone 'UTC', ${sql.raw(US_FORMAT)})`;

  private static columns() {
    return {
      id: t.id,
      hasPhone: sql<boolean>`(${t.factoryPhoneHash} IS NOT NULL)`,
      cityGroup: t.cityGroup,
      tradeGroup: t.tradeGroup,
      payerId: t.payerId,
      sentByAdminId: t.sentByAdminId,
      sentAt: t.sentAt,
      paymentLinkRef: t.paymentLinkRef,
      linkCreatedAt: t.linkCreatedAt,
      result: sql<LaunchTestResult>`${t.result}`,
      paidAt: t.paidAt,
      paymentOrderId: t.paymentOrderId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      updatedByAdminId: t.updatedByAdminId,
    };
  }

  // -- Test A: reads ---------------------------------------------------------------------------

  /** One keyset page (fetch `limit + 1` to know whether another follows), newest first. */
  async listCohort(cursor: EntityCursor | null, limit: number): Promise<CohortListRow[]> {
    const where =
      cursor === null
        ? undefined
        : or(
            lt(t.createdAt, sql`${cursor.createdAt}::text::timestamptz`),
            and(eq(t.createdAt, sql`${cursor.createdAt}::text::timestamptz`), lt(t.id, cursor.id)),
          );
    return this.db
      .select({
        ...AdminLaunchTestsRepository.columns(),
        sortKey: AdminLaunchTestsRepository.SORT_KEY,
      })
      .from(t)
      .where(where)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
  }

  /** The workers sent to each of these factories, oldest share first. */
  async sharesFor(
    cohortIds: readonly string[],
    tx: Database = this.db,
  ): Promise<{ cohortId: string; workerId: string }[]> {
    if (cohortIds.length === 0) return [];
    return tx
      .select({ cohortId: launchTestShares.cohortId, workerId: launchTestShares.workerId })
      .from(launchTestShares)
      .where(inArray(launchTestShares.cohortId, [...cohortIds]))
      .orderBy(asc(launchTestShares.sharedAt), asc(launchTestShares.workerId));
  }

  /** One factory row (no lock). */
  async findCohort(id: string, tx: Database = this.db): Promise<CohortRow | undefined> {
    const rows = await tx
      .select(AdminLaunchTestsRepository.columns())
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    return rows[0];
  }

  /** The factory row under a write lock: an edit's read-merge-write, and the share count's guard. */
  async lockCohort(tx: Database, id: string): Promise<CohortRow | undefined> {
    const rows = await tx
      .select(AdminLaunchTestsRepository.columns())
      .from(t)
      .where(eq(t.id, id))
      .for("update")
      .limit(1);
    return rows[0];
  }

  /** What a replayed create is compared on. The asked phone hash is compared in SQL. */
  async replayFacts(
    id: string,
    askedPhoneHash: string | null,
    tx: Database = this.db,
  ): Promise<CohortReplayFacts | undefined> {
    const rows = await tx
      .select({
        samePhone: sql<boolean>`(${t.factoryPhoneHash} IS NOT DISTINCT FROM ${askedPhoneHash}::text)`,
        cityGroup: t.cityGroup,
        tradeGroup: t.tradeGroup,
        sentAt: t.sentAt,
      })
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    const shares = await this.sharesFor([id], tx);
    return { ...row, workerIds: shares.map((s) => s.workerId) };
  }

  /** How many workers this factory was sent (under the caller's lock). */
  async countShares(tx: Database, cohortId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(launchTestShares)
      .where(eq(launchTestShares.cohortId, cohortId));
    return rows[0]?.n ?? 0;
  }

  /** Whether another factory row (not `exceptId`) already holds this phone hash. */
  async phoneRecorded(tx: Database, phoneHash: string, exceptId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.factoryPhoneHash, phoneHash), sql`${t.id} <> ${exceptId}::uuid`))
      .limit(1);
    return rows.length > 0;
  }

  /** Whether another factory row (not `exceptId`) already links this paid order. */
  async orderLinkedElsewhere(tx: Database, orderId: string, exceptId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.paymentOrderId, orderId), sql`${t.id} <> ${exceptId}::uuid`))
      .limit(1);
    return rows.length > 0;
  }

  // -- Test A: the facts a write is checked against ---------------------------------------------

  /**
   * The BadaBhai companies holding this phone hash, each with whether Campus created it
   * (`institute_companies`). Ids only. Production may hold more than one account per phone.
   */
  async phoneHolders(phoneHash: string): Promise<PhoneHolder[]> {
    return this.db
      .select({
        payerId: payers.id,
        campusCompany: sql<boolean>`(${instituteCompanies.payerId} IS NOT NULL)`,
      })
      .from(payers)
      .leftJoin(instituteCompanies, eq(instituteCompanies.payerId, payers.id))
      .where(eq(payers.phoneHash, phoneHash))
      .limit(20);
  }

  /** One account by id, with whether Campus created it; undefined when there is none. */
  async payerFacts(payerId: string, tx: Database = this.db): Promise<PhoneHolder | undefined> {
    const rows = await tx
      .select({
        payerId: payers.id,
        campusCompany: sql<boolean>`(${instituteCompanies.payerId} IS NOT NULL)`,
      })
      .from(payers)
      .leftJoin(instituteCompanies, eq(instituteCompanies.payerId, payers.id))
      .where(eq(payers.id, payerId))
      .limit(1);
    return rows[0];
  }

  /**
   * #2754's IMPORT LEDGER HOOK for launch test A ("outside the portal is checked against the import
   * ledger of #2754 and the Campus company list"). The ledger of companies moved from the RVM
   * portal does not exist yet (#2754 item 6), so no phone is held by it; when it lands, this reads
   * it by the same keyed phone hash.
   */
  async importedFromPortal(_phoneHash: string): Promise<boolean> {
    return false;
  }

  /**
   * The requested workers that exist, with part A's test-account and linked-identity rules read in
   * SQL (the very fragments every numbers figure uses). The sample rule is the id predicate.
   */
  async workerFacts(workerIds: readonly string[]): Promise<ShareWorkerFacts[]> {
    if (workerIds.length === 0) return [];
    const rows = await this.db
      .select({
        workerId: workers.id,
        testWorker: sql<boolean>`(NOT ${excludeTestWorkers})`,
        linkedRvmIdentity: sql<boolean>`(NOT ${excludeLinkedRvmIdentities})`,
      })
      .from(workers)
      .where(inArray(workers.id, [...workerIds]));
    return rows.map((r) => ({ ...r, exists: true }));
  }

  /** One payment order's owner, status and provider (never its amounts' purpose or refs). */
  async paymentOrder(tx: Database, orderId: string): Promise<PaymentOrderFacts | undefined> {
    const rows = await tx
      .select({
        payerId: paymentOrders.payerId,
        status: paymentOrders.status,
        provider: paymentOrders.provider,
      })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .limit(1);
    return rows[0];
  }

  // -- Test A: writes ---------------------------------------------------------------------------

  /** The create. `ON CONFLICT (id) DO NOTHING`: false when the key's row already exists. */
  async insertCohort(tx: Database, values: CohortInsert, now: Date): Promise<boolean> {
    const rows = await tx
      .insert(t)
      .values({
        id: values.id,
        factoryNameEnc: values.factoryNameEnc,
        factoryPhoneEnc: values.factoryPhoneEnc,
        factoryPhoneHash: values.factoryPhoneHash,
        cityGroup: values.cityGroup,
        tradeGroup: values.tradeGroup,
        payerId: values.payerId,
        sentByAdminId: values.sentByAdminId,
        sentAt: values.sentAt,
        paymentLinkRef: values.paymentLinkRef,
        linkCreatedAt: values.linkCreatedAt,
        result: "pending",
        createdAt: now,
        updatedAt: now,
        updatedByAdminId: values.sentByAdminId,
      })
      .onConflictDoNothing({ target: t.id })
      .returning({ id: t.id });
    return rows.length > 0;
  }

  /** The shares of one factory, all at one time. */
  async insertShares(
    tx: Database,
    cohortId: string,
    workerIds: readonly string[],
    sharedAt: Date,
  ): Promise<void> {
    if (workerIds.length === 0) return;
    await tx
      .insert(launchTestShares)
      .values(workerIds.map((workerId) => ({ cohortId, workerId, sharedAt })));
  }

  /** The edit: the six editable columns, who changed them and when. */
  async updateCohort(
    tx: Database,
    id: string,
    next: FactoryState,
    adminId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(t)
      .set({
        paymentLinkRef: next.paymentLinkRef,
        linkCreatedAt: next.linkCreatedAt,
        result: next.result,
        paidAt: next.paidAt,
        payerId: next.payerId,
        paymentOrderId: next.paymentOrderId,
        updatedAt: now,
        updatedByAdminId: adminId,
      })
      .where(eq(t.id, id));
  }

  // -- Test B -----------------------------------------------------------------------------------

  /**
   * The first `limit` CONFIRMED hires (the confirmation time, then the id), and the contacts their
   * companies opened for their postings at or before each confirmation. One read-only snapshot.
   */
  async contactsPerHire(
    limit: number,
  ): Promise<{ hires: HireRecordRow[]; contacts: OpenedContactRow[] }> {
    return this.db.transaction(
      async (tx) => {
        const hires = await this.firstConfirmedHires(tx as unknown as Database, limit);
        const counted = hires.filter((h) => h.postingKind === "company_posting" && h.postingExists);
        const contacts = await this.openedContacts(tx as unknown as Database, counted);
        return { hires, contacts };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * Confirmed hires in the report's order. Test companies (`excludeTestPayers` on the tenant key),
   * test accounts and sample workers (part A's fragments over the joined, UNALIASED `workers`) are
   * left out. `posting_exists` is read only for a company posting.
   */
  async firstConfirmedHires(tx: Database, limit: number): Promise<HireRecordRow[]> {
    const rows = (await tx.execute(sql`
      SELECT "h"."id" AS hire_id,
             "h"."tenant_payer_id" AS tenant_payer_id,
             "h"."worker_id" AS worker_id,
             "h"."posting_kind" AS posting_kind,
             "h"."posting_id" AS posting_id,
             ("h"."posting_kind" = 'company_posting' AND EXISTS (
               SELECT 1 FROM job_postings jp WHERE jp.id = "h"."posting_id"
             )) AS posting_exists,
             to_char(${CONFIRMED_AT} AT TIME ZONE 'UTC', ${sql.raw(US_FORMAT)}) AS confirmed_key
      FROM hires "h"
      JOIN "workers" ON "workers"."id" = "h"."worker_id"
      WHERE "h"."status" = 'confirmed'
        AND ${CONFIRMED_AT} IS NOT NULL
        AND ${excludeTestPayers(sql.raw(`"h"."tenant_payer_id"`))}
        AND ${excludeTestWorkers}
        AND ${excludeSampleWorkers}
      ORDER BY ${CONFIRMED_AT} ASC, "h"."id" ASC
      LIMIT ${limit}
    `)) as unknown as {
      hire_id: string;
      tenant_payer_id: string;
      worker_id: string;
      posting_kind: "company_posting" | "agency_job";
      posting_id: string;
      posting_exists: boolean;
      confirmed_key: string;
    }[];
    return rows.map((r) => ({
      hireId: r.hire_id,
      tenantPayerId: r.tenant_payer_id,
      workerId: r.worker_id,
      postingKind: r.posting_kind,
      postingId: r.posting_id,
      postingExists: r.posting_exists,
      confirmedKey: r.confirmed_key,
    }));
  }

  /**
   * Each OPENED contact (`OPENED_UNLOCK_STATUSES` with a grant time, the follow-up's own rule) that
   * one of these hires' companies opened for that hire's posting at or before that hire's
   * confirmation, ONCE each, with its outcome row if any. A contact on a test account or a sample
   * worker is left out; one whose worker was erased (`worker_id` null) is kept. The per-hire split
   * is `contactsBeforeHire`'s.
   */
  async openedContacts(tx: Database, hires: readonly HireRecordRow[]): Promise<OpenedContactRow[]> {
    if (hires.length === 0) return [];
    const tenants = hires.map((h) => h.tenantPayerId);
    const postings = hires.map((h) => h.postingId);
    // Microsecond text, cast in SQL: the driver has no serializer for a timestamptz[] parameter.
    const confirmed = hires.map((h) => h.confirmedKey);
    const rows = (await tx.execute(sql`
      SELECT "u"."id" AS unlock_id,
             "u"."payer_id" AS tenant_payer_id,
             "u"."job_posting_id" AS job_posting_id,
             "u"."worker_id" AS worker_id,
             to_char("u"."granted_at" AT TIME ZONE 'UTC', ${sql.raw(US_FORMAT)}) AS granted_key,
             "o"."outcome" AS outcome,
             "o"."answered_by" AS answered_by,
             "o"."answered_at" AS answered_at
      FROM unlocks "u"
      LEFT JOIN "workers" ON "workers"."id" = "u"."worker_id"
      LEFT JOIN unlock_outcomes "o" ON "o"."unlock_id" = "u"."id"
      WHERE "u"."status" IN (${sql.join(
        OPENED_UNLOCK_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})
        AND "u"."granted_at" IS NOT NULL
        AND ("workers"."id" IS NULL OR (${excludeTestWorkers} AND ${excludeSampleWorkers}))
        AND ${NOT_AN_IMPORTED_OPEN}
        AND EXISTS (
          SELECT 1
          FROM unnest(
            ${sql.param(tenants)}::uuid[],
            ${sql.param(postings)}::uuid[],
            ${sql.param(confirmed)}::text[]
          ) AS "hh"("tenant_payer_id", "posting_id", "confirmed_at")
          WHERE "u"."payer_id" = "hh"."tenant_payer_id"
            AND "u"."job_posting_id" = "hh"."posting_id"
            AND "u"."granted_at" <= "hh"."confirmed_at"::timestamptz
        )
      ORDER BY "u"."granted_at" ASC, "u"."id" ASC
    `)) as unknown as {
      unlock_id: string;
      tenant_payer_id: string;
      job_posting_id: string;
      worker_id: string | null;
      granted_key: string;
      outcome: UnlockOutcome | null;
      answered_by: UnlockOutcomeAnswerer | null;
      answered_at: Date | string | null;
    }[];
    return rows.map((r) => ({
      unlockId: r.unlock_id,
      tenantPayerId: r.tenant_payer_id,
      jobPostingId: r.job_posting_id,
      workerId: r.worker_id,
      grantedKey: r.granted_key,
      outcome: r.outcome,
      answeredBy: r.answered_by,
      answeredAt: r.answered_at === null ? null : new Date(r.answered_at),
    }));
  }
}
