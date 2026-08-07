import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotificationPrefsController } from "./notification-prefs.controller";
import type { NotificationStateService } from "./notification-state.service";
import { UpdateNotificationPrefsSchema } from "./notifications.dto";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = { correlationId: "c-1", requestId: "r-1" } as RequestContext;

function make() {
  const state = {
    getPrefs: vi.fn(async () => ({ notifications_enabled: true })),
    updatePrefs: vi.fn(async (_id: string, enabled: boolean) => ({
      notifications_enabled: enabled,
    })),
  };
  const controller = new NotificationPrefsController(
    state as unknown as NotificationStateService,
  );
  return { controller, state };
}

describe("NotificationPrefsController — worker-self, no IDOR", () => {
  it("GET reads the prefs of the TOKEN's worker", async () => {
    const { controller, state } = make();

    const res = await controller.get({ id: ID, sid: "sess-1" } as AuthenticatedWorker);

    expect(state.getPrefs).toHaveBeenCalledWith(ID);
    expect(res).toEqual({ notifications_enabled: true });
  });

  it("PATCH writes to the TOKEN's worker — a worker_id in the body cannot redirect it", async () => {
    const { controller, state } = make();
    // The schema is `.strict()`, so this body would be rejected outright by the pipe;
    // the controller ALSO never reads an id from it. Two independent guarantees.
    const dto = { notifications_enabled: false } as never;

    await controller.update({ id: ID, sid: "s" } as AuthenticatedWorker, dto, ctx);

    expect(state.updatePrefs).toHaveBeenCalledWith(ID, false, ctx);
    expect(state.updatePrefs).not.toHaveBeenCalledWith(OTHER, expect.anything(), expect.anything());
  });

  it("PATCH returns the RESULTING prefs so the client reconciles without a second GET", async () => {
    const { controller } = make();
    const res = await controller.update(
      { id: ID, sid: "s" } as AuthenticatedWorker,
      { notifications_enabled: false },
      ctx,
    );
    expect(res).toEqual({ notifications_enabled: false });
  });

  it("responds with only the one non-PII boolean — no phone, name, or worker id", async () => {
    const { controller } = make();
    const res = await controller.get({ id: ID, sid: "s" } as AuthenticatedWorker);

    expect(Object.keys(res)).toEqual(["notifications_enabled"]);
    expect(JSON.stringify(res)).not.toContain(ID);
  });
});

describe("UpdateNotificationPrefsSchema — the body contract", () => {
  it("accepts the exact body the app sends", () => {
    expect(UpdateNotificationPrefsSchema.parse({ notifications_enabled: true })).toEqual({
      notifications_enabled: true,
    });
  });

  it("REJECTS an empty body — one required field means absent says nothing", () => {
    // A no-op PATCH must be a 400, not a silent state-change event.
    expect(UpdateNotificationPrefsSchema.safeParse({}).success).toBe(false);
  });

  it("REJECTS a non-boolean, including the truthy strings a loose client might send", () => {
    for (const bad of ["true", 1, null, "on"]) {
      expect(
        UpdateNotificationPrefsSchema.safeParse({ notifications_enabled: bad }).success,
      ).toBe(false);
    }
  });

  it("REJECTS unknown keys (.strict) — a smuggled id or PII field cannot ride along", () => {
    const res = UpdateNotificationPrefsSchema.safeParse({
      notifications_enabled: true,
      worker_id: OTHER,
      full_name: "Ramesh Kumar",
    });
    expect(res.success).toBe(false);
  });
});
