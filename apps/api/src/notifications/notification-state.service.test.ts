import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { EVENT_REGISTRY, isEventName } from "@badabhai/event-schema";
import { NotificationStateService } from "./notification-state.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";

const ID = "11111111-1111-4111-8111-111111111111";
const ctx = { correlationId: "c-1", requestId: "r-1" } as RequestContext;

/** `missing: true` models a worker row that is gone (erased mid-session). */
function setup(
  over: { state?: unknown; updated?: unknown; advanced?: boolean; missing?: boolean } = {},
) {
  const workers = {
    findNotificationState: vi.fn(async () =>
      over.missing
        ? undefined
        : (over.state ?? {
            preferredLanguage: "hi",
            notificationsEnabled: true,
            notificationsReadAt: null,
          }),
    ),
    updateNotificationsEnabled: vi.fn(async (_id: string, enabled: boolean) =>
      over.missing ? undefined : (over.updated ?? { notificationsEnabled: enabled }),
    ),
    // Params typed so `.mock.calls[0]` is inspectable (an argless mock infers []).
    advanceNotificationsReadAt: vi.fn(async (_id: string, _stampedAt: Date) => over.advanced ?? true),
  };
  const events = { emit: vi.fn(async (_e: unknown) => ({ event_id: "e-1" })) };
  const svc = new NotificationStateService(
    workers as unknown as WorkersRepository,
    events as unknown as EventsService,
  );
  return { svc, workers, events };
}

describe("NotificationStateService.getPrefs", () => {
  it("returns the stored flag", async () => {
    const { svc } = setup({
      state: { preferredLanguage: "hi", notificationsEnabled: false, notificationsReadAt: null },
    });
    expect(await svc.getPrefs(ID)).toEqual({ notifications_enabled: false });
  });

  it("404s when the worker row is gone (erased mid-session) rather than inventing a default", async () => {
    const { svc } = setup({ missing: true });
    await expect(svc.getPrefs(ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("NotificationStateService.updatePrefs", () => {
  it("writes the flag and returns the RESULTING value read back from the row", async () => {
    const { svc, workers } = setup();
    const res = await svc.updatePrefs(ID, false, ctx);

    expect(workers.updateNotificationsEnabled).toHaveBeenCalledWith(ID, false);
    expect(res).toEqual({ notifications_enabled: false });
  });

  it("emits a registered, PII-FREE worker.notification_prefs_updated (§1/§2)", async () => {
    const { svc, events } = setup();
    await svc.updatePrefs(ID, false, ctx);

    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;

    expect(emitted.event_name).toBe("worker.notification_prefs_updated");
    // The name must exist in the registry, or EventsService would throw at runtime.
    expect(isEventName(emitted.event_name)).toBe(true);
    expect(emitted.actor).toEqual({ actor_type: "worker", actor_id: ID });
    expect(emitted.subject).toEqual({ subject_type: "worker", subject_id: ID });
    // Exact payload — an extra key here is how a name or phone would leak in.
    expect(emitted.payload).toEqual({ worker_id: ID, notifications_enabled: false });
    expect(emitted.correlationId).toBe("c-1");
    expect(emitted.requestId).toBe("r-1");
  });

  it("the emitted payload VALIDATES against the registry schema", async () => {
    const { svc, events } = setup();
    await svc.updatePrefs(ID, true, ctx);
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;

    const entry = EVENT_REGISTRY["worker.notification_prefs_updated"]!;
    expect(entry.payload.safeParse(emitted.payload).success).toBe(true);
    // `.strict()` — a stray PII field must not validate.
    expect(
      entry.payload.safeParse({ ...(emitted.payload as object), full_name: "Ramesh" }).success,
    ).toBe(false);
  });

  it("carries the RESULTING value, not the requested one, when the row disagrees", async () => {
    // Guards against emitting an optimistic value the database never stored.
    const { svc, events } = setup({ updated: { notificationsEnabled: true } });
    await svc.updatePrefs(ID, false, ctx);
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect((emitted.payload as Record<string, unknown>).notifications_enabled).toBe(true);
  });

  it("404s and emits NOTHING when no worker matched", async () => {
    const { svc, events } = setup({ missing: true });
    await expect(svc.updatePrefs(ID, true, ctx)).rejects.toBeInstanceOf(NotFoundException);
    // Fail closed: no event for a write that did not happen.
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("NotificationStateService.markRead", () => {
  it("advances the watermark for the given worker with an app-clock stamp", async () => {
    const { svc, workers } = setup();
    const before = Date.now();
    await svc.markRead(ID);
    const after = Date.now();

    expect(workers.advanceNotificationsReadAt).toHaveBeenCalledTimes(1);
    const [id, stamp] = workers.advanceNotificationsReadAt.mock.calls[0]!;
    expect(id).toBe(ID);
    expect(stamp).toBeInstanceOf(Date);
    // The same clock `events.occurred_at` is stamped from — the feed compares them.
    expect(stamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamp.getTime()).toBeLessThanOrEqual(after);
  });

  it("emits NO event — a read position is not a business action (§1)", async () => {
    const { svc, events } = setup();
    await svc.markRead(ID);
    // The Alerts feed is a projection OVER `events`; emitting here would grow the very
    // table the feed scans, on a purely cosmetic signal.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("succeeds when the watermark was already ahead (false is not a failure)", async () => {
    const { svc } = setup({ advanced: false });
    await expect(svc.markRead(ID)).resolves.toBeUndefined();
  });
});
