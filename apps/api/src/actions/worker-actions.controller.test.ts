import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException } from "@nestjs/common";

import { WorkerActionsController } from "./worker-actions.controller";
import {
  WorkerRecordActionSchema,
  WorkerRecordActionsBatchSchema,
  WORKER_ACTIONS_BATCH_MAX,
} from "./actions.dto";
import type { ActionsService } from "./actions.service";
import type { SubjectRateLimit } from "../common/rate-limit/subject-rate-limit.service";
import type { RequestContext } from "../common/request-context";

const WORKER = { id: "11111111-1111-4111-8111-111111111111", sid: "s" };
/** The worker a hostile body would try to attribute an action to. */
const SOMEONE_ELSE = "99999999-9999-4999-8999-999999999999";
const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const CAP = 500;

function make(opts: { overCap?: boolean } = {}) {
  const actions = {
    recordForWorker: vi.fn(async () => ({ recorded: true })),
    recordBatchForWorker: vi.fn(async () => ({ recorded_count: 3 })),
  };
  const rateLimit = {
    assertWithinHourlyCap: vi.fn(async () => {
      if (opts.overCap) throw new HttpException("Too many requests", 429);
    }),
  };
  const controller = new WorkerActionsController(
    actions as unknown as ActionsService,
    rateLimit as unknown as SubjectRateLimit,
    { WORKER_ACTIONS_PER_HOUR: CAP } as never,
  );
  return { controller, actions, rateLimit };
}

describe("the worker's OWN action sink (#694)", () => {
  it("stamps the acting worker from the TOKEN, never from the body", async () => {
    const { controller, actions } = make();
    await controller.record(WORKER as never, { action_type: "app_opened" }, CTX);
    expect(actions.recordForWorker).toHaveBeenCalledWith(
      WORKER.id,
      { action_type: "app_opened" },
      CTX,
    );
  });

  it("REJECTS a body that carries a worker_id rather than ignoring it", () => {
    // Ignoring would be equally safe and much worse to reason about: a client could ship code
    // that believes it is attributing an action to someone else and never be told otherwise.
    // `.strict()` makes the contract legible at the first request instead of at a post-mortem.
    const parsed = WorkerRecordActionSchema.safeParse({
      action_type: "app_opened",
      worker_id: SOMEONE_ELSE,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts both voice-form signals with their question_index context (#639)", () => {
    for (const action_type of ["question_audio_played", "profiling_answer_spoken"] as const) {
      const parsed = WorkerRecordActionSchema.safeParse({
        action_type,
        context: { question_index: 3 },
        client_occurred_at: "2026-08-08T10:00:00.000Z",
      });
      expect(parsed.success, `${action_type} must be a recordable action`).toBe(true);
    }
  });

  it("still refuses a target_id with no target_type", () => {
    expect(
      WorkerRecordActionSchema.safeParse({ action_type: "resume_viewed", target_id: SOMEONE_ELSE })
        .success,
    ).toBe(false);
  });
});

describe("the bounds on the buffered flush", () => {
  it("charges the cap for the WHOLE batch, not one per call", async () => {
    // A per-call charge would make the batch route the cheap way around the cap — the opposite of
    // what it is for. The client flushes opportunistically, so the bound has to be on records.
    const { controller, rateLimit } = make();
    const actions = Array.from({ length: 7 }, () => ({ action_type: "app_opened" as const }));
    await controller.recordBatch(WORKER as never, { actions }, CTX);
    expect(rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(
      "worker_actions",
      WORKER.id,
      CAP,
      7,
    );
  });

  it("charges 1 for the single route", async () => {
    const { controller, rateLimit } = make();
    await controller.record(WORKER as never, { action_type: "app_opened" }, CTX);
    expect(rateLimit.assertWithinHourlyCap).toHaveBeenCalledWith(
      "worker_actions",
      WORKER.id,
      CAP,
      1,
    );
  });

  it("WRITES NOTHING when the cap rejects — the limit is checked before the emit", async () => {
    const { controller, actions } = make({ overCap: true });
    await expect(
      controller.recordBatch(WORKER as never, { actions: [{ action_type: "app_opened" }] }, CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(actions.recordBatchForWorker).not.toHaveBeenCalled();
  });

  it("bounds one request at 100 actions, and refuses an empty flush", () => {
    // THE NUMBER IS PINNED HERE, deliberately. Deriving both arrays from
    // `WORKER_ACTIONS_BATCH_MAX` proves the schema honours whatever that constant says — it does
    // not pin what it says, so raising the constant to 10_000 kept this green. The internal batch
    // route bounds at 100 and this one claims to match it; that agreement is the assertion.
    expect(WORKER_ACTIONS_BATCH_MAX).toBe(100);
    const one = { action_type: "app_opened" as const };
    const ok = Array.from({ length: WORKER_ACTIONS_BATCH_MAX }, () => one);
    expect(WorkerRecordActionsBatchSchema.safeParse({ actions: ok }).success).toBe(true);
    expect(WorkerRecordActionsBatchSchema.safeParse({ actions: [...ok, one] }).success).toBe(false);
    expect(WorkerRecordActionsBatchSchema.safeParse({ actions: [] }).success).toBe(false);
  });
});
