import type { Database } from "@badabhai/db";

import type { AiCostAccrual, AiCostTotalsRepository } from "./ai-cost-totals.repository";

/**
 * An in-memory `AiCostTotalsRepository` for unit tests, shaped like the real one in the two
 * ways that matter to a caller: `withTransaction` runs the work and propagates a throw (so an
 * "the accrual failed, does the event roll back?" test is expressible), and `accrue` records
 * exactly what it was handed.
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
  /** Set to make the next accrual throw — the rollback path. */
  failNext: boolean;
  /** Pass this where an `AiCostTotalsRepository` is expected. */
  readonly repo: AiCostTotalsRepository;
}

/** A sentinel `Database` handle. Nothing dereferences it; identity is all that is asserted. */
export const FAKE_TX = { __fakeTx: true } as unknown as Database;

export function fakeAiCostTotals(): FakeAiCostTotals {
  const accrued: AiCostAccrual[] = [];
  const state = {
    accrued,
    transactions: 0,
    failNext: false,
    repo: {
      async withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
        state.transactions += 1;
        return work(FAKE_TX);
      },
      async accrue(input: AiCostAccrual, tx: Database): Promise<void> {
        if (tx !== FAKE_TX) {
          // The whole atomicity guarantee is that the accrual rides the SAME handle the event
          // insert did. A recorder that opened its own would pass every count assertion.
          throw new Error("accrue was called off the transaction it was given");
        }
        if (state.failNext) throw new Error("totals write failed");
        accrued.push(input);
      },
    } as unknown as AiCostTotalsRepository,
  };
  return state;
}
