import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { AICallMetadata } from "@badabhai/ai-contracts";

import type { EventsService } from "../events/events.service";
import type { AiCostTotalsRepository } from "./ai-cost-totals.repository";
import { AiCostRecorder } from "./ai-cost-recorder.service";

/**
 * THE ASYMMETRY THAT MATTERS: a failed derived total must never destroy the
 * `ai.cost_recorded` ledger row it was derived from — and a failed OWNED total must never
 * destroy the PLATFORM total, which carries no foreign key and must count every call.
 *
 * WHY A STAGING HARNESS AND NOT THE SHARED FAKE. `ai-cost-totals.fake.ts` can prove WHICH handle
 * each write rode and in what order; it cannot prove what SURVIVES, because surviving is a
 * property of Postgres transaction semantics. Two of those semantics are load-bearing here and
 * both are modelled below, because without them the test passes for the wrong reason:
 *
 *   1. ANY ERROR ABORTS THE WHOLE TRANSACTION (`25P02`). A JavaScript `catch` does not heal it —
 *      the connection stays in the failed state and the eventual `COMMIT` is executed as a
 *      `ROLLBACK`. So "wrap the write in a try/catch" is NOT a fix, and a harness that let a
 *      caught error commit anyway would happily bless it.
 *   2. `ROLLBACK TO SAVEPOINT` UNDOES BOTH — the work AND the abort — which is exactly why the
 *      savepoint IS the fix.
 *
 * The staged world is committed to the canonical world only if the callback resolves AND the
 * transaction was never poisoned; this mirrors `admin-actions.atomicity.test.ts`, plus the abort
 * flag that file has no reason to model.
 *
 * THREE REACHABLE TRIGGERS, and the split matters to all of them:
 *   - a worker deleted mid-call → the OWNED upsert raises 23503, the platform upsert still lands;
 *   - `platform_ai_cost_totals` missing because 0077 had not applied → only the platform leg is
 *     lost, and the worker/session rows still land;
 *   - lock contention on one hot row → the other leg is unaffected.
 * Before the split, any one of them rolled back all three tables through a `logger.warn` and a
 * 200 — and the platform headline lost a call the ledger had recorded.
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

/** What is durably stored: the event spine, and the two independently-written total legs. */
interface World {
  events: string[];
  platform: string[];
  owned: string[];
}

/** One in-flight transaction: its uncommitted world, and whether Postgres has aborted it. */
interface Tx {
  world: World;
  aborted: boolean;
}

/**
 * @param failOwned make the worker/session write throw — the deleted-worker FK path.
 * @param failPlatform make the platform write throw — the missing-table / lock path.
 * Both poison the transaction on their way out, which is what Postgres does for a missing
 * relation, an FK violation and a lock timeout alike.
 */
function makeHarness(opts: { failOwned?: boolean; failPlatform?: boolean } = {}) {
  const committed: World = { events: [], platform: [], owned: [] };
  const arm = { failOwned: opts.failOwned ?? false, failPlatform: opts.failPlatform ?? false };

  const totals = {
    async withTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      const tx: Tx = { world: { events: [], platform: [], owned: [] }, aborted: false };
      tx.world.events = [...committed.events];
      tx.world.platform = [...committed.platform];
      tx.world.owned = [...committed.owned];
      const result = await work(tx); // throws → the staged world is discarded (ROLLBACK)
      // COMMIT ON AN ABORTED TRANSACTION IS A ROLLBACK. This line is the whole reason a
      // try/catch around a write is not a fix.
      if (tx.aborted) return result;
      committed.events = tx.world.events;
      committed.platform = tx.world.platform;
      committed.owned = tx.world.owned;
      return result;
    },
    async withSavepoint<T>(tx: unknown, work: (sp: unknown) => Promise<T>): Promise<T> {
      const t = tx as Tx;
      const snapshot: World = {
        events: [...t.world.events],
        platform: [...t.world.platform],
        owned: [...t.world.owned],
      };
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
    async accruePlatform(_input: unknown, tx: unknown): Promise<void> {
      const t = tx as Tx;
      if (t.aborted) throw new Error("current transaction is aborted (25P02)");
      if (arm.failPlatform) {
        t.aborted = true;
        throw new Error('relation "platform_ai_cost_totals" does not exist');
      }
      t.world.platform.push("platform");
    },
    async accrueOwned(input: { workerId: string | null }, tx: unknown): Promise<void> {
      const t = tx as Tx;
      if (t.aborted) throw new Error("current transaction is aborted (25P02)");
      if (arm.failOwned) {
        t.aborted = true;
        throw new Error('insert violates foreign key constraint "worker_ai_cost_totals_worker_id"');
      }
      t.world.owned.push(input.workerId ?? "(unattributed)");
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

describe("AiCostRecorder atomicity — the ledger row outranks the totals derived from it", () => {
  it("a FAILED owned accrual still commits the event AND the platform total", async () => {
    const h = makeHarness({ failOwned: true });

    await expect(
      h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", { workerId: WORKER }),
    ).resolves.toBeUndefined();

    // THE EVENT SURVIVED. Without a savepoint the aborted transaction takes it with it, and
    // the only trace of the money is a warn line — there is nothing left to back-fill FROM.
    expect(h.committed.events).toEqual([CALL_ID]);
    // THE HEADLINE SURVIVED TOO. This is the deleted-worker case: the worker FK failed, but
    // the platform row has no FK and was written first in its own savepoint.
    expect(h.committed.platform).toEqual(["platform"]);
    expect(h.committed.owned).toEqual([]);
  });

  it("a FAILED platform accrual still commits the event AND the owned totals", async () => {
    const h = makeHarness({ failPlatform: true });

    await expect(
      h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", { workerId: WORKER }),
    ).resolves.toBeUndefined();

    // The other degraded leg, for symmetry: one table's failure must not cost the other.
    expect(h.committed.events).toEqual([CALL_ID]);
    expect(h.committed.platform).toEqual([]);
    expect(h.committed.owned).toEqual([WORKER]);
  });

  it("a SUCCESSFUL accrual commits all three together — no total outruns its ledger row", async () => {
    const h = makeHarness();

    await h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });

    expect(h.committed.events).toEqual([CALL_ID]);
    expect(h.committed.platform).toEqual(["platform"]);
    expect(h.committed.owned).toEqual([WORKER]);
  });

  it("a transient owned failure costs ONE call's owned total and nothing else", async () => {
    // The FK and lock-contention triggers are both transient by nature: the job retries, or the
    // lock clears. The degraded state must therefore be per-call, and every event and platform
    // row must land either way — that is what keeps the spine a complete ledger.
    const h = makeHarness({ failOwned: true });
    await h.rec.record(META, "profiling_chat_turn", null, CORRELATION, "req-1", {
      workerId: WORKER,
    });

    h.arm.failOwned = false;
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
    expect(h.committed.platform).toEqual(["platform", "platform"]);
    expect(h.committed.owned).toEqual([WORKER]);
  });
});
