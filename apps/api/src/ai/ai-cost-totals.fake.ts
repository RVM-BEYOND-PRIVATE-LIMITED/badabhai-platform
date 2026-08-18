import type { Database } from "@badabhai/db";

import type { AiCostAccrual, AiCostTotalsRepository } from "./ai-cost-totals.repository";

/**
 * An in-memory `AiCostTotalsRepository` for unit tests, shaped like the real one in the three
 * ways that matter to a caller: `withTransaction` runs the work and propagates a throw,
 * `withSavepoint` proves the accrual was nested on that transaction rather than run bare on it,
 * and `accrue` records exactly what it was handed.
 *
 * IT DOES NOT MODEL COMMIT/ROLLBACK. Whether the `ai.cost_recorded` row survives a failed
 * accrual is a property of Postgres transaction semantics, and asserting it needs a harness that
 * models an aborted transaction — see `ai-cost-recorder.atomicity.test.ts`, which does, and the
 * DB suite, which uses a real one.
 *
 * NOT A NO-OP STUB. `AiCostRecorder` swallows every failure by design, so a stub that quietly
 * accepted anything would let a recorder that accrues nothing — or accrues on a deduplicated
 * redelivery — pass every test in the suite. The `accrued` array is the assertion surface.
 *
 * Lives in `src/` beside its subject rather than in a test file so the three suites that build
 * a real `AiCostRecorder` share ONE fake and cannot drift into three slightly different ones.
 */
export interface FakeAiCostTotals {
  /** Every accrual the recorder asked for, in order. */
  readonly accrued: AiCostAccrual[];
  /** How many transactions were opened (an emit that never ran opens none). */
  transactions: number;
  /** How many savepoints were opened on those transactions. */
  savepoints: number;
  /** Set to make the next accrual throw — the degraded path. */
  failNext: boolean;
  /** Pass this where an `AiCostTotalsRepository` is expected. */
  readonly repo: AiCostTotalsRepository;
}

/** A sentinel `Database` handle. Nothing dereferences it; identity is all that is asserted. */
export const FAKE_TX = { __fakeTx: true } as unknown as Database;

/**
 * The sentinel the fake `withSavepoint` hands its callback — a DIFFERENT object from
 * {@link FAKE_TX} on purpose, so "the accrual rode the savepoint" and "the accrual rode the
 * bare transaction" are distinguishable rather than both satisfying one identity check.
 */
export const FAKE_SP = { __fakeSavepoint: true } as unknown as Database;

export function fakeAiCostTotals(): FakeAiCostTotals {
  const accrued: AiCostAccrual[] = [];
  const state = {
    accrued,
    transactions: 0,
    savepoints: 0,
    failNext: false,
    repo: {
      async withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
        state.transactions += 1;
        return work(FAKE_TX);
      },
      async withSavepoint<T>(tx: Database, work: (sp: Database) => Promise<T>): Promise<T> {
        if (tx !== FAKE_TX) {
          // A savepoint on some other handle is not a savepoint on the event's transaction.
          throw new Error("withSavepoint was called off the transaction it was given");
        }
        state.savepoints += 1;
        return work(FAKE_SP);
      },
      async accrue(input: AiCostAccrual, tx: Database): Promise<void> {
        if (tx !== FAKE_SP) {
          // The accrual must ride a SAVEPOINT opened on the handle the event insert used.
          // Handed `FAKE_TX` it would still be inside the right transaction — but a failure
          // there aborts that transaction and takes the `ai.cost_recorded` row with it, which
          // is precisely the defect the savepoint exists to prevent.
          throw new Error("accrue was called off the savepoint it was given");
        }
        if (state.failNext) throw new Error("totals write failed");
        accrued.push(input);
      },
    } as unknown as AiCostTotalsRepository,
  };
  return state;
}
