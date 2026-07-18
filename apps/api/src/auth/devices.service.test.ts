import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { DevicesService } from "./devices.service";

const ctx = { requestId: "req-1", correlationId: "11111111-1111-4111-8111-111111111111" };

// PII crypto double — keyed HMAC that echoes its input length only (never the raw id).
const pii = { hmac: (value: string) => `hmac<${value.length}>` } as never;

function makeDeviceRow(over: Record<string, unknown> = {}) {
  return {
    id: "device-1",
    workerId: "worker-1",
    deviceHash: "hmac<...>",
    platform: "android",
    model: "Pixel 7",
    appVersion: "1.2.3",
    pushToken: "fcm-secret-token-value",
    attestationVerified: false,
    trustedAt: new Date("2026-06-20T10:00:00.000Z"),
    lastSeenAt: new Date("2026-06-28T12:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-20T10:00:00.000Z"),
    updatedAt: new Date("2026-06-28T12:00:00.000Z"),
    ...over,
  };
}

const EVENT_ID = "9f8e7d6c-1111-4111-8111-000000000009";

function build(over: {
  repo?: Record<string, unknown>;
  emit?: ReturnType<typeof vi.fn>;
  sessions?: Record<string, unknown>;
  push?: { enqueue: ReturnType<typeof vi.fn> };
}) {
  const emit = over.emit ?? vi.fn().mockResolvedValue({ event_id: EVENT_ID });
  // Defaults MERGED (not replaced): a test that overrides `repo` must still get the
  // ADR-0034 lookups, otherwise the service's best-effort catch swallows a missing-mock
  // TypeError and the assertion fails for a reason that has nothing to do with the test.
  const repo: Record<string, unknown> = {
    listPushTargets: vi.fn().mockResolvedValue([]),
    ...(over.repo ?? {}),
  };
  const sessions = over.sessions ?? { revokeByDevice: vi.fn().mockResolvedValue(0) };
  // ADR-0034 — the new-device security alert producer.
  const push = over.push ?? { enqueue: vi.fn().mockResolvedValue(undefined) };
  const svc = new DevicesService(
    repo as never,
    { emit } as never,
    pii,
    sessions as never,
    push as never,
  );
  return { svc, emit, repo, sessions, push };
}

describe("DevicesService (ADR-0026 Phase 2 — trusted-device binding)", () => {
  it("registerOnLogin with no device_info returns undefined and never touches the repo", async () => {
    const registerOrTouch = vi.fn();
    const { svc, emit } = build({ repo: { registerOrTouch } });
    const id = await svc.registerOnLogin("worker-1", undefined, ctx);
    expect(id).toBeUndefined();
    expect(registerOrTouch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("registers a NEW device: HMACs the raw id, emits a PII-free worker.device_registered, returns the row id", async () => {
    const registerOrTouch = vi
      .fn()
      .mockResolvedValue({ device: makeDeviceRow(), created: true });
    const { svc, emit, repo } = build({ repo: { registerOrTouch } });

    const id = await svc.registerOnLogin(
      "worker-1",
      { device_id: "raw-client-device-id", platform: "android", push_token: "fcm-secret" },
      ctx,
    );

    expect(id).toBe("device-1");
    // The RAW client device id is never passed to the repo — only its HMAC.
    const arg = (repo.registerOrTouch as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.deviceHash).toBe("hmac<20>");
    expect(JSON.stringify(arg)).not.toContain("raw-client-device-id");

    // The event carries ONLY worker_id + device_id (no hash, push_token, raw id, platform).
    expect(emit).toHaveBeenCalledTimes(1);
    const evt = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(evt.event_name).toBe("worker.device_registered");
    expect(Object.keys(evt.payload).sort()).toEqual(["device_id", "worker_id"]);
    const json = JSON.stringify(evt);
    expect(json).not.toContain("fcm-secret");
    expect(json).not.toContain("raw-client-device-id");
    expect(json).not.toContain("hmac<");
  });

  it("an EXISTING device (touch) emits NO event but still returns the row id", async () => {
    const registerOrTouch = vi
      .fn()
      .mockResolvedValue({ device: makeDeviceRow(), created: false });
    const { svc, emit } = build({ repo: { registerOrTouch } });
    const id = await svc.registerOnLogin(
      "worker-1",
      { device_id: "raw-client-device-id", platform: "android" },
      ctx,
    );
    expect(id).toBe("device-1");
    expect(emit).not.toHaveBeenCalled();
  });

  it("registration is BEST-EFFORT: a repo failure is swallowed (returns undefined) so login never breaks", async () => {
    const registerOrTouch = vi.fn().mockRejectedValue(new Error("db down"));
    const { svc, emit } = build({ repo: { registerOrTouch } });
    const id = await svc.registerOnLogin(
      "worker-1",
      { device_id: "raw-client-device-id", platform: "android" },
      ctx,
    );
    expect(id).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it("listForWorker NEVER surfaces device_hash or push_token and flags the current device", async () => {
    const rows = [
      makeDeviceRow({ id: "device-1" }),
      makeDeviceRow({ id: "device-2", pushToken: "other-secret" }),
    ];
    const listActiveByWorker = vi.fn().mockResolvedValue(rows);
    const { svc } = build({ repo: { listActiveByWorker } });

    const res = await svc.listForWorker("worker-1", "device-2");

    expect(listActiveByWorker).toHaveBeenCalledWith("worker-1");
    expect(res.devices.map((d) => d.id)).toEqual(["device-1", "device-2"]);
    expect(res.devices.find((d) => d.id === "device-2")!.is_current).toBe(true);
    expect(res.devices.find((d) => d.id === "device-1")!.is_current).toBe(false);
    const json = JSON.stringify(res);
    expect(json).not.toContain("fcm-secret-token-value");
    expect(json).not.toContain("other-secret");
    expect(json).not.toContain("device_hash");
    expect(json).not.toContain("deviceHash");
    expect(json).not.toContain("push_token");
  });

  it("PINS the GET /auth/devices wire contract — exact root + item keys (D8)", async () => {
    // The Flutter client falls back to `?? []` on shape drift (a rename would surface
    // as a silently EMPTY device list, not an error) — this pin makes server-side
    // drift loud. Field names are the client contract; change = version, not rename.
    const listActiveByWorker = vi.fn().mockResolvedValue([makeDeviceRow({ id: "device-1" })]);
    const { svc } = build({ repo: { listActiveByWorker } });

    const res = await svc.listForWorker("worker-1", "device-1");

    expect(Object.keys(res)).toEqual(["devices"]);
    expect(Object.keys(res.devices[0]!).sort()).toEqual([
      "app_version",
      "id",
      "is_current",
      "last_seen_at",
      "model",
      "platform",
      "trusted_at",
    ]);
  });

  it("revokeForWorker(owned) revokes the device, cuts its sessions, and emits worker.device_revoked", async () => {
    const revoke = vi.fn().mockResolvedValue(makeDeviceRow({ revokedAt: new Date() }));
    const revokeByDevice = vi.fn().mockResolvedValue(2);
    const { svc, emit } = build({ repo: { revoke }, sessions: { revokeByDevice } });

    await svc.revokeForWorker("worker-1", "device-1", ctx);

    expect(revoke).toHaveBeenCalledWith("worker-1", "device-1");
    expect(revokeByDevice).toHaveBeenCalledWith("worker-1", "device-1");
    expect(emit).toHaveBeenCalledTimes(1);
    const evt = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(evt.event_name).toBe("worker.device_revoked");
    expect(Object.keys(evt.payload).sort()).toEqual(["device_id", "worker_id"]);
  });

  it("revokeForWorker(not-owned / already-revoked) → 404, never cuts sessions, never emits (anti-IDOR)", async () => {
    // repo.revoke is scoped by worker_id + revoked_at IS NULL → returns undefined when the
    // device does not belong to this worker OR is already revoked. No oracle distinguishes.
    const revoke = vi.fn().mockResolvedValue(undefined);
    const revokeByDevice = vi.fn();
    const { svc, emit } = build({ repo: { revoke }, sessions: { revokeByDevice } });

    await expect(svc.revokeForWorker("worker-1", "someone-elses-device", ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(revokeByDevice).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
