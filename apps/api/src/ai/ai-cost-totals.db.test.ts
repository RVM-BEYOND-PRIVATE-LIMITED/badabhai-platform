import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  chatSessions,
  createDbClient,
  events,
  platformAiCostTotals,
  sessionAiCostTotals,
  workerAiCostTotals,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { AICallMetadata } from "@badabhai/ai-contracts";

import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { AiCostRecorder } from "./ai-cost-recorder.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";

/**
 * The running totals, against a REAL Postgres — the whole stack, no fakes.
 *
 * WHY IT HAS TO BE A REAL DATABASE. Three of the four guarantees in this change are
 * PROPERTIES OF POSTGRES, not of TypeScript, and a mocked drizzle handle asserts none of them:
 *   1. `ON CONFLICT DO UPDATE ... total + excluded` really sums across calls (and sums in
 *      `numeric`, not in a float that drifts).
 *   2. `ON DELETE CASCADE` really removes the rows when a worker is erased — which is the
 *      ENTIRE DPDP/DSAR story for these tables. `WorkersRepository.hardDelete` names no table,
 *      so if this FK is wrong nothing else catches it, and a deleted worker's spend row
 *      survives their erasure.
 *   3. The events table's `ON CONFLICT DO NOTHING` really reports "deduped", so a redelivered
 *      job accrues nothing.
 * A unit test can only prove that the right SQL was ASKED for.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:migrate                       # 0077 must be applied
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test ai-cost-totals.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x7701);
/** A second worker, deleted mid-suite to prove the cascade. */
const WORKER_ERASED = uuid(0x7702);
const SESSION = uuid(0x7711);
const SESSION_ERASED = uuid(0x7712);
/** One correlation id for every event this suite emits — the handle `cleanup` deletes by. */
const CORRELATION = uuid(0x7740);

/**
 * Provider labels are UNIQUE TO THIS RUN. `platform_ai_cost_totals` is keyed on
 * (provider, task_type) and is deliberately not scoped to a worker, so it is the one table a
 * previous run — or a developer's real local traffic — could pollute. Namespacing the label
 * makes the platform assertions exact rather than "greater than".
 */
const PROVIDER = `test-provider-${process.pid}`;
const PROVIDER_B = `test-provider-b-${process.pid}`;

/** One billable call. `estimated_cost_inr` is the only number that must survive exactly. */
function meta(over: Partial<AICallMetadata> & { ai_call_id: string }): AICallMetadata {
  return {
    task_type: "profiling_chat_turn",
    model_name: "claude-haiku-4-5",
    provider: PROVIDER,
    real_call: true,
    input_tokens: 100,
    output_tokens: 20,
    estimated_cost_inr: 0.1,
    latency_ms: 1000,
    success: true,
    error_code: null,
    failure_reason: null,
    cost_alert: false,
    above_target: false,
    created_at: "2026-08-18T00:00:00.000Z",
    ...over,
  } as unknown as AICallMetadata;
}

describe.skipIf(!RUN)("worker/session/platform AI cost totals (migration 0077)", () => {
  let client!: DbClient;
  let recorder!: AiCostRecorder;

  async function cleanup(): Promise<void> {
    // The totals rows go with the workers (that is the property under test); the platform rows
    // and the events are namespaced/keyed and cleared explicitly.
    await client.db.delete(workers).where(eq(workers.id, WORKER));
    await client.db.delete(workers).where(eq(workers.id, WORKER_ERASED));
    await client.db.delete(platformAiCostTotals).where(eq(platformAiCostTotals.provider, PROVIDER));
    await client.db
      .delete(platformAiCostTotals)
      .where(eq(platformAiCostTotals.provider, PROVIDER_B));
    // THE EVENTS TOO, AND THIS IS NOT TIDINESS. The accrual is bound to the event insert
    // actually writing a row, so a leftover `ai.cost_recorded:<ai_call_id>` from a previous
    // run makes every emit here DEDUPE and every total stay at zero — the suite would pass
    // exactly once, on a fresh database, and then fail for the next person who ran it twice.
    // Measured, not imagined: it happened on the second run while this file was being written.
    await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    // THE REAL STACK: the shipped repository, the shipped events service, the shipped
    // recorder. Nothing here re-implements a query.
    const totals = new AiCostTotalsRepository(client.db);
    const eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    recorder = new AiCostRecorder(eventsService, totals);

    await cleanup();
    await client.db.insert(workers).values([
      { id: WORKER, phoneE164: "v1.p4-a", phoneHash: uuid(0x7721), status: "active" as const },
      {
        id: WORKER_ERASED,
        phoneE164: "v1.p4-b",
        phoneHash: uuid(0x7722),
        status: "active" as const,
      },
    ]);
    await client.db.insert(chatSessions).values([
      { id: SESSION, workerId: WORKER },
      { id: SESSION_ERASED, workerId: WORKER_ERASED },
    ]);
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  const workerRow = () =>
    client.db.select().from(workerAiCostTotals).where(eq(workerAiCostTotals.workerId, WORKER));
  const sessionRow = () =>
    client.db
      .select()
      .from(sessionAiCostTotals)
      .where(eq(sessionAiCostTotals.chatSessionId, SESSION));
  const platformRow = (provider: string, taskType: string) =>
    client.db
      .select()
      .from(platformAiCostTotals)
      .where(
        and(
          eq(platformAiCostTotals.provider, provider),
          eq(platformAiCostTotals.taskType, taskType),
        ),
      );

  it("accrues across MANY calls — the sum is exact, not a float that drifted", async () => {
    // 0.1 x 3 is the canonical float trap: in IEEE-754 it is 0.30000000000000004. The column
    // is `numeric`, and the addition happens in Postgres, so the answer is "0.300000".
    for (let i = 0; i < 3; i += 1) {
      await recorder.record(
        meta({ ai_call_id: uuid(0x7730 + i) }),
        "profiling_chat_turn",
        null,
        CORRELATION,
        "req-1",
        { workerId: WORKER, sessionId: SESSION },
      );
    }

    const [w] = await workerRow();
    expect(w).toBeDefined();
    expect(Number(w!.totalCostInr)).toBeCloseTo(0.3, 10);
    expect(w!.totalCostInr).toBe("0.300000");
    expect(w!.callCount).toBe(3);
    expect(w!.realCallCount).toBe(3);

    const [s] = await sessionRow();
    expect(s!.totalCostInr).toBe("0.300000");
    expect(s!.callCount).toBe(3);
    expect(s!.workerId).toBe(WORKER);

    const [p] = await platformRow(PROVIDER, "profiling_chat_turn");
    expect(p!.totalCostInr).toBe("0.300000");
    expect(p!.callCount).toBe(3);
  });

  it("a REDELIVERED call (same ai_call_id) accrues nothing the second time", async () => {
    // BullMQ redelivers stalled jobs. The event's idempotency key is
    // `ai.cost_recorded:<ai_call_id>`, so the second insert stores nothing — and the total
    // must not move, or every retry charges the same rupees again.
    const before = (await workerRow())[0]!;
    const replay = meta({ ai_call_id: uuid(0x7730) }); // the FIRST call, replayed verbatim
    await recorder.record(replay, "profiling_chat_turn", null, CORRELATION, "req-2", {
      workerId: WORKER,
      sessionId: SESSION,
    });
    const after = (await workerRow())[0]!;
    expect(after.totalCostInr).toBe(before.totalCostInr);
    expect(after.callCount).toBe(before.callCount);

    // …and exactly one event row exists for that call id, which is what made it a no-op.
    const rows = await client.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.idempotencyKey, `ai.cost_recorded:${replay.ai_call_id}`));
    expect(rows).toHaveLength(1);
  });

  it("an UNATTRIBUTED payer-side call lands platform-wide and on no worker", async () => {
    // `skill_embedding` on a posting write has no worker and no session. This is exactly the
    // spend a platform total summed from worker rows would silently omit.
    await recorder.record(
      meta({ ai_call_id: uuid(0x7750), provider: PROVIDER_B, estimated_cost_inr: 0.5 }),
      "skill_embedding",
      null,
      CORRELATION,
      "req-3",
    );
    const [p] = await platformRow(PROVIDER_B, "skill_embedding");
    expect(p!.totalCostInr).toBe("0.500000");
    expect(p!.callCount).toBe(1);

    // No worker row moved.
    const [w] = await workerRow();
    expect(w!.totalCostInr).toBe("0.300000");
  });

  it("a MOCK call is counted but not counted as REAL", async () => {
    await recorder.record(
      meta({ ai_call_id: uuid(0x7760), real_call: false, estimated_cost_inr: 0 }),
      "profiling_chat_turn",
      null,
      CORRELATION,
      "req-4",
      { workerId: WORKER, sessionId: SESSION },
    );
    const [w] = await workerRow();
    expect(w!.callCount).toBe(4);
    expect(w!.realCallCount).toBe(3); // ₹0 with 4 calls and 3 real is a story; a bare 0 is not
  });

  it("DPDP: deleting the worker takes BOTH of their totals rows with it", async () => {
    // The cascade IS the erasure coverage — `WorkersRepository.hardDelete` enumerates no
    // table names, so a new table that is not cascaded is a new thing to forget. This test is
    // what stops that from being a comment.
    await recorder.record(
      meta({ ai_call_id: uuid(0x7770) }),
      "profiling_chat_turn",
      null,
      CORRELATION,
      "req-5",
      { workerId: WORKER_ERASED, sessionId: SESSION_ERASED },
    );
    expect(
      await client.db
        .select()
        .from(workerAiCostTotals)
        .where(eq(workerAiCostTotals.workerId, WORKER_ERASED)),
    ).toHaveLength(1);
    expect(
      await client.db
        .select()
        .from(sessionAiCostTotals)
        .where(eq(sessionAiCostTotals.chatSessionId, SESSION_ERASED)),
    ).toHaveLength(1);

    // The hard delete a DSAR erasure performs — no per-table cleanup, by design.
    await client.db.delete(workers).where(eq(workers.id, WORKER_ERASED));

    expect(
      await client.db
        .select()
        .from(workerAiCostTotals)
        .where(eq(workerAiCostTotals.workerId, WORKER_ERASED)),
    ).toHaveLength(0);
    expect(
      await client.db
        .select()
        .from(sessionAiCostTotals)
        .where(eq(sessionAiCostTotals.chatSessionId, SESSION_ERASED)),
    ).toHaveLength(0);

    // The PLATFORM row survives, and that is correct: the money was spent whether or not the
    // subject remains, and the row carries no linkage back to them.
    const [p] = await platformRow(PROVIDER, "profiling_chat_turn");
    expect(Number(p!.totalCostInr)).toBeGreaterThan(0);
  });
});
