import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { unlockOutcomes, unlocks, workers, type Database } from "@badabhai/db";
import type { UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { DueCursor } from "./unlock-outcomes.dto";

/**
 * The unlock statuses of an OPENED contact: granted, revealed, or lapsed after either. Never a
 * `requested` attempt or a `denied` one — those opened nothing, so there is nothing to follow up.
 */
export const OPENED_UNLOCK_STATUSES = ["granted", "revealed", "expired"] as const;

/** One opened contact, read for an answer: who owns it, who it opened, and its job context. */
export interface OpenedUnlock {
  readonly unlockId: string;
  /** `unlocks.payer_id` — the tenant key the unlock writer stored (ADR-0053). */
  readonly tenantPayerId: string;
  readonly workerId: string;
  /** Agency `jobs` context, or null. At most one of the two is set (#2033). */
  readonly jobId: string | null;
  /** Company `job_postings` context, or null. */
  readonly jobPostingId: string | null;
}

/** The stored answer of one unlock, locked for the rest of the transaction. */
export interface HeldOutcome {
  readonly outcome: UnlockOutcome;
  readonly answeredBy: UnlockOutcomeAnswerer;
  readonly answeredAt: Date;
}

/** The answer to store. */
export interface OutcomeAnswer {
  readonly outcome: UnlockOutcome;
  readonly answeredBy: UnlockOutcomeAnswerer;
  readonly answeredAt: Date;
}

/** One row of the due list. */
export interface DueRow {
  readonly unlockId: string;
  readonly workerId: string;
  readonly grantedAt: Date;
  /** `granted_at` as Postgres's microsecond UTC text: the keyset position (a Date truncates). */
  readonly grantedKey: string;
  readonly outcome: UnlockOutcome | null;
}

const OPENED_COLUMNS = {
  unlockId: unlocks.id,
  tenantPayerId: unlocks.payerId,
  workerId: unlocks.workerId,
  jobId: unlocks.jobId,
  jobPostingId: unlocks.jobPostingId,
} as const;

/** An opened contact whose worker still exists (erasure SET-NULLs `worker_id`). */
const OPENED: SQL = and(
  inArray(unlocks.status, [...OPENED_UNLOCK_STATUSES]),
  isNotNull(unlocks.grantedAt),
  isNotNull(unlocks.workerId),
)!;

/**
 * `unlock_outcomes` (#2753 item 10), and the reads of `unlocks` the follow-up needs — this
 * module's OWN queries, so nothing under `unlocks/` changes. Rows only: the rules are
 * `unlock-outcome-rules.ts`'s and the service decides when to call. Every write runs on the
 * caller's transaction.
 */
@Injectable()
export class UnlockOutcomesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx as unknown as Database));
  }

  /**
   * THE OWNERSHIP CHOKEPOINT for the company's answer: the unlock is this TENANT's (`payer_id`
   * equals the key the session resolved to — the comparison the reveal and the contact read make)
   * and an opened contact whose worker still exists. Anything else — unknown, another company's,
   * never opened, erased — is `null`, and the caller answers the one neutral 404.
   */
  async findOwnedOpened(
    unlockId: string,
    tenant: TenantKey,
    tx: Database,
  ): Promise<OpenedUnlock | null> {
    const [row] = await tx
      .select(OPENED_COLUMNS)
      .from(unlocks)
      .where(and(eq(unlocks.id, unlockId), eq(unlocks.payerId, tenant), OPENED))
      .limit(1);
    return row ? withWorker(row) : null;
  }

  /**
   * The desk's read (#2750): the same opened-contact rule with no company predicate — the desk
   * acts for whichever company holds it. `null` when it is not an opened contact or he was erased.
   */
  async findOpened(unlockId: string, tx: Database): Promise<OpenedUnlock | null> {
    const [row] = await tx
      .select(OPENED_COLUMNS)
      .from(unlocks)
      .where(and(eq(unlocks.id, unlockId), OPENED))
      .limit(1);
    return row ? withWorker(row) : null;
  }

  /** The stored answer for `unlockId`, locked for the rest of the transaction; `null` when none. */
  async lockOutcome(unlockId: string, tx: Database): Promise<HeldOutcome | null> {
    const [row] = await tx
      .select({
        outcome: unlockOutcomes.outcome,
        answeredBy: unlockOutcomes.answeredBy,
        answeredAt: unlockOutcomes.answeredAt,
      })
      .from(unlockOutcomes)
      .where(eq(unlockOutcomes.unlockId, unlockId))
      .limit(1)
      .for("update");
    return row ?? null;
  }

  /**
   * The FIRST answer for an unlock. `false` when a row already exists — one a concurrent
   * transaction committed after {@link lockOutcome} saw none (the insert waited on it).
   */
  async insertOutcome(unlock: OpenedUnlock, answer: OutcomeAnswer, tx: Database): Promise<boolean> {
    const rows = await tx
      .insert(unlockOutcomes)
      .values({
        unlockId: unlock.unlockId,
        tenantPayerId: unlock.tenantPayerId,
        workerId: unlock.workerId,
        outcome: answer.outcome,
        answeredBy: answer.answeredBy,
        answeredAt: answer.answeredAt,
        updatedAt: answer.answeredAt,
      })
      .onConflictDoNothing({ target: unlockOutcomes.unlockId })
      .returning({ unlockId: unlockOutcomes.unlockId });
    return rows.length > 0;
  }

  /** Replace the stored answer. The caller holds the row lock from {@link lockOutcome}. */
  async updateOutcome(unlockId: string, answer: OutcomeAnswer, tx: Database): Promise<void> {
    await tx
      .update(unlockOutcomes)
      .set({
        outcome: answer.outcome,
        answeredBy: answer.answeredBy,
        answeredAt: answer.answeredAt,
        updatedAt: answer.answeredAt,
      })
      .where(eq(unlockOutcomes.unlockId, unlockId));
  }

  /**
   * One page of the tenant's DUE contacts — `isFollowupDue` as SQL, over the same `cutoff`:
   *  - the tenant's opened contact (`payer_id`, an opened status) granted at or before `cutoff`;
   *  - its worker exists and is not frozen on payer surfaces (a pending deletion or a suspension,
   *    ADR-0031 / #2562 — the applicant lists' rule); an erased worker's unlock has no worker_id;
   *  - no answer, or `still_talking` answered at or before `cutoff`.
   * Oldest grant first, keyset on `(granted_at, id)`. `limit` is the page size plus one.
   */
  async listDue(
    tenant: TenantKey,
    cutoff: Date,
    after: DueCursor | null,
    limit: number,
  ): Promise<DueRow[]> {
    const clauses: SQL[] = [
      eq(unlocks.payerId, tenant),
      OPENED,
      lte(unlocks.grantedAt, cutoff),
      isNull(workers.deletionScheduledAt),
      ne(workers.status, "suspended"),
      or(
        isNull(unlockOutcomes.unlockId),
        and(eq(unlockOutcomes.outcome, "still_talking"), lte(unlockOutcomes.answeredAt, cutoff)),
      )!,
    ];
    if (after !== null) {
      // Microsecond TEXT, never a JS Date (which truncates to milliseconds): two grants inside one
      // millisecond would otherwise be skipped or repeated at a page boundary (the inbox's rule).
      clauses.push(
        sql`(${unlocks.grantedAt}, ${unlocks.id}) > (${after.grantedKey}::timestamptz, ${after.unlockId}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        unlockId: unlocks.id,
        workerId: workers.id,
        grantedAt: unlocks.grantedAt,
        grantedKey: sql<string>`to_char(${unlocks.grantedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        outcome: unlockOutcomes.outcome,
      })
      .from(unlocks)
      .innerJoin(workers, eq(workers.id, unlocks.workerId))
      .leftJoin(unlockOutcomes, eq(unlockOutcomes.unlockId, unlocks.id))
      .where(and(...clauses))
      .orderBy(asc(unlocks.grantedAt), asc(unlocks.id))
      .limit(limit);
    // `granted_at IS NOT NULL` is in the WHERE; the column type does not know it.
    return rows.flatMap((r) => (r.grantedAt === null ? [] : [{ ...r, grantedAt: r.grantedAt }]));
  }
}

/** Narrow the nullable `worker_id` the WHERE already excluded. */
function withWorker(row: {
  unlockId: string;
  tenantPayerId: string;
  workerId: string | null;
  jobId: string | null;
  jobPostingId: string | null;
}): OpenedUnlock | null {
  return row.workerId === null ? null : { ...row, workerId: row.workerId };
}
