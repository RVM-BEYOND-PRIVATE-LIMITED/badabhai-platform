import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AuthService } from "./auth.service";

const ctx = { requestId: "req-1", correlationId: "11111111-1111-4111-8111-111111111111" };
const PHONE = "+919876543210";

// Stub PII crypto: keyed-hash + encrypt that never echo the raw phone.
const pii = {
  hashPhone: (phone: string) => `hmac:${phone.length}`,
  hashIp: () => "hmac-ip",
  encrypt: (value: string) => `v1.enc.${value.length}`,
  decrypt: (token: string) => token,
} as never;

describe("AuthService (mock OTP)", () => {
  it("requestOtp emits worker.otp_requested and never leaks the raw phone", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const svc = new AuthService({ emit } as never, {} as never, pii);

    await svc.requestOtp(PHONE, ctx);

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as { event_name: string; payload: { phone_hash: string } };
    expect(arg.event_name).toBe("worker.otp_requested");
    // The raw phone must NOT appear anywhere in the emitted event.
    expect(JSON.stringify(arg)).not.toContain("9876543210");
    expect(arg.payload.phone_hash.length).toBeGreaterThan(0);
  });

  it("verifyOtp creates a new worker and emits created + verified", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const createOrGetByPhoneHash = vi
      .fn()
      .mockResolvedValue({ worker: { id: "worker-new", status: "active" }, created: true });
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue(undefined),
      createOrGetByPhoneHash,
    };
    const svc = new AuthService({ emit } as never, workers as never, pii);

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(true);
    expect(res.worker_id).toBe("worker-new");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toContain("worker.created");
    expect(names).toContain("worker.otp_verified");
  });

  it("verifyOtp returns an existing worker without creating", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const createOrGetByPhoneHash = vi.fn();
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash,
    };
    const svc = new AuthService({ emit } as never, workers as never, pii);

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(createOrGetByPhoneHash).not.toHaveBeenCalled();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });

  // TD23: concurrent first-time logins both miss the SELECT; the loser's INSERT
  // hits `on conflict do nothing`, so createOrGetByPhoneHash returns the winner's
  // row with created=false. The loser must NOT 500, must report is_new_worker=false,
  // and must NOT re-emit worker.created.
  it("verifyOtp on a lost insert race returns the existing worker without re-emitting created", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const createOrGetByPhoneHash = vi
      .fn()
      .mockResolvedValue({ worker: { id: "worker-1", status: "active" }, created: false });
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue(undefined),
      createOrGetByPhoneHash,
    };
    const svc = new AuthService({ emit } as never, workers as never, pii);

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(res.worker_id).toBe("worker-1");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });
});
