import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, inArray, lt, lte, ne, or } from "drizzle-orm";
import {
  auditLogs,
  contactReachAttempts,
  contactReachCases,
  creditLedger,
  creditLots,
  grantCreditsWithinTx,
  unlocks,
  type ContactReachAttemptResult,
  type ContactReachAttemptRow,
  type ContactReachCaseRow,
  type ContactReachResolvedBy,
  type ContactReachStatus,
  type Database,
  type UnlockStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "../admin/admin-entities.cursor";
import type { TenantKey } from "../payers/payer-tenant-scope";

/** The open a report names, as this company holds it. */
export interface ReportableUnlock {
  readonly id: string;
  readonly workerId: string | null;
  readonly status: UnlockStatus;
  readonly grantedAt: Date | null;
}

/** One case with how many calls the desk made on it. */
export interface ReachCaseWithAttempts extends ContactReachCaseRow {
  readonly attempts: number;
}

/** One `unlock_debit` line of an open: the lot it spent from and that lot's expiry. */
export interface SpentFromLot {
  readonly lotId: string | null;
  readonly credits: number;
  readonly lotExpiresAt: Date | null;
}

/** The queue's filter: open cases (nearest deadline first) or closed ones (newest first). */
export type ReachCaseFilter = "open" | "resolved" | "all";

/**
 * Data access for `contact_reach_cases` and `contact_reach_attempts` (#2750 item 7), and the
 * credit return a not-reached case makes. The only reader and writer of both tables. Every write
 * takes the caller's transaction, so a case change, its audit row, its returned credits and its
 * event commit together.
 */
@Injectable()
export class ReachDeskRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  /** The open `unlockId` if THIS company (its tenant key) holds it, else undefined. */
  async findOwnUnlock(tenant: TenantKey, unlockId: string): Promise<ReportableUnlock | undefined> {
    const rows = await this.db
      .select({
        id: unlocks.id,
        workerId: unlocks.workerId,
        status: unlocks.status,
        grantedAt: unlocks.grantedAt,
      })
      .from(unlocks)
      .where(and(eq(unlocks.id, unlockId), eq(unlocks.payerId, tenant)))
      .limit(1);
    return rows[0];
  }

  /** The case of one open, if reported. */
  async findCaseByUnlock(unlockId: string, tx?: Database): Promise<ContactReachCaseRow | undefined> {
    const rows = await (tx ?? this.db)
      .select()
      .from(contactReachCases)
      .where(eq(contactReachCases.unlockId, unlockId))
      .limit(1);
    return rows[0];
  }

  /** Insert the case of one open; undefined when a case already exists for it (a race lost). */
  async insertCase(
    tx: Database,
    row: {
      unlockId: string;
      tenant: TenantKey;
      workerId: string | null;
      reportedBy: string;
      deadlineAt: Date;
    },
  ): Promise<ContactReachCaseRow | undefined> {
    const [inserted] = await tx
      .insert(contactReachCases)
      .values({
        unlockId: row.unlockId,
        payerId: row.tenant,
        workerId: row.workerId,
        reportedBy: row.reportedBy,
        deadlineAt: row.deadlineAt,
      })
      .onConflictDoNothing({ target: contactReachCases.unlockId })
      .returning();
    return inserted;
  }

  /** One case, locked for the rest of the transaction (the desk's close and the sweep). */
  async lockCase(tx: Database, caseId: string): Promise<ContactReachCaseRow | undefined> {
    const rows = await tx
      .select()
      .from(contactReachCases)
      .where(eq(contactReachCases.id, caseId))
      .for("update");
    return rows[0];
  }

  async getCase(caseId: string): Promise<ContactReachCaseRow | undefined> {
    const rows = await this.db
      .select()
      .from(contactReachCases)
      .where(eq(contactReachCases.id, caseId))
      .limit(1);
    return rows[0];
  }

  async listAttempts(caseId: string): Promise<ContactReachAttemptRow[]> {
    return this.db
      .select()
      .from(contactReachAttempts)
      .where(eq(contactReachAttempts.caseId, caseId))
      .orderBy(asc(contactReachAttempts.attemptedAt), asc(contactReachAttempts.id));
  }

  async insertAttempt(
    tx: Database,
    row: { caseId: string; adminId: string; result: ContactReachAttemptResult },
  ): Promise<ContactReachAttemptRow> {
    const [inserted] = await tx.insert(contactReachAttempts).values(row).returning();
    if (!inserted) throw new Error("contact_reach_attempts: the attempt was not written");
    return inserted;
  }

  /**
   * One page of the desk queue. Open cases come nearest deadline first (keyset on `deadline_at`,
   * `id`); closed and all cases newest report first (keyset on `reported_at`, `id`). The cursor's
   * `createdAt` carries whichever time the order uses.
   */
  async listCases(filter: {
    status: ReachCaseFilter;
    after: EntityCursor | null;
    limit: number;
  }): Promise<ReachCaseWithAttempts[]> {
    const open = filter.status === "open";
    const at = filter.after ? new Date(filter.after.createdAt) : null;
    const keyset =
      filter.after === null || at === null
        ? undefined
        : open
          ? or(
              gt(contactReachCases.deadlineAt, at),
              and(eq(contactReachCases.deadlineAt, at), gt(contactReachCases.id, filter.after.id)),
            )
          : or(
              lt(contactReachCases.reportedAt, at),
              and(eq(contactReachCases.reportedAt, at), lt(contactReachCases.id, filter.after.id)),
            );
    const rows = await this.db
      .select()
      .from(contactReachCases)
      .where(
        and(
          filter.status === "open"
            ? eq(contactReachCases.status, "open")
            : filter.status === "resolved"
              ? ne(contactReachCases.status, "open")
              : undefined,
          keyset,
        ),
      )
      .orderBy(
        ...(open
          ? [asc(contactReachCases.deadlineAt), asc(contactReachCases.id)]
          : [desc(contactReachCases.reportedAt), desc(contactReachCases.id)]),
      )
      .limit(filter.limit);
    const counts = await this.attemptCounts(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, attempts: counts.get(r.id) ?? 0 }));
  }

  async attemptCounts(caseIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (caseIds.length === 0) return out;
    const rows = await this.db
      .select({ caseId: contactReachAttempts.caseId, n: count() })
      .from(contactReachAttempts)
      .where(inArray(contactReachAttempts.caseId, [...caseIds]))
      .groupBy(contactReachAttempts.caseId);
    for (const r of rows) out.set(r.caseId, Number(r.n));
    return out;
  }

  /** Open cases whose deadline has passed, oldest first, at most `limit` (the sweep's batch). */
  async dueCaseIds(limit: number, now: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: contactReachCases.id })
      .from(contactReachCases)
      .where(and(eq(contactReachCases.status, "open"), lte(contactReachCases.deadlineAt, now)))
      .orderBy(asc(contactReachCases.deadlineAt), asc(contactReachCases.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * What the open took, lot by lot: its `unlock_debit` lines on the case's wallet, with each spent
   * lot's expiry. A free (waived) open has none. `walletKey` is the case row's stored `payer_id`
   * (written from a resolved tenant key when the company reported), never a caller's id.
   */
  async spentFromLots(tx: Database, walletKey: string, unlockId: string): Promise<SpentFromLot[]> {
    const rows = await tx
      .select({
        lotId: creditLedger.lotId,
        delta: creditLedger.delta,
        lotExpiresAt: creditLots.expiresAt,
      })
      .from(creditLedger)
      .leftJoin(creditLots, eq(creditLots.id, creditLedger.lotId))
      .where(
        and(
          eq(creditLedger.unlockId, unlockId),
          eq(creditLedger.payerId, walletKey),
          eq(creditLedger.reason, "unlock_debit"),
        ),
      )
      .orderBy(asc(creditLedger.createdAt), asc(creditLedger.id));
    return rows
      .filter((r) => r.delta < 0)
      .map((r) => ({ lotId: r.lotId, credits: -r.delta, lotExpiresAt: r.lotExpiresAt }));
  }

  /**
   * Give back the credits one spend took from one lot, as a new `returned` lot and ledger line
   * naming the open. Exactly once per (open, spent lot): `reach_returned:<unlock>:<lot>`.
   */
  async returnCredits(
    tx: Database,
    walletKey: string,
    unlockId: string,
    spent: SpentFromLot,
    expiresAt: Date | null,
  ): Promise<boolean> {
    const result = await grantCreditsWithinTx(tx, {
      payerId: walletKey,
      credits: spent.credits,
      lot: { source: "returned", expiresAt },
      ledger: {
        reason: "returned",
        unlockId,
        idempotencyKey: `reach_returned:${unlockId}:${spent.lotId ?? "none"}`,
      },
    });
    return result.applied;
  }

  /** Close an OPEN case; undefined when it was no longer open. */
  async resolve(
    tx: Database,
    caseId: string,
    close: {
      status: Exclude<ContactReachStatus, "open">;
      creditsReturned: number;
      resolvedBy: ContactReachResolvedBy;
      adminId: string | null;
      at: Date;
    },
  ): Promise<ContactReachCaseRow | undefined> {
    const [row] = await tx
      .update(contactReachCases)
      .set({
        status: close.status,
        creditsReturned: close.creditsReturned,
        resolvedAt: close.at,
        resolvedBy: close.resolvedBy,
        resolvedByAdminId: close.adminId,
      })
      .where(and(eq(contactReachCases.id, caseId), eq(contactReachCases.status, "open")))
      .returning();
    return row;
  }

  /** The desk's audit row, in the change's own transaction. */
  async audit(
    tx: Database,
    entry: { adminId: string; action: string; caseId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: entry.adminId,
      action: entry.action,
      entityType: "contact_reach_case",
      entityId: entry.caseId,
      metadata: entry.metadata,
    });
  }
}
