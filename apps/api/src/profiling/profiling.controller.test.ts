import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";

import { ConsentGuard } from "../auth/consent.guard";
import { WorkerAuthGuard, type AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";
import { ProfilingController } from "./profiling.controller";
import type { ProfilingSessionService } from "./profiling-session.service";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid" };
const SESSION = "22222222-2222-4222-8222-222222222222";

function make() {
  const profiling = {
    start: vi.fn(async () => ({ session_id: SESSION, step: { kind: "done" } })),
    answer: vi.fn(async () => ({ step: { kind: "done" } })),
    review: vi.fn(async () => ({ session_id: SESSION, complete: true, rows: [] })),
    finalize: vi.fn(async () => ({ session_id: SESSION, committed: true })),
  };
  return {
    controller: new ProfilingController(profiling as unknown as ProfilingSessionService),
    profiling,
  };
}

describe("ProfilingController (thin) — worker from the token, never the body", () => {
  it("start passes the authenticated worker id and ignores the body entirely", async () => {
    const { controller, profiling } = make();
    await controller.start(WORKER, {} as never, CTX);
    expect(profiling.start).toHaveBeenCalledWith(WORKER.id, CTX);
  });

  it("answer passes the authenticated worker id + dto", async () => {
    const { controller, profiling } = make();
    const dto = {
      session_id: SESSION,
      question_key: "q_city",
      answer: { kind: "text", text: "x" },
    };
    await controller.answer(WORKER, dto as never, CTX);
    expect(profiling.answer).toHaveBeenCalledWith(WORKER.id, dto, CTX);
  });

  it("review takes the session id from the URL and the worker from the token", async () => {
    // The session id is the ONLY thing a client supplies here; the service proves ownership of it
    // against the row before reading anything.
    const { controller, profiling } = make();
    await controller.review(WORKER, { sessionId: SESSION });
    expect(profiling.review).toHaveBeenCalledWith(WORKER.id, SESSION);
  });

  it("finalize passes the worker id and the session id from the body", async () => {
    const { controller, profiling } = make();
    await controller.finalize(WORKER, { session_id: SESSION }, CTX);
    expect(profiling.finalize).toHaveBeenCalledWith(WORKER.id, SESSION, CTX);
  });
});

describe("the guards, asserted rather than assumed", () => {
  it("is worker-authenticated THEN consent-gated, in that order", () => {
    // Order is load-bearing, not stylistic: `WorkerAuthGuard` attaches `req.worker` and
    // `ConsentGuard` reads it, so a swap makes the consent check silently pass on an
    // unauthenticated request. Asserted here because a new surface is the most likely place for
    // a guard to be forgotten, and the failure is invisible until a worker without a DPDP
    // consent row is profiled.
    const guards = Reflect.getMetadata("__guards__", ProfilingController) as unknown[];
    expect(guards).toEqual([WorkerAuthGuard, ConsentGuard]);
  });
});
