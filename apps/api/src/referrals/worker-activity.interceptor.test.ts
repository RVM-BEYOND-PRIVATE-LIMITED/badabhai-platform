import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { WorkerActivityInterceptor } from "./worker-activity.interceptor";
import type { EventsService } from "../events/events.service";
import type { WorkerActivityRepository } from "../worker-activity/worker-activity.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const WORKER_B = "22222222-2222-4222-8222-222222222222";

/** An HTTP ExecutionContext whose request carries (or does not carry) an authed worker. */
function ctx(workerId?: string, scope?: string): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () =>
        workerId ? { worker: { id: workerId, ...(scope ? { scope } : {}) } } : {},
    }),
  } as unknown as ExecutionContext;
}

function make() {
  const emit = vi.fn().mockResolvedValue(undefined);
  const interceptor = new WorkerActivityInterceptor({ emit } as unknown as EventsService);
  const handler: CallHandler = { handle: vi.fn(() => of("response")) };
  return { interceptor, emit, handler };
}

/** Drain the fire-and-forget emit (it is deliberately not awaited by the interceptor). */
const flush = () => new Promise((r) => setImmediate(r));

describe("WorkerActivityInterceptor — the X.6 retention signal", () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    // Fake ONLY the clock — `flush()` below relies on a REAL setImmediate to drain the
    // deliberately-unawaited emit.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-30T09:00:00.000Z"));
    h = make();
  });
  afterEach(() => vi.useRealTimers());

  it("emits worker.active ONCE per worker per UTC day, keyed for cross-process idempotency", async () => {
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();

    expect(h.emit).toHaveBeenCalledTimes(1);
    const call = h.emit.mock.calls[0]![0] as {
      event_name: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(call.event_name).toBe("worker.active");
    expect(call.payload).toEqual({ worker_id: WORKER_A, day: "2026-07-30" });
    expect(call.idempotencyKey).toBe(`worker.active:${WORKER_A}:2026-07-30`);
  });

  it("does NOT hit the events service again for the same worker on the same day (no per-request write)", async () => {
    for (let i = 0; i < 50; i++) h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("records each worker separately, and re-records after the UTC day rolls over", async () => {
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    h.interceptor.intercept(ctx(WORKER_B), h.handler);
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-07-31T00:00:01.000Z"));
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(3);
    expect((h.emit.mock.calls[2]![0] as { payload: { day: string } }).payload.day).toBe(
      "2026-07-31",
    );
  });

  it("ignores UNAUTHENTICATED requests entirely (no worker on the request ⇒ no work)", async () => {
    h.interceptor.intercept(ctx(), h.handler);
    await flush();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("ignores a RESTRICTED suspended DPDP session — it is not activity (#2701)", async () => {
    h.interceptor.intercept(ctx(WORKER_A, "suspended_dpdp"), h.handler);
    await flush();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.handler.handle).toHaveBeenCalled();
  });

  it("always passes the request through — and NEVER fails it when the emit rejects", async () => {
    h.emit.mockRejectedValue(new Error("events table down"));
    const out = h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.handler.handle).toHaveBeenCalled();
    await expect(new Promise((r) => out.subscribe((v) => r(v)))).resolves.toBe("response");
  });

  it("does not await the emit — the handler runs before the event resolves (no added latency)", () => {
    let resolveEmit: () => void = () => undefined;
    h.emit.mockReturnValue(new Promise<void>((r) => (resolveEmit = r)));
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    // The handler has already been invoked while the emit is still pending.
    expect(h.handler.handle).toHaveBeenCalled();
    resolveEmit();
  });

  it("carries NO route / session / ip / user-agent — a daily fact, not a movement trace", async () => {
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    const payload = (h.emit.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(["day", "worker_id"]);
  });
});

/**
 * #2753 — the IST-day write to `worker_activity`, beside the event. A REAL WorkerActivityService
 * over a fake repository, so the switch and the swallow are the production code, not a stub.
 */
describe("WorkerActivityInterceptor — the last-active day (#2753)", () => {
  function makeWithActivity(on: boolean) {
    const emit = vi.fn().mockResolvedValue(undefined);
    const repo = {
      touch: vi.fn().mockResolvedValue(undefined),
      lastActiveDays: vi.fn(),
    };
    const activity = new WorkerActivityService(repo as unknown as WorkerActivityRepository, {
      WORKER_ACTIVITY_ENABLED: on,
      NOT_RECENTLY_ACTIVE_DAYS: 90,
    });
    const interceptor = new WorkerActivityInterceptor(
      { emit } as unknown as EventsService,
      activity,
    );
    const handler: CallHandler = { handle: vi.fn(() => of("response")) };
    return { interceptor, emit, repo, handler };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 09:00 UTC = 14:30 IST, the same calendar day in both.
    vi.setSystemTime(new Date("2026-07-30T09:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("switch OFF: no repository call at all, and the event exactly as before", async () => {
    const h = makeWithActivity(false);
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.repo.touch).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("switch ON: one write per worker per IST day, however many requests", async () => {
    const h = makeWithActivity(true);
    for (let i = 0; i < 20; i++) h.interceptor.intercept(ctx(WORKER_A), h.handler);
    h.interceptor.intercept(ctx(WORKER_B), h.handler);
    await flush();
    expect(h.repo.touch).toHaveBeenCalledTimes(2);
    expect(h.repo.touch).toHaveBeenCalledWith(WORKER_A, "2026-07-30");
    expect(h.repo.touch).toHaveBeenCalledWith(WORKER_B, "2026-07-30");
  });

  it("the IST day turns over at 18:30 UTC, on its own cache; the UTC event does not move", async () => {
    const h = makeWithActivity(true);
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    // 18:31 UTC: a new IST day (31 Jul in India), still 30 Jul in UTC.
    vi.setSystemTime(new Date("2026-07-30T18:31:00.000Z"));
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.repo.touch).toHaveBeenCalledTimes(2);
    expect(h.repo.touch).toHaveBeenLastCalledWith(WORKER_A, "2026-07-31");
    // The event is still once for UTC 30 Jul, with today's key and payload.
    expect(h.emit).toHaveBeenCalledTimes(1);
    const call = h.emit.mock.calls[0]![0] as { idempotencyKey: string; payload: unknown };
    expect(call.idempotencyKey).toBe(`worker.active:${WORKER_A}:2026-07-30`);
    expect(call.payload).toEqual({ worker_id: WORKER_A, day: "2026-07-30" });
    // UTC midnight: the event fires for 31 Jul; the IST day is unchanged, so no second write.
    vi.setSystemTime(new Date("2026-07-31T00:01:00.000Z"));
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(h.repo.touch).toHaveBeenCalledTimes(2);
  });

  it("skips the restricted SUSPENDED DPDP token (it would clear his mark) and the anonymous", async () => {
    const h = makeWithActivity(true);
    h.interceptor.intercept(ctx(WORKER_A, "suspended_dpdp"), h.handler);
    h.interceptor.intercept(ctx(), h.handler);
    await flush();
    expect(h.repo.touch).not.toHaveBeenCalled();
    expect(h.handler.handle).toHaveBeenCalledTimes(2);
  });

  it("a repository failure NEVER fails the request", async () => {
    const h = makeWithActivity(true);
    h.repo.touch.mockRejectedValue(Object.assign(new Error("down"), { code: "57P01" }));
    const out = h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    await expect(new Promise((r) => out.subscribe((v) => r(v)))).resolves.toBe("response");
  });

  it("does not await the write — the handler runs while it is still pending", () => {
    const h = makeWithActivity(true);
    h.repo.touch.mockReturnValue(new Promise(() => undefined));
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    expect(h.handler.handle).toHaveBeenCalled();
  });

  it("a hand-built interceptor with no activity service behaves exactly as before", async () => {
    const h = make();
    h.interceptor.intercept(ctx(WORKER_A), h.handler);
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });
});
