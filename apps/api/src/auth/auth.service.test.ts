import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import { AuthService } from "./auth.service";

const ctx = { requestId: "req-1", correlationId: "11111111-1111-4111-8111-111111111111" };
const PHONE = "+919876543210";

// Stub PII crypto: keyed-hash + encrypt that never echo the raw phone.
const pii = {
  hashPhone: (phone: string) => `hmac:${phone.length}`,
  hashIp: () => "hmac-ip",
  hmac: (value: string) => `hmac<${value}>`,
  encrypt: (value: string) => `v1.enc.${value.length}`,
  decrypt: (token: string) => token,
} as never;

/** A passing OTP service double (verify resolves, issue returns a cooldown). */
function makeOtp(overrides: Partial<{ verifyThrows: boolean }> = {}) {
  return {
    issueAndSend: vi.fn().mockResolvedValue({ resendInSeconds: 30 }),
    verify: overrides.verifyThrows
      ? vi.fn().mockRejectedValue(new HttpException("Incorrect code", HttpStatus.UNAUTHORIZED))
      : vi.fn().mockResolvedValue(undefined),
  };
}

/** A session service double that mints a deterministic token. */
function makeSessions() {
  return {
    create: vi.fn().mockResolvedValue({ token: "jwt.token.value", expiresInSeconds: 2592000 }),
  };
}

describe("AuthService (real OTP)", () => {
  it("requestOtp issues+sends the code and emits worker.otp_requested without leaking the phone", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const otp = makeOtp();
    const svc = new AuthService(
      { emit } as never,
      {} as never,
      pii,
      otp as never,
      makeSessions() as never,
    );

    const res = await svc.requestOtp(PHONE, ctx);

    expect(otp.issueAndSend).toHaveBeenCalledWith(PHONE);
    expect(res).toMatchObject({ success: true, channel: "sms", resend_in_seconds: 30 });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as { event_name: string; payload: { phone_hash: string } };
    expect(arg.event_name).toBe("worker.otp_requested");
    expect(JSON.stringify(arg)).not.toContain("9876543210");
    expect(arg.payload.phone_hash.length).toBeGreaterThan(0);
  });

  it("requestOtp does NOT emit if issueAndSend throws (no code sent → no event)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const otp = makeOtp();
    otp.issueAndSend = vi
      .fn()
      .mockRejectedValue(new HttpException("cooldown", HttpStatus.TOO_MANY_REQUESTS));
    const svc = new AuthService(
      { emit } as never,
      {} as never,
      pii,
      otp as never,
      makeSessions() as never,
    );

    await expect(svc.requestOtp(PHONE, ctx)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("verifyOtp rejects a bad code (otp.verify throws) and never touches the worker table", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const findByPhoneHash = vi.fn();
    const createOrGetByPhoneHash = vi.fn();
    const workers = { findByPhoneHash, createOrGetByPhoneHash };
    const sessions = makeSessions();
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp({ verifyThrows: true }) as never,
      sessions as never,
    );

    await expect(svc.verifyOtp(PHONE, "000000", ctx)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
    expect(findByPhoneHash).not.toHaveBeenCalled();
    expect(createOrGetByPhoneHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("verifyOtp on a good code creates a new worker, mints a token, emits created + verified", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const createOrGetByPhoneHash = vi
      .fn()
      .mockResolvedValue({ worker: { id: "worker-new", status: "active" }, created: true });
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue(undefined),
      createOrGetByPhoneHash,
    };
    const sessions = makeSessions();
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      sessions as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(true);
    expect(res.worker_id).toBe("worker-new");
    expect(res.access_token).toBe("jwt.token.value");
    expect(res.token_type).toBe("Bearer");
    expect(res.expires_in_seconds).toBe(2592000);
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    expect(sessions.create).toHaveBeenCalledWith("worker-new");
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
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(res.access_token).toBe("jwt.token.value");
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
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(res.worker_id).toBe("worker-1");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });
});
