import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  type Database,
  platformAiCostTotals,
  sessionAiCostTotals,
  workerAiCostTotals,
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
 * ONE METHOD, AND IT ONLY EVER ADDS. There is no decrement, no set, and no delete: spend is
 * monotonic, the CHECK constraints on all three tables say so, and a repository that could
 * subtract would be a repository someone could use to make a number look better.
 *
 * ALWAYS RUNS ON A CALLER-SUPPLIED TRANSACTION. The `tx` parameter is required, not optional,
 * because on the success path these numbers move in the SAME commit as the `ai.cost_recorded`
 * row they are derived from. An overload that opened its own transaction would make the
 * drifting version the easy one to call. (The recorder runs this inside a {@link
 * AiCostTotalsRepository.withSavepoint} so that a FAILED accrual costs only the accrual — see
 * `AiCostRecorder.record`. Success is atomic with the event; failure degrades to "the totals
 * trail the spine", never to "the ledger row was destroyed".)
 *
 * NO BUSINESS LOGIC HERE (CLAUDE.md §4): the decision of WHETHER to accrue — only when the
 * event row was actually inserted, never on a deduplicated redelivery — belongs to
 * `AiCostRecorder`, which owns the exactly-once rule. This layer writes what it is told.
 */
@Injectable()
export class AiCostTotalsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Add one call's spend to every total that has an owner.
   *
   * THREE UPSERTS AT MOST, and each is skipped when its subject is absent — a payer-side
   * embed touches only the platform row, and inventing a worker for it would be worse than
   * counting it platform-wide alone.
   *
   * `INSERT ... ON CONFLICT DO UPDATE` rather than read-then-write: the read-modify-write
   * version loses concurrent increments unless every reader takes a row lock first, and the
   * lost update is silent. Postgres applies the `excluded` arithmetic under the row lock the
   * conflict already takes, so N concurrent calls produce N increments with no coordination.
   *
   * `first_recorded_at` is deliberately NOT in the update set — it is the insert's value
   * forever, which is what makes "cost since we first saw this worker" answerable.
   */
  async accrue(input: AiCostAccrual, tx: Database): Promise<void> {
    const { workerId, sessionId, provider, taskType, costInr, realCall } = input;
    const realDelta = realCall ? 1 : 0;
    // Bound to a string in the same shape the column stores. `numeric` is exact; handing it a
    // JS float's decimal expansion here is the LAST place the value is a float, and every
    // addition after it happens in Postgres.
    const cost = costInr.toString();

    if (workerId !== null) {
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
    }

    // A SESSION TOTAL NEEDS BOTH IDS. `session_ai_cost_totals.worker_id` is NOT NULL — it is
    // the second cascade path to DSAR erasure — so a session with no worker cannot be
    // recorded. That combination does not occur (every profiling session belongs to a
    // worker), and refusing to invent one is the fail-closed reading.
    if (sessionId !== null && workerId !== null) {
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

    // UNCONDITIONAL — this is the row that makes the platform figure complete. Payer-side
    // spend (`skill_embedding` on a posting write, `job_posting_chat_turn`) has no worker and
    // no session, and it is exactly the spend a worker-derived total would silently omit.
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
