import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { EventsController } from "./events.controller";
import type { EventsRepository } from "./events.repository";

const ROW = {
  id: "e1",
  eventName: "consent.accepted",
  eventVersion: 1,
  actorType: "worker",
  subjectType: "consent",
  subjectId: "c1",
  occurredAt: new Date("2026-06-11T00:00:00Z"),
  correlationId: "corr-1",
  // Fields that must NOT be projected out to the ops view:
  payload: { worker_id: "w1" },
  actorId: "w1",
};

function make(rows: unknown[] = [ROW]) {
  const events = { list: vi.fn(async () => rows) };
  return { controller: new EventsController(events as unknown as EventsRepository), events };
}

describe("EventsController (read) — projection + clamp + no-PII", () => {
  it("clamps the limit (invalid → default 100) and maps a PII-free projection", async () => {
    const { controller, events } = make();
    const res = await controller.list("nan");
    expect(events.list).toHaveBeenCalledWith(100); // clampLimit default
    expect(res.events[0]).toEqual({
      id: "e1",
      event_name: "consent.accepted",
      event_version: 1,
      actor_type: "worker",
      subject_type: "consent",
      subject_id: "c1",
      occurred_at: ROW.occurredAt,
      correlation_id: "corr-1",
    });
    // payload + actor_id are intentionally NOT surfaced.
    expect(res.events[0]).not.toHaveProperty("payload");
    expect(res.events[0]).not.toHaveProperty("actor_id");
  });

  it("clamps an over-max limit down to 500", async () => {
    const { controller, events } = make([]);
    await controller.list("99999");
    expect(events.list).toHaveBeenCalledWith(500);
  });
});
