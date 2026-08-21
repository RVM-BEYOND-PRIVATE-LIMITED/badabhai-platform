import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { AICallMetadata } from "@badabhai/ai-contracts";

import type { EventsService } from "../events/events.service";
import type { AiCostTotalsRepository } from "./ai-cost-totals.repository";
import { AiCostRecorder } from "./ai-cost-recorder.service";

/**
 * THE ONE ASYMMETRY THAT MATTERS: a failed running-total must never destroy the
 * `ai.cost_recorded` ledger row it was derived from.
 *
 * WHY A STAGING HARNESS AND NOT THE SHARED FAKE. `ai-cost-totals.fake.ts` can prove WHICH handle
 * the accrual rode; it cannot prove what SURVIVES, because surviving is a property of Postgres
 * transaction semantics. Two of those semantics are load-bearing here and both are modelled
 * below, because without them the test passes for the wrong reason:
 *
 *   1. ANY ERROR ABORTS THE WHOLE TRANSACTION (`25P02`). A JavaScript `catch` does not heal it —
 *      the connection stays in the failed state and the eventual `COMMIT` is executed as a
 *      `ROLLBACK`. So "wrap `accrue` in a try/catch" is NOT a fix, and a harness that let a
 *      caught error commit anyway would happily bless it.
 *   2. `ROLLBACK TO SAVEPOINT` UNDOES BOTH — the work AND the abort — which is exactly why the
 *      savepoint IS the fix.
 *
 * The staged world is committed to the canonical world only if the callback resolves AND the
 * transaction was never poisoned; this mirrors `admin-actions.atomicity.test.ts`, plus the abort
 * flag that file has no reason to model.
 *
 * THE DEFECT THIS LOCKS, CONCRETELY. Before the savepoint, three reachable triggers —
 * `platform_ai_cost_totals` missing because 0077 had not applied yet, an FK violation from a
 * queued job outliving a DSAR-erased worker, and lock contention on the hot platform row — each
 * silently deleted the cost event on its way out, through a `logger.warn` and a 200.
 */

const CALL_ID = "55555555-5555-4555-8555-555555555555";
const WORKER = "11111111-1111-4111-8111-111111111111";
const CORRELATION = "44444444-4444-4444-8444-444444444444";

const META: AICallMetadata = {
  ai_call_id: CALL_ID,
  task_type: "profiling_chat_turn",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 897,
  output_tokens: 112,
  estimated_cost_inr: 0.157,
  latency_ms: 2863,
  success: true,
  error_code: null,
  failure_reason: null,
  cost_alert: false,
  above_target: false,
  created_at: "2026-08-18T05:04:02.270Z",
} as unknown as AICallMetadata;

/** What is durably stored: the event spine, and the totals derived from it. */
interface World {
  events: string[];
  totals: string[];
}

/** One in-flight transaction: its uncommitted world, and whether Postgres has aborted it. */
interface Tx {
  world: World;
  aborted: boolean;
}

/**
 * @param failAccrual make the totals write throw — and poison the transaction on its way out,
 * which is what Postgres does for a missing relation, an FK violation and a lock timeout alike.
 */
function makeHarness(opts: { failAccrual?: boolean } = {}) {
  const committed: World = { events: [], totals: [] };
  const arm = { fail: opts.failAccrual ?? false };

  const totals = {
    async withTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const tx: Tx = { world: { events: [], totals: [] }, aborted: false };
      tx.world.events = [...committed.events];
      tx.world.totals = [...committed.totals];
      const result = await work(tx); // throws → the staged world is discarded (ROLLBACK)
      // COMMIT ON AN ABORTED TRANSACTION IS A ROLLBACK. This line is the whole reason a
      // try/catch around `accrue` is not a fix.
      if (tx.aborted) return result;
      committed.events = tx.world.events;
      committed.totals = tx.world.totals;
      return result;
    },
    async withSavepoint<T>(tx: unknown, work: (sp: unknown) => Promise<T>): Promise<T> {
      const t = tx as Tx;
      const snapshot: World = { events: [...t.world.events], totals: [...t.world.totals] };
      const abortedBefore = t.aborted;
      try {
        return await work(t);
      } catch (err) {
        // ROLLBACK TO SAVEPOINT: the work is undone and the transaction is USABLE again.
        t.world = snapshot;
        t.aborted = abortedBefore;
        throw err;
      }
    },
    async accrue(input: { workerId: string | null }, tx: unknown): Promise<void> {
      const t = tx as Tx;
      if (t.aborted) throw new Error("current transaction is aborted (25P02)");
      if (arm.fail) {
        t.aborted = true;
        throw new Error('relation "platform_ai_cost_totals" does not exist');
      }
      t.world.totals.push(input.workerId ?? "(unattributed)");
    },
  } as unknown as AiCostTotalsRepository;

  const events = {
    async emitOnce(params: { payload: { ai_call_id: string }; tx: unknown }) {
      const t = params.tx as Tx;
      if (t.aborted) throw new Error("current transaction is aborted (25P02)");
      t.world.events.push(params.payload.ai_call_id);
      return { event: params, written: true };
    },
  } as unknown as EventsService;

  return { rec: new AiCostRecorder(events, totals), committed, arm };
}

describe("AiCostRecorder atomicity — the ledger row outranks the total derived from it", () => {
  it("a FAILED accrual still commits the ai.cost_recorded event", async () => {
    const h = makeHarness({ failAccrual: true });

    await expect(
      h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", { workerId: WORKER }),
    ).resolves.toBeUndefined();

    // THE EVENT SURVIVED. Without the savepoint the aborted transaction takes it with it, and
    // the only trace of the money is a warn line — there is nothing left to back-fill FROM.
    expect(h.committed.events).toEqual([CALL_ID]);
    // …and the total did not move, which is the recoverable half: a backfill over
    // `events WHERE event_name = 'ai.cost_recorded'` rebuilds it exactly.
    expect(h.committed.totals).toEqual([]);
  });

  it("a SUCCESSFUL accrual commits both together — the total cannot outrun its ledger row", async () => {
    const h = makeHarness();

    await h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });

    expect(h.committed.events).toEqual([CALL_ID]);
    expect(h.committed.totals).toEqual([WORKER]);
  });

  it("a transient totals failure costs ONE call's total and nothing else", async () => {
    // The deploy-ordering and lock-contention triggers are both transient by nature: 0077
    // applies, or the lock clears. The degraded state must therefore be per-call, and every
    // event must land either way — that is what keeps the spine a complete ledger and the
    // totals merely behind.
    const h = makeHarness({ failAccrual: true });
    await h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });

    h.arm.fail = false;
    const SECOND = "66666666-6666-4666-8666-666666666666";
    await h.rec.record(
      { ...META, ai_call_id: SECOND },
      "profiling_chat_turn",
      null,
      CORRELATION,
      "req-2",
      { workerId: WORKER },
    );

    expect(h.committed.events).toEqual([CALL_ID, SECOND]);
    expect(h.committed.totals).toEqual([WORKER]);
  });
});
