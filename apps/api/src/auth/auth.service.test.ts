import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import { validateEvent } from "@badabhai/event-schema";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
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

/**
 * A session service double that mints a deterministic MintedSession (ADR-0026): the
 * access token + an opaque refresh token + the session view.
 */
function makeSessions() {
  const ABSOLUTE_MS = Date.UTC(2026, 8, 25);
  return {
    create: vi.fn().mockResolvedValue({
      access: { token: "jwt.token.value", expiresInSeconds: 2592000 },
      refresh: { token: "rt_opaque_value", expiresInSeconds: 7776000 },
      session: { tier: 0, expiresAtMs: Date.UTC(2026, 6, 27), requiresOtpAfterMs: ABSOLUTE_MS },
    }),
  };
}

/**
 * A devices service double (ADR-0026 Phase 2). registerOnLogin resolves to the given
 * device row id (undefined = no device_info / best-effort miss → session minted unbound).
 */
function makeDevices(deviceId?: string) {
  return { registerOnLogin: vi.fn().mockResolvedValue(deviceId) };
}

/**
 * A PIN repository double (ADR-0026 Phase 4). findByWorkerId resolves to a credential row
 * (=> pin_set true) or undefined when the worker has never set a PIN (=> pin_set false).
 */
function makePins(credential?: unknown) {
  return { findByWorkerId: vi.fn().mockResolvedValue(credential) };
}

/**
 * A ConsentRepository double (finding #172-#1). hasAcceptedConsent resolves to the given flag —
 * the SAME predicate ConsentGuard admits on — so the login response's derived consent_accepted
 * mirrors the server-side gate. Default false = never-consented (a brand-new worker).
 */
function makeConsents(accepted = false) {
  return { hasAcceptedConsent: vi.fn().mockResolvedValue(accepted) };
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
    );

    await expect(svc.requestOtp(PHONE, ctx)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("requestOtp on a GLOBAL send-cap breach emits exactly one PII-free worker.otp_send_cap_exceeded and re-throws 429", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const otp = makeOtp();
    otp.issueAndSend = vi.fn().mockRejectedValue(
      new OtpSendCapExceededException({ channel: "worker_sms", limit: 2000, window: "20260626" }),
    );
    const svc = new AuthService(
      { emit } as never,
      {} as never,
      pii,
      otp as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
    );

    // The neutral 429 (same as a throttle) reaches the client — no new oracle.
    await expect(svc.requestOtp(PHONE, ctx)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    // Exactly ONE breach event, with the AGGREGATE PII-free payload — and it validates.
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(arg.event_name).toBe("worker.otp_send_cap_exceeded");
    expect(arg.payload).toEqual({
      channel: "worker_sms",
      cap: "global_daily",
      limit: 2000,
      window: "20260626",
    });
    // No phone / code anywhere in the emitted event.
    expect(JSON.stringify(arg)).not.toContain("9876543210");
    // The emitted shape validates against @badabhai/event-schema.
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: arg.event_name,
      event_version: 1,
      occurred_at: "2026-06-26T00:00:00.000Z",
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: null },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: arg.payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(true);
    expect(res.worker_id).toBe("worker-new");
    // ADR-0026 Phase 4 — a brand-new worker has no worker_credentials row → set-PIN flow.
    expect(res.pin_set).toBe(false);
    expect(res.access_token).toBe("jwt.token.value");
    expect(res.token_type).toBe("Bearer");
    expect(res.expires_in_seconds).toBe(2592000);
    // ADR-0026 additive fields surfaced on the login response.
    expect(res.refresh_token).toBe("rt_opaque_value");
    expect(res.refresh_expires_in_seconds).toBe(7776000);
    expect(res.session.tier).toBe(0);
    expect(typeof res.session.expires_at).toBe("string");
    expect(typeof res.session.requires_otp_after).toBe("string");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    expect(sessions.create).toHaveBeenCalledWith("worker-new", undefined);
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    // ADR-0026 Phase 4 — no credential row mocked → pin_set false (set-PIN flow).
    expect(res.pin_set).toBe(false);
    expect(res.access_token).toBe("jwt.token.value");
    expect(createOrGetByPhoneHash).not.toHaveBeenCalled();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });

  it("verifyOtp returns pin_set=true when the worker already has a credential row (enter-PIN flow)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash: vi.fn(),
    };
    // A present worker_credentials row → the worker has a device-unlock PIN.
    const pins = makePins({ workerId: "worker-1" });
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      pins as never,
      makeConsents() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.pin_set).toBe(true);
    expect(pins.findByWorkerId).toHaveBeenCalledWith("worker-1");
    // The PIN/hash is never surfaced — only the boolean.
    expect(JSON.stringify(res)).not.toMatch(/pin_?hash|pinHash/i);
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
      makeDevices() as never,
      makePins() as never,
      makeConsents() as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(res.worker_id).toBe("worker-1");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });

  it("verifyOtp with device_info registers the device and binds the session via did", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash: vi.fn(),
    };
    const sessions = makeSessions();
    const devices = makeDevices("device-row-1");
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      sessions as never,
      devices as never,
      makePins() as never,
      makeConsents() as never,
    );

    const deviceInfo = { device_id: "client-stable-id", platform: "android" as const };
    await svc.verifyOtp(PHONE, "123456", ctx, deviceInfo as never);

    // The device is registered with the worker id from the verified login + the
    // device_info, and the returned device ROW id is threaded into the session as `did`.
    expect(devices.registerOnLogin).toHaveBeenCalledWith("worker-1", deviceInfo, ctx);
    expect(sessions.create).toHaveBeenCalledWith("worker-1", "device-row-1");
  });

  // ---- finding #172-#1 — consent_accepted on the LoginResponse (== ConsentGuard admit) ----

  it("verifyOtp surfaces consent_accepted=false for a never-consented worker (derived from ConsentRepository)", async () => {
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash: vi.fn(),
    };
    const consents = makeConsents(false); // never consented → gate would DENY → false
    const svc = new AuthService(
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
      consents as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);
    expect(res.consent_accepted).toBe(false);
    expect(consents.hasAcceptedConsent).toHaveBeenCalledWith("worker-1");
    // PII-free: the boolean flag never smuggles consent text / phone / name.
    const json = JSON.stringify(res);
    expect(json).not.toContain("9876543210");
    expect(json).not.toMatch(/consent_version|purposes|full_?name|phone/i);
  });

  it("verifyOtp surfaces consent_accepted=true for a worker with active (not-revoked) consent", async () => {
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash: vi.fn(),
    };
    const consents = makeConsents(true); // active consent → gate would ADMIT → true
    const svc = new AuthService(
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
      consents as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);
    expect(res.consent_accepted).toBe(true);
  });

  it("verifyOtp on a brand-new worker reports consent_accepted=false (a new worker cannot have consented)", async () => {
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue(undefined),
      createOrGetByPhoneHash: vi
        .fn()
        .mockResolvedValue({ worker: { id: "worker-new", status: "active" }, created: true }),
    };
    const consents = makeConsents(false);
    const svc = new AuthService(
      { emit: vi.fn().mockResolvedValue(undefined) } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
      consents as never,
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);
    expect(res.is_new_worker).toBe(true);
    expect(res.consent_accepted).toBe(false);
  });
});
