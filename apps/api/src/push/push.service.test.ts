import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { PushService } from "./push.service";
import type { PushMessage, PushSendResult } from "./push.provider";
import {
  NOTIFICATION_TEMPLATES,
  PUSH_EVENT_NAMES,
} from "../notifications/notifications.dto";
import type { PushJobData } from "../queue/queue.constants";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_A = "33333333-3333-4333-8333-333333333333";
const DEVICE_B = "44444444-4444-4444-8444-444444444444";

function device(id: string, over: Partial<{ pushToken: string | null; pushTarget: string | null }> = {}) {
  return {
    id,
    pushToken: `fcm-opaque-${id.slice(0, 4)}`,
    pushTarget: `nonce-${id.slice(0, 4)}`,
    ...over,
  };
}

function setup(
  opts: {
    devices?: unknown[];
    sendResult?: PushSendResult;
    config?: Partial<ServerConfig>;
  } = {},
) {
  const sent: PushMessage[] = [];
  const provider = {
    send: vi.fn(async (m: PushMessage): Promise<PushSendResult> => {
      sent.push(m);
      return opts.sendResult ?? { ok: true };
    }),
  };
  const repo = {
    devicesForDelivery: vi.fn(async () => opts.devices ?? [device(DEVICE_A)]),
    claim: vi.fn(async (_e: string, d: string): Promise<string | null> => `delivery-${d}`),
    settle: vi.fn(async () => undefined),
  };
  const devicesRepo = { clearPushToken: vi.fn(async () => 1) };
  // Typed arg so `emit.mock.calls[0][0]` is inspectable (an argless mock infers []).
  const events = { emit: vi.fn(async (_e: unknown) => ({ event_id: "e-1" })) };
  const config = {
    PUSH_GLOBAL_MAX_SENDS_PER_DAY: 5000,
    ...opts.config,
  } as ServerConfig;

  const svc = new PushService(
    config,
    provider as never,
    repo as never,
    devicesRepo as never,
    events as never,
  );
  return { svc, provider, repo, devicesRepo, events, sent };
}

const job = (over: Partial<PushJobData> = {}): PushJobData => ({
  workerId: WORKER_ID,
  sourceEventId: EVENT_ID,
  eventName: "worker.device_registered",
  deviceIds: [DEVICE_A],
  ...over,
});

describe("PushService — the allowlist IS the boundary (ADR-0034)", () => {
  it("refuses an event that is not in NOTIFICATION_TEMPLATES", async () => {
    const { svc, provider } = setup();
    const res = await svc.deliver(job({ eventName: "worker.created" }));
    expect(res.sent).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("refuses an allowlisted event that is NOT flagged push (deferred scope)", async () => {
    // resume.generated is in the feed but push:false — the owner ruled security-only.
    const { svc, provider } = setup();
    const res = await svc.deliver(job({ eventName: "resume.generated" }));
    expect(res.sent).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("NO FEEDBACK LOOP: push events are never themselves pushable", () => {
    // A push emits an event. If that event were pushable the fan-out would
    // push -> emit -> push forever. Pin the disjointness structurally.
    expect(PUSH_EVENT_NAMES).not.toContain("worker.push_sent");
    expect(PUSH_EVENT_NAMES).not.toContain("worker.push_send_failed");
    expect(Object.keys(NOTIFICATION_TEMPLATES)).not.toContain("worker.push_sent");
    expect(Object.keys(NOTIFICATION_TEMPLATES)).not.toContain("worker.push_send_failed");
  });

  it("the ruled scope is SECURITY ONLY", () => {
    expect([...PUSH_EVENT_NAMES].sort()).toEqual([
      "worker.device_registered",
      "worker.logged_out_all",
    ]);
  });
});

describe("PushService — §2: what crosses Google's wire", () => {
  it("sends STATIC allowlist copy and never reads the event payload", async () => {
    const { svc, sent } = setup();
    await svc.deliver(job());
    const template = NOTIFICATION_TEMPLATES["worker.device_registered"]!;
    expect(sent[0]!.title).toBe(template.title);
    expect(sent[0]!.body).toBe(template.body);
  });

  it("the DATA block carries NO identity — no worker id, no event id, no device id", async () => {
    const { svc, sent } = setup();
    await svc.deliver(job());
    // `token` is the delivery ADDRESS and is necessarily present; everything else is
    // what actually crosses as payload data. Assert over exactly that.
    const { title, body, type, route, target } = sent[0]!;
    const data = JSON.stringify({ title, body, type, route, target });
    expect(data).not.toContain(WORKER_ID);
    expect(data).not.toContain(EVENT_ID);
    expect(data).not.toContain(DEVICE_A);
  });

  it("copy names no employer / company / pay (ADR-0024 stays intact over FCM)", async () => {
    const { svc, sent } = setup();
    await svc.deliver(job());
    const copy = `${sent[0]!.title} ${sent[0]!.body}`.toLowerCase();
    for (const banned of ["employer", "company", "payer", "salary", "₹"]) {
      expect(copy).not.toContain(banned);
    }
  });

  it("route is the closed enum, and carries the device's opaque target", async () => {
    const { svc, sent } = setup();
    await svc.deliver(job());
    expect(sent[0]!.route).toBe("devices");
    expect(sent[0]!.target).toBe(`nonce-${DEVICE_A.slice(0, 4)}`);
  });
});

describe("PushService — delivery, dedupe and token invalidation", () => {
  it("claims BEFORE sending so a retry cannot double-deliver", async () => {
    const { svc, repo, provider } = setup();
    await svc.deliver(job());
    expect(repo.claim).toHaveBeenCalledWith(EVENT_ID, DEVICE_A);
    expect(provider.send).toHaveBeenCalledTimes(1);
    // claim() returning null (already delivered) must skip the send entirely.
    repo.claim = vi.fn(async () => null);
    const again = await svc.deliver(job());
    expect(again.sent).toBe(0);
  });

  it("UNREGISTERED is the ONLY verdict that clears a stored token", async () => {
    const dead = setup({ sendResult: { ok: false, reason: "unregistered" } });
    await dead.svc.deliver(job());
    expect(dead.devicesRepo.clearPushToken).toHaveBeenCalledWith(`fcm-opaque-${DEVICE_A.slice(0, 4)}`);

    // A transport blip must NEVER throw away a working delivery address.
    const blip = setup({ sendResult: { ok: false, reason: "transport" } });
    await blip.svc.deliver(job());
    expect(blip.devicesRepo.clearPushToken).not.toHaveBeenCalled();
  });

  it("skips a device whose token vanished between enqueue and delivery", async () => {
    const { svc, provider } = setup({
      devices: [device(DEVICE_A, { pushToken: null })],
    });
    const res = await svc.deliver(job());
    expect(res.sent).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("emits a PII-FREE worker.push_sent (no token, no copy)", async () => {
    const { svc, events } = setup({ devices: [device(DEVICE_A), device(DEVICE_B)] });
    await svc.deliver(job({ deviceIds: [DEVICE_A, DEVICE_B] }));
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitted.event_name).toBe("worker.push_sent");
    expect(emitted.payload).toEqual({
      worker_id: WORKER_ID,
      source_event_id: EVENT_ID,
      type: "security",
      device_count: 2,
    });
    expect(JSON.stringify(emitted)).not.toMatch(/fcm-opaque|nonce-|Naye device/);
  });

  it("emits worker.push_send_failed with the closed reason when nothing sent", async () => {
    const { svc, events } = setup({ sendResult: { ok: false, reason: "provider_error" } });
    await svc.deliver(job());
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitted.event_name).toBe("worker.push_send_failed");
    expect((emitted.payload as Record<string, unknown>).reason).toBe("provider_error");
  });
});

describe("PushService — the kill-switch", () => {
  it("cap 0 halts EVERYTHING including security, and says so loudly", async () => {
    const { svc, provider, events } = setup({
      config: { PUSH_GLOBAL_MAX_SENDS_PER_DAY: 0 } as Partial<ServerConfig>,
    });
    const res = await svc.deliver(job());
    expect(res.sent).toBe(0);
    expect(provider.send).not.toHaveBeenCalled();
    // Never a silent drop.
    const emitted = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitted.event_name).toBe("worker.push_send_failed");
    expect((emitted.payload as Record<string, unknown>).reason).toBe("quota");
  });

  it("a NON-ZERO numeric ceiling never blocks a security alert", async () => {
    // The OTP cap this was modelled on bounds real money; FCM is free and every push in
    // scope is a security alert, so the ceiling must not be able to drop one.
    const { svc, provider } = setup({
      config: { PUSH_GLOBAL_MAX_SENDS_PER_DAY: 1 } as Partial<ServerConfig>,
    });
    const res = await svc.deliver(job());
    expect(res.sent).toBe(1);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});
