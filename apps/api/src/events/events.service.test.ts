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

    expect(insert).toHaveBeenCalledWith(expect.anything(), undefined);
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
});
