import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  type Database,
  platformAiCostTotals,
  sessionAiCostTotals,
  workerAiCostTotals,
  workers,
} from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/** One call's contribution to the running totals. PII-free: ids, ₹, counts and two labels. */
export interface AiCostAccrual {
  /** Whose spend this is, or null for payer-side / unattributed calls. */
  readonly workerId: string | null;
  /** Which profiling session it belongs to, or null when there is no interview behind it. */
  readonly sessionId: string | null;
  /** `AICallMetadata.provider`, already defaulted to `'unknown'` by the caller. */
  readonly provider: string;
  /** The closed-set `aiTaskType` the cost event was labelled with. */
  readonly taskType: string;
  /** `AICallMetadata.estimated_cost_inr` — non-negative by the payload's own schema. */
  readonly costInr: number;
  /** Did money actually move, or was this the mock posture? */
  readonly realCall: boolean;
}

/**
 * The running totals `ai.cost_recorded` is materialized into (migration 0077).
 *
 * TWO WRITE METHODS, AND THE SPLIT IS THE POINT. `platform_ai_cost_totals` has NO worker
 * foreign key and must be written for every call — including a call whose worker was deleted
 * mid-flight. `worker_ai_cost_totals` and `session_ai_cost_totals` DO have one, so they can fail
 * with 23503 when their subject is gone. They used to share one savepoint, which meant that
 * failure rolled the platform total back too and the headline lost a call the ledger had
 * recorded. The recorder now calls {@link accruePlatform} first and {@link accrueOwned} second,
 * each in its OWN savepoint: a missing worker costs the worker/session rows and nothing else.
 *
 * NEITHER METHOD DECIDES WHEN TO DEGRADE (CLAUDE.md §4). They write what they are told and let
 * the error out. `AiCostRecorder` owns the exactly-once rule, the ordering, and the catch that
 * turns a failed leg into a warning while the `ai.cost_recorded` row commits.
 *
 * ONLY EVER ADDS. There is no decrement, no set, and no delete: spend is monotonic, the CHECK
 * constraints on all three tables say so, and a repository that could subtract would be a
 * repository someone could use to make a number look better.
 */
@Injectable()
export class AiCostTotalsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Add one call's spend to the PLATFORM running total — the unconditional leg.
   *
   * NO FK, NO OWNER, ALWAYS WRITABLE. This is the row that makes the platform figure complete:
   * payer-side spend (`skill_embedding` on a posting write, `job_posting_chat_turn`) has no
   * worker and no session, and a call whose worker was deleted mid-flight still spent money.
   * The recorder calls this FIRST, in its own savepoint, precisely so a later worker/session
   * failure cannot undo it.
   *
   * `INSERT ... ON CONFLICT DO UPDATE` rather than read-then-write: the read-modify-write
   * version loses concurrent increments unless every reader takes a row lock first, and the
   * lost update is silent. Postgres applies the `excluded` arithmetic under the row lock the
   * conflict already takes, so N concurrent calls produce N increments with no coordination.
   *
   * `first_recorded_at` is deliberately NOT in the update set — it is the insert's value
   * forever, which is what makes "spend since this task type first accrued" answerable.
   */
  async accruePlatform(input: AiCostAccrual, tx: Database): Promise<void> {
    const { provider, taskType, costInr, realCall } = input;
    const realDelta = realCall ? 1 : 0;
    // Bound to a string in the same shape the column stores. `numeric` is exact; handing it a
    // JS float's decimal expansion here is the LAST place the value is a float, and every
    // addition after it happens in Postgres.
    const cost = costInr.toString();

    await tx
      .insert(platformAiCostTotals)
      .values({
        provider,
        taskType,
        totalCostInr: cost,
        callCount: 1,
        realCallCount: realDelta,
      })
      .onConflictDoUpdate({
        target: [platformAiCostTotals.provider, platformAiCostTotals.taskType],
        set: {
          totalCostInr: sql`${platformAiCostTotals.totalCostInr} + ${cost}::numeric`,
          callCount: sql`${platformAiCostTotals.callCount} + 1`,
          realCallCount: sql`${platformAiCostTotals.realCallCount} + ${realDelta}`,
          updatedAt: sql`now()`,
        },
      });
  }

  /**
   * Add one call's spend to the WORKER and SESSION running totals — the owned legs.
   *
   * BOTH ARE FK-BOUND and can legitimately fail with 23503 when a queued job outlives its
   * subject. That is why the recorder runs this in a SEPARATE savepoint from {@link
   * accruePlatform}: the failure costs these rows, never the platform total.
   *
   * A payer-side call has neither owner and this is a no-op. A session without a worker cannot
   * be recorded — `session_ai_cost_totals.worker_id` is NOT NULL, the second cascade path to
   * DSAR erasure — and refusing to invent one is the fail-closed reading.
   */
  async accrueOwned(input: AiCostAccrual, tx: Database): Promise<void> {
    const { workerId, sessionId, costInr, realCall } = input;
    if (workerId === null) return;
    const realDelta = realCall ? 1 : 0;
    const cost = costInr.toString();

    await tx
      .insert(workerAiCostTotals)
      .values({
        workerId,
        totalCostInr: cost,
        callCount: 1,
        realCallCount: realDelta,
      })
      .onConflictDoUpdate({
        target: workerAiCostTotals.workerId,
        set: {
          totalCostInr: sql`${workerAiCostTotals.totalCostInr} + ${cost}::numeric`,
          callCount: sql`${workerAiCostTotals.callCount} + 1`,
          realCallCount: sql`${workerAiCostTotals.realCallCount} + ${realDelta}`,
          updatedAt: sql`now()`,
        },
      });

    if (sessionId === null) return;

    await tx
      .insert(sessionAiCostTotals)
      .values({
        chatSessionId: sessionId,
        workerId,
        totalCostInr: cost,
        callCount: 1,
        realCallCount: realDelta,
      })
      .onConflictDoUpdate({
        target: sessionAiCostTotals.chatSessionId,
        set: {
          totalCostInr: sql`${sessionAiCostTotals.totalCostInr} + ${cost}::numeric`,
          callCount: sql`${sessionAiCostTotals.callCount} + 1`,
          realCallCount: sql`${sessionAiCostTotals.realCallCount} + ${realDelta}`,
          updatedAt: sql`now()`,
        },
      });
  }

  /**
   * The worker's test flag AS OF NOW, for stamping onto the cost event (B2 #2555).
   *
   * A READ, not a policy: returns the flag, or null when the worker row is gone
   * (deleted mid-call — the event then reads exactly like a v1 row, falling back to
   * the live join, which also finds nothing). The recorder treats a THROWN lookup the
   * same as a missing row — null — because a flag read must never fail the spend it
   * annotates; the event still commits, only the stamp is lost.
   */
  async isTestAccount(workerId: string, tx: Database): Promise<boolean | null> {
    const rows = await tx
      .select({ isTestAccount: workers.isTestAccount })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return rows[0]?.isTestAccount ?? null;
  }

  /**
   * Open a transaction for a caller that has none. Mirrors `AdminActionsRepository`'s
   * `withTransaction` seam — the cast is drizzle's transaction-callback parameter type, which
   * is structurally a `Database` but not nominally one.
   */
  async withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * Run `work` inside a SAVEPOINT on an ALREADY-OPEN transaction, so a failure inside it
   * rolls back only what `work` did and leaves the enclosing transaction committable.
   *
   * WHY THIS EXISTS AND WHY IT IS HERE. In Postgres ANY error aborts the whole transaction —
   * catching it in JavaScript does not heal it, the connection stays in `25P02` and the eventual
   * `COMMIT` silently becomes a `ROLLBACK`. So a caller that wants "the ledger row commits even
   * if its materialization fails" cannot get it with a try/catch; it needs a savepoint. Drizzle
   * spells that as a nested `transaction()` on a transaction handle (`SAVEPOINT sp1` /
   * `ROLLBACK TO SAVEPOINT sp1`), which is knowledge about how a `Database` handle behaves —
   * i.e. this layer's, not the recorder's.
   *
   * NO POLICY HERE (CLAUDE.md §4). This method decides nothing about WHEN degrading is
   * acceptable; it only makes degrading expressible. `AiCostRecorder` owns the rule that a
   * totals failure must not take the `ai.cost_recorded` row down with it.
   */
  async withSavepoint<T>(tx: Database, work: (sp: Database) => Promise<T>): Promise<T> {
    return tx.transaction(work as (sp: unknown) => Promise<T>);
  }
}
