import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  CURRENT_PROFILE_ORDER,
  applications,
  creditLedger,
  generatedResumes,
  jobPostings,
  payerCredits,
  payers,
  unlocks,
  workerProfiles,
  workers,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "./admin-entities.cursor";
import type {
  AdminApplicationListItem,
  AdminCreditLedgerItem,
  AdminJobPostingDetail,
  AdminJobPostingListItem,
  AdminPayerDetail,
  AdminPayerListItem,
  AdminWorkerDetail,
  AdminWorkerListItem,
} from "./admin-entities.dto";

/**
 * SELECT-ONLY data access for the admin FACELESS entity reads (BP-1).
 *
 * ── THE PII BOUNDARY IS THE SELECT LIST ─────────────────────────────────────────────────
 * Every read here names its columns EXPLICITLY. Not one `select()` without a projection —
 * because `select()` means "every column", and on `workers` that is `phone_e164`,
 * `phone_hash` and `full_name`, and on `payers` it is four ciphertext columns and two keyed
 * hashes. A bare `select()` would put all of them one careless `return row` away from an HTTP
 * response, and the mistake would look exactly like working code. Naming the columns makes
 * the boundary a thing you have to actively edit past, and makes a review diff show it.
 *
 * That is also why this module does NOT reuse the existing domain repositories: `WorkersRepository.findById`
 * and `PayersRepository.findById` both return the FULL row, ciphertext included. They are
 * correct for their callers (which decrypt deliberately); they are the wrong shape for a
 * surface whose contract is "this can never carry PII".
 *
 * ── NO WRITES, EVER ─────────────────────────────────────────────────────────────────────
 * There is no insert/update/delete method in this file and there must never be one. Admin
 * mutations go through `AdminActionsService`, which emits the audited
 * `admin.action_performed`. A write added here would change system-of-record state with no
 * audit trail — the one thing the whole admin design exists to prevent.
 *
 * ── BOUNDED + INDEX-BACKED ──────────────────────────────────────────────────────────────
 * Every list is keyset-paginated on `(created_at, id)` DESC with a hard cap; migration 0064
 * adds the matching indexes. Counts are computed only on DETAIL reads (one entity), never
 * per row of a list — a count-per-row list is an N+1 that only shows up in production.
 */
@Injectable()
export class AdminEntitiesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The keyset predicate for "strictly older than the cursor" under a DESC `(created_at, id)`
   * sort: `created_at < c` OR (`created_at = c` AND `id < cid`). The tie-breaker is what makes
   * the ordering total, so no row is skipped or repeated at a page boundary.
   *
   * ── WHY THE TYPED OPERATORS, NOT A `sql` TEMPLATE ───────────────────────────────────────
   * `lt`/`eq` take the COLUMN, so Drizzle applies that column's `mapToDriverValue` — a
   * `timestamptz` gets its Date encoded, a `uuid` gets its string. An interpolated
   * `sql\`${col} < ${date}\`` looks identical and renders identical SQL, but the value goes to
   * the driver RAW: postgres-js then throws `The "string" argument must be of type string ...
   * Received an instance of Date`, and every second page 500s.
   *
   * This is worth the paragraph because the failure is invisible to a rendering test. Dumping
   * the statement shows `created_at < $1` either way — the difference only exists at parameter
   * serialization, which is to say only against a real database. The SQL-shape test in this
   * module's suite passed on the broken version; the live run is what caught it.
   */
  private static before(createdAtCol: PgColumn, idCol: PgColumn, cursor: EntityCursor): SQL {
    const at = new Date(cursor.createdAt);
    return or(lt(createdAtCol, at), and(eq(createdAtCol, at), lt(idCol, cursor.id)))!;
  }

  // ---- workers ------------------------------------------------------------

  async listWorkers(
    filter: { status?: string; pendingDeletion?: boolean },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminWorkerListItem[]> {
    const clauses: SQL[] = [];
    if (filter.status) clauses.push(eq(workers.status, filter.status as never));
    if (filter.pendingDeletion) clauses.push(isNotNull(workers.deletionScheduledAt));
    if (cursor) clauses.push(AdminEntitiesRepository.before(workers.createdAt, workers.id, cursor));

    const rows = await this.db
      .select({
        id: workers.id,
        status: workers.status,
        preferredLanguage: workers.preferredLanguage,
        // Reduced to a boolean IN POSTGRES, not in JS. Selecting the key and mapping it here
        // would work identically — and would also mean the object key of a worker's face photo
        // is sitting in a variable in this process, one `...r` spread away from a response.
        // The only way that can never happen is for the key not to be fetched at all.
        hasPhoto: sql<boolean>`${workers.photoStorageKey} IS NOT NULL`,
        resumeShowPhoto: workers.resumeShowPhoto,
        resumeNightShiftReady: workers.resumeNightShiftReady,
        deletionScheduledAt: workers.deletionScheduledAt,
        createdAt: workers.createdAt,
        updatedAt: workers.updatedAt,
      })
      .from(workers)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(workers.createdAt), desc(workers.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      preferred_language: r.preferredLanguage,
      has_photo: r.hasPhoto,
      resume_show_photo: r.resumeShowPhoto,
      // COALESCED AT THE BOUNDARY (#1426). The column is three-state since 0100, but
      // `AdminWorkerListItem` types this `boolean` and apps/admin-web parses it with
      // `z.boolean()` — a JSON null fails that safeParse, which `adminFetch` turns into a
      // thrown AdminRequestError, dark-ing the whole workers list rather than one field. The
      // ops console has no third state to show, and "never asked" reads as "no" there anyway.
      resume_night_shift_ready: r.resumeNightShiftReady ?? false,
      deletion_scheduled_at: r.deletionScheduledAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  async findWorker(id: string): Promise<AdminWorkerDetail | undefined> {
    const rows = await this.db
      .select({
        id: workers.id,
        status: workers.status,
        preferredLanguage: workers.preferredLanguage,
        // Reduced to a boolean IN POSTGRES, not in JS. Selecting the key and mapping it here
        // would work identically — and would also mean the object key of a worker's face photo
        // is sitting in a variable in this process, one `...r` spread away from a response.
        // The only way that can never happen is for the key not to be fetched at all.
        hasPhoto: sql<boolean>`${workers.photoStorageKey} IS NOT NULL`,
        resumeShowPhoto: workers.resumeShowPhoto,
        resumeNightShiftReady: workers.resumeNightShiftReady,
        deletionScheduledAt: workers.deletionScheduledAt,
        createdAt: workers.createdAt,
        updatedAt: workers.updatedAt,
      })
      .from(workers)
      .where(eq(workers.id, id))
      .limit(1);

    const w = rows[0];
    if (!w) return undefined;

    const [profileRows, resumeRows, appRows, unlockRows] = await Promise.all([
      // `CURRENT_PROFILE_ORDER`, so the status an admin reads on a worker is the status that
      // worker's own `GET /workers/me/profile` reports. Ordering by recency alone let the two
      // disagree whenever an extraction had run during an ai-service outage.
      this.db
        .select({ status: workerProfiles.profileStatus, updatedAt: workerProfiles.updatedAt })
        .from(workerProfiles)
        .where(eq(workerProfiles.workerId, id))
        .orderBy(...CURRENT_PROFILE_ORDER)
        .limit(1),
      this.db
        .select({ id: generatedResumes.id })
        .from(generatedResumes)
        .where(eq(generatedResumes.workerId, id))
        .limit(1),
      this.db.select({ n: count() }).from(applications).where(eq(applications.workerId, id)),
      this.db.select({ n: count() }).from(unlocks).where(eq(unlocks.workerId, id)),
    ]);

    return {
      id: w.id,
      status: w.status,
      preferred_language: w.preferredLanguage,
      has_photo: w.hasPhoto,
      resume_show_photo: w.resumeShowPhoto,
      // Same coalesce as the list projection above, and for the same admin-web contract.
      resume_night_shift_ready: w.resumeNightShiftReady ?? false,
      deletion_scheduled_at: w.deletionScheduledAt,
      created_at: w.createdAt,
      updated_at: w.updatedAt,
      profile_status: profileRows[0]?.status ?? null,
      profile_updated_at: profileRows[0]?.updatedAt ?? null,
      has_resume: resumeRows.length > 0,
      application_count: appRows[0]?.n ?? 0,
      unlock_count: unlockRows[0]?.n ?? 0,
    };
  }

  // ---- payers (the portal's Companies + Agencies, split by `role`) ---------

  async listPayers(
    filter: { role?: string; status?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminPayerListItem[]> {
    const clauses: SQL[] = [];
    if (filter.role) clauses.push(eq(payers.role, filter.role as never));
    if (filter.status) clauses.push(eq(payers.status, filter.status as never));
    if (cursor) clauses.push(AdminEntitiesRepository.before(payers.createdAt, payers.id, cursor));

    const rows = await this.db
      .select({
        id: payers.id,
        role: payers.role,
        status: payers.status,
        previousStatus: payers.previousStatus,
        createdAt: payers.createdAt,
        updatedAt: payers.updatedAt,
      })
      .from(payers)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(payers.createdAt), desc(payers.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      previous_status: r.previousStatus,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  async findPayer(id: string): Promise<AdminPayerDetail | undefined> {
    const rows = await this.db
      .select({
        id: payers.id,
        role: payers.role,
        status: payers.status,
        previousStatus: payers.previousStatus,
        createdAt: payers.createdAt,
        updatedAt: payers.updatedAt,
      })
      .from(payers)
      .where(eq(payers.id, id))
      .limit(1);

    const p = rows[0];
    if (!p) return undefined;

    const [balanceRows, postingRows, openRows, unlockRows] = await Promise.all([
      this.db
        .select({ balance: payerCredits.balance })
        .from(payerCredits)
        .where(eq(payerCredits.payerId, id))
        .limit(1),
      this.db.select({ n: count() }).from(jobPostings).where(eq(jobPostings.payerId, id)),
      this.db
        .select({ n: count() })
        .from(jobPostings)
        .where(and(eq(jobPostings.payerId, id), eq(jobPostings.status, "open"))),
      this.db.select({ n: count() }).from(unlocks).where(eq(unlocks.payerId, id)),
    ]);

    return {
      id: p.id,
      role: p.role,
      status: p.status,
      previous_status: p.previousStatus,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      // No credits row means the payer has never transacted — a genuine zero, not a missing
      // value, so it renders as 0 rather than as an "unavailable" state.
      credit_balance: balanceRows[0]?.balance ?? 0,
      posting_count: postingRows[0]?.n ?? 0,
      open_posting_count: openRows[0]?.n ?? 0,
      unlock_count: unlockRows[0]?.n ?? 0,
    };
  }

  // ---- job postings -------------------------------------------------------

  async listJobPostings(
    filter: { status?: string; verificationStatus?: string; payerId?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminJobPostingListItem[]> {
    const clauses: SQL[] = [];
    if (filter.status) clauses.push(eq(jobPostings.status, filter.status as never));
    if (filter.verificationStatus) {
      clauses.push(eq(jobPostings.verificationStatus, filter.verificationStatus as never));
    }
    if (filter.payerId) clauses.push(eq(jobPostings.payerId, filter.payerId));
    if (cursor) {
      clauses.push(AdminEntitiesRepository.before(jobPostings.createdAt, jobPostings.id, cursor));
    }

    const rows = await this.db
      .select({
        id: jobPostings.id,
        payerId: jobPostings.payerId,
        orgLabel: jobPostings.orgLabel,
        roleTitle: jobPostings.roleTitle,
        locationLabel: jobPostings.locationLabel,
        city: jobPostings.city,
        status: jobPostings.status,
        verificationStatus: jobPostings.verificationStatus,
        vacancyBand: jobPostings.vacancyBand,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        publishedAt: jobPostings.publishedAt,
        closedAt: jobPostings.closedAt,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(jobPostings.createdAt), desc(jobPostings.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      payer_id: r.payerId,
      org_label: r.orgLabel,
      role_title: r.roleTitle,
      location_label: r.locationLabel,
      city: r.city,
      status: r.status,
      verification_status: r.verificationStatus,
      vacancy_band: r.vacancyBand,
      pay_min: r.payMin,
      pay_max: r.payMax,
      published_at: r.publishedAt,
      closed_at: r.closedAt,
      created_at: r.createdAt,
    }));
  }

  async findJobPosting(id: string): Promise<AdminJobPostingDetail | undefined> {
    const rows = await this.db
      .select({
        id: jobPostings.id,
        payerId: jobPostings.payerId,
        orgLabel: jobPostings.orgLabel,
        roleTitle: jobPostings.roleTitle,
        locationLabel: jobPostings.locationLabel,
        city: jobPostings.city,
        description: jobPostings.description,
        status: jobPostings.status,
        verificationStatus: jobPostings.verificationStatus,
        vacancyBand: jobPostings.vacancyBand,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        shift: jobPostings.shift,
        neededBy: jobPostings.neededBy,
        publishedAt: jobPostings.publishedAt,
        boostedUntil: jobPostings.boostedUntil,
        closedAt: jobPostings.closedAt,
        previousStatus: jobPostings.previousStatus,
        createdAt: jobPostings.createdAt,
        updatedAt: jobPostings.updatedAt,
      })
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);

    const j = rows[0];
    if (!j) return undefined;

    const [appliedRows, skippedRows] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(applications)
        .where(and(eq(applications.jobPostingId, id), eq(applications.action, "applied"))),
      this.db
        .select({ n: count() })
        .from(applications)
        .where(and(eq(applications.jobPostingId, id), eq(applications.action, "skipped"))),
    ]);

    return {
      id: j.id,
      payer_id: j.payerId,
      org_label: j.orgLabel,
      role_title: j.roleTitle,
      location_label: j.locationLabel,
      city: j.city,
      description: j.description,
      status: j.status,
      verification_status: j.verificationStatus,
      vacancy_band: j.vacancyBand,
      pay_min: j.payMin,
      pay_max: j.payMax,
      shift: j.shift,
      needed_by: j.neededBy,
      published_at: j.publishedAt,
      boosted_until: j.boostedUntil,
      closed_at: j.closedAt,
      previous_status: j.previousStatus,
      applied_count: appliedRows[0]?.n ?? 0,
      skipped_count: skippedRows[0]?.n ?? 0,
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    };
  }

  // ---- applications -------------------------------------------------------

  async listApplications(
    filter: { workerId?: string; jobPostingId?: string; action?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminApplicationListItem[]> {
    const clauses: SQL[] = [];
    if (filter.workerId) clauses.push(eq(applications.workerId, filter.workerId));
    if (filter.jobPostingId) clauses.push(eq(applications.jobPostingId, filter.jobPostingId));
    if (filter.action) clauses.push(eq(applications.action, filter.action as never));
    if (cursor) {
      clauses.push(
        AdminEntitiesRepository.before(applications.createdAt, applications.id, cursor),
      );
    }

    const rows = await this.db
      .select({
        id: applications.id,
        workerId: applications.workerId,
        jobId: applications.jobId,
        jobPostingId: applications.jobPostingId,
        action: applications.action,
        reason: applications.reason,
        sourceSurface: applications.sourceSurface,
        matchTier: applications.matchTier,
        engineVersion: applications.engineVersion,
        createdAt: applications.createdAt,
      })
      .from(applications)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(applications.createdAt), desc(applications.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      worker_id: r.workerId,
      job_id: r.jobId,
      job_posting_id: r.jobPostingId,
      action: r.action,
      reason: r.reason,
      source_surface: r.sourceSurface,
      match_tier: r.matchTier,
      engine_version: r.engineVersion,
      created_at: r.createdAt,
    }));
  }

  // ---- credits ------------------------------------------------------------

  async getCreditBalance(payerId: string): Promise<number> {
    const rows = await this.db
      .select({ balance: payerCredits.balance })
      .from(payerCredits)
      .where(eq(payerCredits.payerId, payerId))
      .limit(1);
    return rows[0]?.balance ?? 0;
  }

  async listCreditLedger(
    payerId: string,
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminCreditLedgerItem[]> {
    const clauses: SQL[] = [eq(creditLedger.payerId, payerId)];
    if (cursor) {
      clauses.push(AdminEntitiesRepository.before(creditLedger.createdAt, creditLedger.id, cursor));
    }

    const rows = await this.db
      .select({
        id: creditLedger.id,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        unlockId: creditLedger.unlockId,
        packCode: creditLedger.packCode,
        priceInr: creditLedger.priceInr,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(and(...clauses))
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      unlock_id: r.unlockId,
      pack_code: r.packCode,
      price_inr: r.priceInr,
      created_at: r.createdAt,
    }));
    // NOTE: `payment_ref` is deliberately NOT projected. It is documented as an opaque
    // gateway order id, but it is the one column on this table whose contents come from an
    // external system, so it is the one column whose PII-freeness this codebase cannot
    // guarantee. Nothing in the portal needs it; omitting it costs nothing.
  }
}
