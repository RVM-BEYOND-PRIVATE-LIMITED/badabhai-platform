import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotificationsController } from "./notifications.controller";
import type { NotificationsService } from "./notifications.service";
import type { NotificationStateService } from "./notification-state.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";

const ID = "11111111-1111-4111-8111-111111111111";
const FEED = [
  {
    id: "e1",
    type: "resume_ready" as const,
    title: "Resume taiyaar hai",
    body: "Aapka naya resume ban gaya — dekhein aur download karein.",
    created_at: "2026-07-14T10:00:00.000Z",
    read: false,
  },
];

function make() {
  const service = { getForWorker: vi.fn(async () => FEED) };
  const state = { markRead: vi.fn(async () => undefined) };
  const controller = new NotificationsController(
    service as unknown as NotificationsService,
    state as unknown as NotificationStateService,
  );
  return { controller, service, state };
}

describe("NotificationsController — worker-self, no IDOR", () => {
  it("takes the worker id from the token (@CurrentWorker), never a path/body id", async () => {
    const { controller, service } = make();
    const worker = { id: ID, sid: "sess-1" } as AuthenticatedWorker;

    const res = await controller.list(worker);

    // identity comes from the token-derived worker — the service is called with
    // exactly worker.id (there is no path/body id parameter on this route).
    expect(service.getForWorker).toHaveBeenCalledWith(ID);
    expect(res).toEqual({ notifications: FEED });
  });

  it("wraps the rows under `notifications` and carries no PII sentinels", async () => {
    const { controller } = make();
    const res = await controller.list({ id: ID, sid: "s" } as AuthenticatedWorker);
    expect(Array.isArray(res.notifications)).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/payer_id|worker_id|employer|₹/i);
  });
});

describe("NotificationsController.markRead — the read watermark (#643)", () => {
  it("stamps the watermark for the TOKEN's worker, never a body id", async () => {
    const { controller, state } = make();

    const res = await controller.markRead({ id: ID, sid: "sess-1" } as AuthenticatedWorker);

    // The route takes NO body and NO path param — the only id that can reach the
    // service is the token-derived one, so there is nothing to forge.
    expect(state.markRead).toHaveBeenCalledWith(ID);
    expect(controller.markRead.length).toBe(1); // exactly one param: @CurrentWorker
    expect(res).toEqual({ ok: true });
  });

  it("is idempotent — a repeat call succeeds identically", async () => {
    const { controller, state } = make();
    const worker = { id: ID, sid: "s" } as AuthenticatedWorker;

    expect(await controller.markRead(worker)).toEqual({ ok: true });
    expect(await controller.markRead(worker)).toEqual({ ok: true });
    expect(state.markRead).toHaveBeenCalledTimes(2);
  });
});
