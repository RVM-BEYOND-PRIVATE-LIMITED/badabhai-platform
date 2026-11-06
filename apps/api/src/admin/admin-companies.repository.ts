import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  max,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import {
  agencyProfiles,
  auditLogs,
  creditLedger,
  employerProfiles,
  jobPostings,
  jobs,
  payerCapacity,
  payerCredits,
  payerMembers,
  payerOrgs,
  payers,
  paymentOrders,
  planQuotaTopups,
  postingBoosts,
  postingPlans,
  type CreditReason,
  type Database,
  type NewAgencyProfile,
  type NewEmployerProfile,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The company list's filter set — one definition for the count and the page, so
 * the total and the rows can never disagree on what they filtered.
 */
export interface CompanyListFilter {
  searchWords: string[];
  searchCity: string | null;
  searchGstHash: string | null;
  kind?: PayerRole;
  status?: PayerStatus;
  verification?: string;
  sort: "newest" | "oldest";
}

/**
 * SELECT- and single-purpose-write data access for the admin COMPANY surface (#2564 B10).
 *
 * Same discipline as the finance/entity repositories: explicit column projections on
 * reads, no `select()` anywhere near PII, and bounded pages. The archive/restore
 * cascades mirror `AdminActionsRepository`'s suspension pair with a distinct frozen
 * state (`archived`, never `suspended`) so the two restores can never move each
 * other's rows — see `archiveCompany`/`restoreCompany` below.
 */
@Injectable()
export class AdminCompaniesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` inside ONE transaction (the write's atomic boundary — SoR + audit + events). */
  async withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  // ---------------------------------------------------------------------------
  // Org resolution
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Org resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve ANY payer in a company to its org: the anchor login, the org row, and
   * every active member login. A payer with no org resolves to themselves alone
   * (solo) — the same shape the payment-history read uses (its twin lives there;
   * the two cannot drift on "which logins belong to a company" because both are
   * this ten-line rule, and both are pinned by tests).
   */
  async resolveCompany(
    payerId: string,
  ): Promise<{ orgId: string | null; anchorPayerId: string; memberPayerIds: string[] }> {
    const [ownOrg] = await this.db
      .select({ id: payerOrgs.id, rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(eq(payerOrgs.rootPayerId, payerId))
      .limit(1);
    const orgId =
      ownOrg?.id ??
      (
        await this.db
          .select({ orgId: payerMembers.orgId })
          .from(payerMembers)
          .where(and(eq(payerMembers.memberPayerId, payerId), eq(payerMembers.status, "active")))
          .orderBy(desc(payerMembers.acceptedAt))
          .limit(1)
      )[0]?.orgId;
    if (!orgId) return { orgId: null, anchorPayerId: payerId, memberPayerIds: [payerId] };

    const [org] = await this.db
      .select({ rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(eq(payerOrgs.id, orgId))
      .limit(1);
    const anchor = org?.rootPayerId ?? payerId;
    const members = await this.db
      .select({ memberPayerId: payerMembers.memberPayerId })
      .from(payerMembers)
      .where(and(eq(payerMembers.orgId, orgId), eq(payerMembers.status, "active")));
    const ids = new Set<string>([anchor]);
    for (const m of members) if (m.memberPayerId) ids.add(m.memberPayerId);
    return { orgId, anchorPayerId: anchor, memberPayerIds: [...ids] };
  }

  // ---------------------------------------------------------------------------
  // List (one row per organisation, numbered pages)
  // ---------------------------------------------------------------------------

  /** Exact total across the filters (numbered pages need a denominator). */
  async countCompanies(filter: CompanyListFilter): Promise<number> {
    const clauses = this.listClauses(filter);
    const [row] = await this.db
      .select({ n: count() })
      .from(payerOrgs)
      .innerJoin(payers, eq(payers.id, payerOrgs.rootPayerId))
      .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
      .leftJoin(agencyProfiles, eq(agencyProfiles.payerId, payers.id))
      .where(clauses.length > 0 ? and(...clauses) : undefined);
    return row?.n ?? 0;
  }

  /** One page of orgs with their anchor payer + profile verification. */
  async listCompanies(
    filter: CompanyListFilter,
    offset: number,
    limit: number,
  ): Promise<
    Array<{
      orgId: string;
      anchorPayerId: string;
      kind: PayerRole;
      status: PayerStatus;
      verification: string;
      anchorCreatedAt: Date;
      orgCreatedAt: Date;
    }>
  > {
    const clauses = this.listClauses(filter);
    const order =
      filter.sort === "oldest"
        ? [asc(payers.createdAt), asc(payers.id)]
        : [desc(payers.createdAt), desc(payers.id)];
    const rows = await this.db
      .select({
        orgId: payerOrgs.id,
        anchorPayerId: payers.id,
        kind: payers.role,
        status: payers.status,
        verification: sql<string>`coalesce(${employerProfiles.verificationStatus}, ${agencyProfiles.verificationStatus}, 'pending')`,
        anchorCreatedAt: payers.createdAt,
        orgCreatedAt: payerOrgs.createdAt,
      })
      .from(payerOrgs)
      .innerJoin(payers, eq(payers.id, payerOrgs.rootPayerId))
      .leftJoin(employerProfiles, eq(employerProfiles.payerId, payers.id))
      .leftJoin(agencyProfiles, eq(agencyProfiles.payerId, payers.id))
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      orgId: r.orgId,
      anchorPayerId: r.anchorPayerId,
      kind: r.kind,
      status: r.status,
      verification: r.verification,
      anchorCreatedAt: r.anchorCreatedAt,
      orgCreatedAt: r.orgCreatedAt,
    }));
  }

  /**
   * The shared WHERE for the count and the page (one definition, so the total and
   * the rows can never disagree on what they filtered). Search is a three-way OR —
   * whole-word name (word-hash containment), GSTIN (exact HMAC), city (fragment)
   * — ANDed with the kind/status/verification filters.
   */
  private listClauses(filter: CompanyListFilter): SQL[] {
    const clauses: SQL[] = [];
    if (filter.kind) clauses.push(eq(payers.role, filter.kind));
    if (filter.status) clauses.push(eq(payers.status, filter.status));
    if (filter.verification) {
      clauses.push(
        sql`coalesce(${employerProfiles.verificationStatus}, ${agencyProfiles.verificationStatus}, 'pending') = ${filter.verification}`,
      );
    }
    const search: SQL[] = [];
    // Whole-word name: the query's words must ALL be present (containment = AND).
    // Pre-column rows carry NULL hashes and never match — they become searchable on
    // the next login (lazy fill) or the word-hash backfill, never on a guess.
    if (filter.searchWords.length > 0) {
      search.push(arrayContains(payers.orgNameWordHashes, filter.searchWords));
    }
    if (filter.searchCity) {
      search.push(
        or(
          ilike(employerProfiles.city, `%${filter.searchCity}%`),
          ilike(agencyProfiles.city, `%${filter.searchCity}%`),
        )!,
      );
    }
    if (filter.searchGstHash) {
      search.push(
        or(
          eq(employerProfiles.gstNumberHash, filter.searchGstHash),
          eq(agencyProfiles.gstNumberHash, filter.searchGstHash),
        )!,
      );
    }
    if (search.length > 0) clauses.push(or(...search)!);
    return clauses;
  }

  // ---------------------------------------------------------------------------
  // Batched aggregates (one page's worth — never N+1, never unbounded)
  // ---------------------------------------------------------------------------

  /** Live credit balance summed per wallet. */
  async balancesByPayer(payerIds: string[]): Promise<Map<string, number>> {
    if (payerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ payerId: payerCredits.payerId, balance: sum(payerCredits.balance) })
      .from(payerCredits)
      .where(inArray(payerCredits.payerId, payerIds))
      .groupBy(payerCredits.payerId);
    return new Map(rows.map((r) => [r.payerId, Number(r.balance ?? 0)]));
  }

  /** Posting counts per payer (`status='open'` vs all) over the served entity. */
  async postingCountsByPayer(
    payerIds: string[],
  ): Promise<Map<string, { open: number; total: number }>> {
    if (payerIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        payerId: jobPostings.payerId,
        total: count(),
        open: sum(sql`case when ${jobPostings.status} = 'open' then 1 else 0 end`),
      })
      .from(jobPostings)
      .where(and(inArray(jobPostings.payerId, payerIds), isNotNull(jobPostings.payerId)))
      .groupBy(jobPostings.payerId);
    return new Map(
      rows.map((r) => [r.payerId as string, { open: Number(r.open ?? 0), total: r.total }]),
    );
  }

  /** Active + invited member logins per org (removed excluded). */
  async memberCountsByOrg(orgIds: string[]): Promise<Map<string, number>> {
    if (orgIds.length === 0) return new Map();
    const rows = await this.db
      .select({ orgId: payerMembers.orgId, n: count() })
      .from(payerMembers)
      .where(
        and(
          inArray(payerMembers.orgId, orgIds),
          or(eq(payerMembers.status, "active"), eq(payerMembers.status, "invited"))!,
        ),
      )
      .groupBy(payerMembers.orgId);
    return new Map(rows.map((r) => [r.orgId, r.n]));
  }

  /**
   * Latest money movement per payer across every money table (the list's
   * "last payment" column). Six bounded aggregate probes — one per source — over
   * the page's member ids, reduced in JS. Null = the org never paid for anything.
   */
  async lastPaymentByPayer(payerIds: string[]): Promise<Map<string, Date>> {
    if (payerIds.length === 0) return new Map();
    const latest = new Map<string, Date>();
    const take = (payerId: string | null, at: Date | null) => {
      if (!payerId || !at) return;
      const cur = latest.get(payerId);
      if (!cur || at.getTime() > cur.getTime()) latest.set(payerId, at);
    };
    const [orders, ledger, plans, boosts, topups, capacity] = await Promise.all([
      this.db
        .select({ payerId: paymentOrders.payerId, at: max(paymentOrders.createdAt) })
        .from(paymentOrders)
        .where(inArray(paymentOrders.payerId, payerIds))
        .groupBy(paymentOrders.payerId),
      this.db
        .select({ payerId: creditLedger.payerId, at: max(creditLedger.createdAt) })
        .from(creditLedger)
        .where(
          and(
            inArray(creditLedger.payerId, payerIds),
            // Purchases and manual movements only — unlock debits are spend, not payment.
            inArray(creditLedger.reason, ["pack_purchase", "grant", "refund"] as CreditReason[]),
          ),
        )
        .groupBy(creditLedger.payerId),
      this.db
        .select({ payerId: postingPlans.payerId, at: max(postingPlans.paidAt) })
        .from(postingPlans)
        .where(inArray(postingPlans.payerId, payerIds))
        .groupBy(postingPlans.payerId),
      this.db
        .select({ payerId: postingBoosts.payerId, at: max(postingBoosts.boostStartsAt) })
        .from(postingBoosts)
        .where(inArray(postingBoosts.payerId, payerIds))
        .groupBy(postingBoosts.payerId),
      this.db
        .select({ payerId: planQuotaTopups.payerId, at: max(planQuotaTopups.createdAt) })
        .from(planQuotaTopups)
        .where(inArray(planQuotaTopups.payerId, payerIds))
        .groupBy(planQuotaTopups.payerId),
      this.db
        .select({ payerId: payerCapacity.payerId, at: max(payerCapacity.updatedAt) })
        .from(payerCapacity)
        .where(inArray(payerCapacity.payerId, payerIds))
        .groupBy(payerCapacity.payerId),
    ]);
    for (const rows of [orders, ledger, plans, boosts, topups, capacity]) {
      for (const r of rows) take(r.payerId, r.at ? new Date(r.at as unknown as string) : null);
    }
    return latest;
  }

  // ---------------------------------------------------------------------------
  // Profiles (1:1 extensions — one row per payer, at most one table populated)
  // ---------------------------------------------------------------------------

  async findEmployerProfile(payerId: string) {
    const [row] = await this.db
      .select()
      .from(employerProfiles)
      .where(eq(employerProfiles.payerId, payerId))
      .limit(1);
    return row;
  }

  async findAgencyProfile(payerId: string) {
    const [row] = await this.db
      .select()
      .from(agencyProfiles)
      .where(eq(agencyProfiles.payerId, payerId))
      .limit(1);
    return row;
  }

  /** Upsert the employer extension (insert-or-replace on the 1:1 PK). */
  async upsertEmployerProfile(
    payerId: string,
    patch: Partial<NewEmployerProfile>,
    tx?: Database,
  ) {
    const exec = tx ?? this.db;
    const [row] = await exec
      .insert(employerProfiles)
      .values({ payerId, ...patch })
      .onConflictDoUpdate({ target: employerProfiles.payerId, set: { ...patch, updatedAt: sql`now()` } })
      .returning();
    return row;
  }

  /** Upsert the agency extension (insert-or-replace on the 1:1 PK). */
  async upsertAgencyProfile(payerId: string, patch: Partial<NewAgencyProfile>, tx?: Database) {
    const exec = tx ?? this.db;
    const [row] = await exec
      .insert(agencyProfiles)
      .values({ payerId, ...patch })
      .onConflictDoUpdate({ target: agencyProfiles.payerId, set: { ...patch, updatedAt: sql`now()` } })
      .returning();
    return row;
  }

  /** Payer lifecycle statuses for an id set (archive/restore targeting). */
  async statusesByPayer(payerIds: string[]): Promise<Map<string, PayerStatus>> {
    if (payerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: payers.id, status: payers.status })
      .from(payers)
      .where(inArray(payers.id, payerIds));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  // ---------------------------------------------------------------------------
  // Audit (the written reason — same contract as the #2563 login writes)
  // ---------------------------------------------------------------------------

  /**
   * The written reason for a company write. `audit_logs` is the platform's
   * write-only audit table; the reason code and text live here, NEVER on the
   * value-free `admin.action_performed` event. `reason_text` is admin-authored and
   * never evented or logged (the DTO rejects hard identifiers at the boundary).
   */
  async writeAuditReason(
    tx: Database,
    input: {
      adminId: string;
      payerId: string;
      action: string;
      reasonCode: string;
      reasonText: string;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: input.adminId,
      action: input.action,
      entityType: "payer",
      entityId: input.payerId,
      metadata: {
        reason_code: input.reasonCode,
        reason_text: input.reasonText,
      },
    });
  }

  /**
   * A create that 409s because the login already exists still leaves a trace.
   * Written OUTSIDE the rolled-back transaction, value-free: admin id, action code
   * and the EXISTING payer id only.
   */
  async writeConflictAudit(adminId: string, payerId: string, actionCode: string): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorType: "admin",
      actorId: adminId,
      action: actionCode,
      entityType: "payer",
      entityId: payerId,
      metadata: {},
    });
  }

  // ---------------------------------------------------------------------------
  // Archive / restore cascades (the suspension twin — `archived`, never `suspended`)
  // ---------------------------------------------------------------------------

  /**
   * Freeze every member login that is not already removed: pending|active|suspended →
   * `archived`, stamping the CURRENT status as `previous_status` (even `suspended`,
   * so the chain composes and restore hands it back). Returns the moved rows' ids
   * with their stamped previous — the restore set and the per-login events.
   */
  async archiveLogins(
    payerIds: string[],
    tx: Database,
  ): Promise<Array<{ id: string; previousStatus: PayerStatus | null }>> {
    if (payerIds.length === 0) return [];
    return tx
      .update(payers)
      .set({
        status: "archived",
        previousStatus: sql`${payers.status}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(payers.id, payerIds),
          inArray(payers.status, ["pending", "active", "suspended"]),
        ),
      )
      .returning({ id: payers.id, previousStatus: payers.previousStatus });
  }

  /**
   * Hand every archived login back to its previous usable state (NULL → `pending`,
   * the fail-closed direction — the reinstate rule, verbatim). Only `archived` rows
   * move: a login suspended for other reasons stays suspended.
   */
  async restoreLogins(
    payerIds: string[],
    tx: Database,
  ): Promise<Array<{ id: string; status: PayerStatus }>> {
    if (payerIds.length === 0) return [];
    return tx
      .update(payers)
      .set({
        status: sql`coalesce(${payers.previousStatus}, 'pending')`,
        previousStatus: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(payers.id, payerIds), eq(payers.status, "archived")))
      .returning({ id: payers.id, status: payers.status });
  }

  /**
   * Freeze an archived company's live postings: open|paused → `archived` (previous
   * preserved). Draft/closed/suspended untouched — same carve-outs as suspend.
   */
  async archivePostings(
    payerIds: string[],
    tx: Database,
  ): Promise<{ postings: number }> {
    if (payerIds.length === 0) return { postings: 0 };
    const rows = await tx
      .update(jobPostings)
      .set({
        status: "archived",
        previousStatus: sql`${jobPostings.status}`,
        updatedAt: new Date(),
      })
      .where(
        and(inArray(jobPostings.payerId, payerIds), inArray(jobPostings.status, ["open", "paused"])),
      )
      .returning({ id: jobPostings.id });
    return { postings: rows.length };
  }

  /** Thaw archived postings back to their receipt (open stays open, paused stays paused). */
  async restorePostings(
    payerIds: string[],
    tx: Database,
  ): Promise<{ postings: number }> {
    if (payerIds.length === 0) return { postings: 0 };
    const rows = await tx
      .update(jobPostings)
      .set({
        status: sql`coalesce(${jobPostings.previousStatus}, 'paused')`,
        previousStatus: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(jobPostings.payerId, payerIds), eq(jobPostings.status, "archived")))
      .returning({ id: jobPostings.id });
    return { postings: rows.length };
  }

  /**
   * Freeze/thaw the legacy `jobs` rows (single live state — no previous to keep,
   * exactly like the suspend pair). Paused jobs are already unserved, so only
   * `open` freezes; only `archived` thaws (back to `open`). Returns the moved ids:
   * the archive twin freeze below rides on exactly this set.
   */
  async archiveJobs(payerIds: string[], tx: Database): Promise<{ jobs: number; jobIds: string[] }> {
    if (payerIds.length === 0) return { jobs: 0, jobIds: [] };
    const rows = await tx
      .update(jobs)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(inArray(jobs.payerId, payerIds), eq(jobs.status, "open")))
      .returning({ id: jobs.id });
    return { jobs: rows.length, jobIds: rows.map((r) => r.id) };
  }

  async restoreJobs(payerIds: string[], tx: Database): Promise<{ jobs: number; jobIds: string[] }> {
    if (payerIds.length === 0) return { jobs: 0, jobIds: [] };
    const rows = await tx
      .update(jobs)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(inArray(jobs.payerId, payerIds), eq(jobs.status, "archived")))
      .returning({ id: jobs.id });
    return { jobs: rows.length, jobIds: rows.map((r) => r.id) };
  }

  /**
   * Freeze/thaw the SYSTEM-owned agency twins (`payer_id` NULL — the archive
   * cascade's payer predicate cannot see them) via the source-job link. Same
   * carve-outs as postings (open|paused → archived with receipt; archived →
   * receipt), so a twin frozen here thaws here and a twin closed/converted
   * meanwhile never moves. The twin sync skips frozen rows on both ends
   * (`skipped_archived`), so freezing here cannot be converged away.
   */
  async archiveTwins(jobIds: string[], tx: Database): Promise<{ postings: number }> {
    if (jobIds.length === 0) return { postings: 0 };
    const rows = await tx
      .update(jobPostings)
      .set({
        status: "archived",
        previousStatus: sql`${jobPostings.status}`,
        updatedAt: new Date(),
      })
      .where(
        and(inArray(jobPostings.sourceJobId, jobIds), inArray(jobPostings.status, ["open", "paused"])),
      )
      .returning({ id: jobPostings.id });
    return { postings: rows.length };
  }

  async restoreTwins(jobIds: string[], tx: Database): Promise<{ postings: number }> {
    if (jobIds.length === 0) return { postings: 0 };
    const rows = await tx
      .update(jobPostings)
      .set({
        status: sql`coalesce(${jobPostings.previousStatus}, 'paused')`,
        previousStatus: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(jobPostings.sourceJobId, jobIds), eq(jobPostings.status, "archived")))
      .returning({ id: jobPostings.id });
    return { postings: rows.length };
  }
}
