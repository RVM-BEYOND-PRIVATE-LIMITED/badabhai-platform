import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { WorkerActivityInterceptor } from "./worker-activity.interceptor";
import type { EventsService } from "../events/events.service";

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const WORKER_B = "22222222-2222-4222-8222-222222222222";

/** An HTTP ExecutionContext whose request carries (or does not carry) an authed worker. */
function ctx(workerId?: string): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => (workerId ? { worker: { id: workerId } } : {}) }),
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
