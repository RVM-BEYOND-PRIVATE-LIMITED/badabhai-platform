import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql as dsql, type SQL } from "drizzle-orm";
import {
  stillLookingChecks,
  workerAttributes,
  type Database,
  type StillLookingAnswer,
} from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/** An open (unanswered) check. */
export interface OpenCheck {
  readonly id: string;
  readonly promptedAt: Date;
}

/** A worker's most recent check, open or answered. */
export interface LatestCheck {
  readonly id: string;
  readonly answer: StillLookingAnswer | null;
  readonly answeredAt: Date | null;
}

/** One check the sweep opened. */
export interface OpenedCheck {
  readonly checkId: string;
  readonly workerId: string;
}

/**
 * WHO THE SWEEP ASKS (#2753 item 5) — the work list, as one statement, so a lost or duplicated tick
 * re-evaluates the same predicate:
 *  - `active` (a suspended worker is frozen; a pending one never finished sign-up), and not inside
 *    the ADR-0031 deletion grace window;
 *  - his LATEST `worker_consents` row is unrevoked (the `ConsentGuard` rule; `bool_and` over a tie
 *    on `accepted_at`, as the candidate-search pool reads it);
 *  - no OPEN check (an ignored card stays the one card: it is not re-pushed), and no check opened
 *    OR answered at or after `cutoff` (now minus STILL_LOOKING_EVERY_DAYS). Counting the answer
 *    time as well as the prompt time means a late answer to an old card restarts the month, so he
 *    is never asked again the day after he answered.
 *
 * INSERTED, NOT SELECTED-THEN-INSERTED: `ON CONFLICT … DO NOTHING` on the open-check unique index
 * (`still_looking_checks_open_uq`) is the cross-process guard. Two sweeps racing on one worker
 * insert one row; the loser's insert waits on the winner's and then does nothing, and only the
 * rows actually inserted come back (and get an event). Ordered by worker id and bounded by `limit`,
 * so a batch is one short transaction.
 *
 * `onlyWorkerIds` narrows the list to those workers (the DB gate, on a shared database); the daily
 * tick never passes it. Exported for the DB gate, which runs the same statement the sweep runs.
 */
export function openDueChecksStatement(
  now: Date,
  cutoff: Date,
  limit: number,
  onlyWorkerIds?: readonly string[],
): SQL {
  const only =
    onlyWorkerIds === undefined
      ? dsql``
      : dsql`
      AND w.id = ANY(${dsql.param([...onlyWorkerIds])}::uuid[])`;
  return dsql`
    INSERT INTO still_looking_checks (worker_id, prompted_at)
    SELECT w.id, ${now.toISOString()}::timestamptz
    FROM workers w
    WHERE w.status = 'active'
      AND w.deletion_scheduled_at IS NULL
      AND (
        SELECT bool_and(c.revoked_at IS NULL)
        FROM worker_consents c
        WHERE c.worker_id = w.id
          AND c.accepted_at = (
            SELECT max(c2.accepted_at) FROM worker_consents c2 WHERE c2.worker_id = w.id
          )
      ) IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM still_looking_checks s
        WHERE s.worker_id = w.id
          AND (
            s.answered_at IS NULL
            OR s.prompted_at >= ${cutoff.toISOString()}::timestamptz
            OR s.answered_at >= ${cutoff.toISOString()}::timestamptz
          )
      )${only}
    ORDER BY w.id
    LIMIT ${limit}
    ON CONFLICT (worker_id) WHERE answered_at IS NULL DO NOTHING
    RETURNING id, worker_id
  `;
}

/**
 * `still_looking_checks` (migration 0173, #2753 item 5) — DATABASE ACCESS ONLY. Whether the switch
 * is on, what an answer does and what is emitted are `StillLookingService`'s.
 *
 * NOTHING HERE MAY RUN WHILE `STILL_LOOKING_CHECK_ENABLED` IS OFF. 0173 is apply-before-the-switch:
 * the service and the route guard ask the switch first, which is what lets a build reach a
 * database without the table and fail no request.
 *
 * Every per-worker method is keyed on the id `WorkerAuthGuard` attached (or the sweep's own
 * insert), so no caller can reach another worker's check.
 */
@Injectable()
export class StillLookingRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `cb` inside one Drizzle transaction; the `tx` it gets is a `Database`-shaped executor. */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * Serialise this worker's answers for the rest of the transaction. Two taps racing with no check
   * open would otherwise both see "none open" and both insert an answered row; the open-check index
   * cannot catch that (neither row is open). Keyed on the worker alone, namespaced.
   */
  async lockWorker(workerId: string, tx: Database): Promise<void> {
    const key = `still_looking:${workerId.toLowerCase()}`;
    await tx.execute(dsql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  /** His open check, or null. `forUpdate` locks it for the rest of the caller's transaction. */
  async findOpen(
    workerId: string,
    tx: Database = this.db,
    opts: { forUpdate?: boolean } = {},
  ): Promise<OpenCheck | null> {
    const query = tx
      .select({ id: stillLookingChecks.id, promptedAt: stillLookingChecks.promptedAt })
      .from(stillLookingChecks)
      .where(and(eq(stillLookingChecks.workerId, workerId), isNull(stillLookingChecks.answeredAt)))
      .limit(1);
    const [row] = opts.forUpdate ? await query.for("update") : await query;
    return row ?? null;
  }

  /**
   * His most recent check — by when it was last touched (answered, else opened), newest first — or
   * null when he has never had one. The repeat rule reads it: the same answer again, inside the
   * window, is a no-op.
   */
  async findLatest(workerId: string, tx: Database = this.db): Promise<LatestCheck | null> {
    const [row] = await tx
      .select({
        id: stillLookingChecks.id,
        answer: stillLookingChecks.answer,
        answeredAt: stillLookingChecks.answeredAt,
      })
      .from(stillLookingChecks)
      .where(eq(stillLookingChecks.workerId, workerId))
      .orderBy(
        desc(dsql`coalesce(${stillLookingChecks.answeredAt}, ${stillLookingChecks.promptedAt})`),
        desc(stillLookingChecks.createdAt),
        desc(stillLookingChecks.id),
      )
      .limit(1);
    return row ?? null;
  }

  /** Answer an open check. True when it was open (the caller holds its lock from `findOpen`). */
  async answerOpen(
    checkId: string,
    answer: StillLookingAnswer,
    at: Date,
    tx: Database,
  ): Promise<boolean> {
    const updated = await tx
      .update(stillLookingChecks)
      .set({ answer, answeredAt: at })
      .where(and(eq(stillLookingChecks.id, checkId), isNull(stillLookingChecks.answeredAt)))
      .returning({ id: stillLookingChecks.id });
    return updated.length > 0;
  }

  /** No check open (an answer from Settings): open and answer one row at once. */
  async insertAnswered(
    workerId: string,
    answer: StillLookingAnswer,
    at: Date,
    tx: Database,
  ): Promise<string> {
    const [row] = await tx
      .insert(stillLookingChecks)
      .values({ workerId, promptedAt: at, answeredAt: at, answer })
      .returning({ id: stillLookingChecks.id });
    return row!.id;
  }

  /** One sweep batch: open a check for up to `limit` due workers. See {@link openDueChecksStatement}. */
  async openDue(
    now: Date,
    cutoff: Date,
    limit: number,
    tx: Database,
    onlyWorkerIds?: readonly string[],
  ): Promise<OpenedCheck[]> {
    const rows = await tx.execute<{ id: string; worker_id: string }>(
      openDueChecksStatement(now, cutoff, limit, onlyWorkerIds),
    );
    return [...(rows as unknown as Array<{ id: string; worker_id: string }>)].map((r) => ({
      checkId: String(r.id),
      workerId: String(r.worker_id),
    }));
  }

  /**
   * His own availability answer (`worker_attributes.availability`, the json the work-preferences
   * PUT writes), or null when he never gave one. The model's interview status is NOT read: it is a
   * guess, which is exactly what the card should ask again.
   */
  async availabilityAnswer(workerId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db
      .select({ valueJson: workerAttributes.valueJson })
      .from(workerAttributes)
      .where(
        and(
          eq(workerAttributes.workerId, workerId),
          eq(workerAttributes.attributeKey, "availability"),
        ),
      )
      .limit(1);
    return row?.valueJson ?? null;
  }
}
