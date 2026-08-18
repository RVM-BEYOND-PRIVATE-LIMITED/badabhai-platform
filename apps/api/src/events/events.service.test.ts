import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { EventsService } from "./events.service";

const CORR = "11111111-1111-4111-8111-111111111111";

describe("EventsService", () => {
  it("builds, validates, persists and returns a valid event", async () => {
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    const event = await svc.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      correlationId: CORR,
      requestId: "req-1",
    });

    expect(event.event_name).toBe("worker.otp_requested");
    expect(event.metadata.environment).toBe("test");
    expect(event.metadata.service).toBe("api");
    expect(event.metadata.request_id).toBe("req-1");
    expect(insert).toHaveBeenCalledOnce();
  });

  it("throws on an invalid payload and does NOT persist", async () => {
    const insert = vi.fn();
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    await expect(
      svc.emit({
        event_name: "worker.created",
        actor: { actor_type: "system" },
        subject: { subject_type: "worker" },
        // @ts-expect-error invalid payload on purpose
        payload: { worker_id: "not-a-uuid" },
      }),
    ).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  // --- TD18: idempotent emission ---------------------------------------------

  it("threads the idempotencyKey to the repository for at-least-once dedup", async () => {
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    await svc.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      idempotencyKey: "profile.extraction_ready:session-abc",
      correlationId: CORR,
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "worker.otp_requested" }),
      "profile.extraction_ready:session-abc",
      undefined, // no caller transaction (H3 executor) supplied
    );
  });

  it("passes undefined when no idempotencyKey is given (event always inserts)", async () => {
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    await svc.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      correlationId: CORR,
    });

    expect(insert).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
  });

  // --- H3: transaction-aware emit --------------------------------------------

  it("threads a caller transaction executor to the repository (atomic SoR+event)", async () => {
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);
    const tx = { __tx: true } as never;

    await svc.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      correlationId: CORR,
      tx,
    });

    expect(insert).toHaveBeenCalledWith(expect.anything(), undefined, tx);
  });

  it("still returns the event when the insert was a dedup no-op (returns false)", async () => {
    const insert = vi.fn().mockResolvedValue(false); // a row with this key already existed
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    const event = await svc.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      idempotencyKey: "dup-key",
      correlationId: CORR,
    });

    expect(event.event_name).toBe("worker.otp_requested");
    expect(insert).toHaveBeenCalledOnce();
  });

  // --- emitOnce: the `written` bit ---------------------------------------------
  //
  // `written` is the ONE fact `emit` throws away, and it is the single boolean every
  // materialization derived from an event rests on — `AiCostRecorder` accrues the running
  // totals iff it is true, so a redelivered BullMQ job charges the same rupees twice if this
  // wiring is wrong. Every recorder test stubs `emitOnce` with a `vi.fn()` that returns
  // whatever it is told, which asserts the recorder's use of the bit and nothing about where
  // the bit COMES FROM. These three are the only place `EventsRepository.insert`'s boolean is
  // proved to reach the caller unchanged.

  it("emitOnce reports written=true when the repository stored a row", async () => {
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    const { event, written } = await svc.emitOnce({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      idempotencyKey: "worker.otp_requested:abc",
      correlationId: CORR,
    });

    expect(written).toBe(true);
    expect(event.event_name).toBe("worker.otp_requested");
  });

  it("emitOnce reports written=false when the idempotency key deduped the insert", async () => {
    // `ON CONFLICT DO NOTHING` stored nothing: the logical event is already on the spine.
    // A caller that increments a total on this must not.
    const insert = vi.fn().mockResolvedValue(false);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    const { event, written } = await svc.emitOnce({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      idempotencyKey: "worker.otp_requested:abc",
      correlationId: CORR,
    });

    expect(written).toBe(false);
    // STILL RETURNS THE BUILT EVENT. `written` is the only thing that differs, which is why a
    // caller reading the return value alone cannot tell a dedup from a first write.
    expect(event.event_name).toBe("worker.otp_requested");
  });

  it("emitOnce reports written=true with NO idempotencyKey — NULLs never conflict", async () => {
    // The unkeyed path always inserts (a NULL `idempotency_key` cannot violate the unique
    // index), so `false` here would be a lie that silently suppressed a legitimate accrual.
    const insert = vi.fn().mockResolvedValue(true);
    const svc = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);

    const { written } = await svc.emitOnce({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: "hash" },
      correlationId: CORR,
    });

    expect(written).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
  });
});
