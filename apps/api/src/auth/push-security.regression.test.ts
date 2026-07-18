import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DevicesService } from "./devices.service";

/**
 * ADR-0034 D5b — REGRESSION LOCKS for the three defects an adversarial review found in
 * the first draft of this feature. Each one shipped a real failure, not a hypothetical:
 * a cross-account PII leak, a feature that dies on the next login, and a panic button
 * that does not stop anything. They live in one file so the reasons stay attached to the
 * assertions — a future refactor that "simplifies" any of these reopens a leak.
 *
 * The repository-level SQL is exercised by the integration suite; these pin the
 * SERVICE-level contract (what must be called, and what must never be).
 */

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_1 = "33333333-3333-4333-8333-333333333333";
const TOKEN = "fcm-shared-handset-token";

const pii = { hmac: vi.fn((v: string) => `hmac:${v}`) } as never;

function build(repo: Record<string, unknown>, push?: { enqueue: ReturnType<typeof vi.fn> }) {
  const emit = vi.fn().mockResolvedValue({ event_id: "e-1" });
  const merged = {
    listPushTargets: vi.fn().mockResolvedValue([]),
    setPushToken: vi.fn().mockResolvedValue({ id: DEVICE_1 }),
    claimPushToken: vi.fn().mockResolvedValue(0),
    ...repo,
  };
  const svc = new DevicesService(
    merged as never,
    { emit } as never,
    pii,
    { revokeByDevice: vi.fn() } as never,
    (push ?? { enqueue: vi.fn().mockResolvedValue(undefined) }) as never,
  );
  return { svc, repo: merged, emit };
}

describe("D5b.2 — a shared handset must not leak security alerts across workers", () => {
  it("registering a token CLAIMS it exclusively (steals it from stale rows)", async () => {
    // One phone, two workers: A logs out, B logs in. FCM hands the SAME token to that
    // install, so without the claim it sits on BOTH rows and A's "new device login"
    // alert is delivered to B's phone.
    const { svc, repo } = build({});
    await svc.updatePushToken(WORKER_A, DEVICE_1, TOKEN);

    expect(repo.setPushToken).toHaveBeenCalledWith(WORKER_A, DEVICE_1, TOKEN);
    expect(repo.claimPushToken).toHaveBeenCalledWith(TOKEN, DEVICE_1);
  });

  it("does NOT claim when the device did not match (unknown / not owned / revoked)", async () => {
    // A revoked device must never be re-armed for push — that would undo logout-all.
    const { svc, repo } = build({ setPushToken: vi.fn().mockResolvedValue(undefined) });
    await svc.updatePushToken(WORKER_A, DEVICE_1, TOKEN);
    expect(repo.claimPushToken).not.toHaveBeenCalled();
  });

  it("a session with no `did` claim is a NO-OP (never mints an unbound push target)", async () => {
    const { svc, repo } = build({});
    await svc.updatePushToken(WORKER_A, undefined, TOKEN);
    expect(repo.setPushToken).not.toHaveBeenCalled();
    expect(repo.claimPushToken).not.toHaveBeenCalled();
  });
});

describe("SIM-swap ruling — the new-device alert warns the OTHER phones", () => {
  it("excludes the device that just logged in", async () => {
    // If this login is an attacker on a new handset, the warning must reach the real
    // owner's phones. Pushing the new device tells the wrong person.
    const listPushTargets = vi.fn().mockResolvedValue([{ id: "other-device" }]);
    const push = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const { svc } = build(
      {
        registerOrTouch: vi.fn().mockResolvedValue({ device: { id: DEVICE_1 }, created: true }),
        listPushTargets,
      },
      push,
    );

    await svc.registerOnLogin(
      WORKER_A,
      { device_id: "raw-device", platform: "android" } as never,
      { correlationId: "c", requestId: "r" } as never,
    );

    // THE assertion: the just-registered device is the exclusion argument.
    expect(listPushTargets).toHaveBeenCalledWith(WORKER_A, DEVICE_1);
    expect(push.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: WORKER_A,
        eventName: "worker.device_registered",
        deviceIds: ["other-device"],
      }),
    );
  });

  it("a push failure NEVER costs the worker their device binding", async () => {
    // The outer handler degrades registration to "unbound" (no `did` claim). The push is
    // strictly additive to the login, so its failure must not reach that handler.
    const { svc } = build(
      {
        registerOrTouch: vi.fn().mockResolvedValue({ device: { id: DEVICE_1 }, created: true }),
        listPushTargets: vi.fn().mockRejectedValue(new Error("db down")),
      },
      { enqueue: vi.fn() },
    );

    const deviceId = await svc.registerOnLogin(
      WORKER_A,
      { device_id: "raw-device", platform: "android" } as never,
      { correlationId: "c", requestId: "r" } as never,
    );

    expect(deviceId).toBe(DEVICE_1); // still bound
  });
});
