import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import { validateEvent } from "@badabhai/event-schema";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { OtpSendFailedException } from "../common/otp-send-failure";
import { AuthService } from "./auth.service";

const ctx = { requestId: "req-1", correlationId: "11111111-1111-4111-8111-111111111111" };
const PHONE = "+919876543210";
// D-3 (review M1): the ONLY range the gated test-login mint serves — `+91` + five
// zeros + 5 digits. Unassignable (a real Indian mobile starts 6-9 after +91), so it
// can never collide with a real worker even on staging's REAL Fast2SMS.
const SYNTHETIC_PHONE = "+910000000000";

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

  it("requestOtp on a provider send failure emits exactly one PII-free worker.otp_send_failed and re-throws 502 (F4)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const otp = makeOtp();
    otp.issueAndSend = vi
      .fn()
      .mockRejectedValue(new OtpSendFailedException({ provider: "fast2sms", reason: "transport" }));
    const svc = new AuthService(
      { emit } as never,
      {} as never,
      pii,
      otp as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
    );

    // The SAME neutral 502 the send-failure path already returned reaches the client.
    await expect(svc.requestOtp(PHONE, ctx)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });

    // Exactly ONE monitoring event, with the AGGREGATE PII-free payload — and it validates.
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(arg.event_name).toBe("worker.otp_send_failed");
    expect(arg.payload).toEqual({ provider: "fast2sms", reason: "transport" });
    // No phone / hash / code anywhere in the emitted event.
    expect(JSON.stringify(arg)).not.toContain("9876543210");
    expect(JSON.stringify(arg)).not.toContain("hmac:");
    // The emitted shape validates against @badabhai/event-schema.
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: arg.event_name,
      event_version: 1,
      occurred_at: "2026-07-15T00:00:00.000Z",
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

  it("issueAndSendWithSignals (the seam the account-delete step-up uses) emits exactly one worker.otp_send_failed and re-throws the 502", async () => {
    // The account-delete request path (auth.controller accountDeleteRequest) calls THIS
    // seam directly — so a Fast2SMS failure there emits the same event as the login path.
    const emit = vi.fn().mockResolvedValue(undefined);
    const otp = makeOtp();
    otp.issueAndSend = vi.fn().mockRejectedValue(
      new OtpSendFailedException({ provider: "fast2sms", reason: "provider_rejected" }),
    );
    const svc = new AuthService(
      { emit } as never,
      {} as never,
      pii,
      otp as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
    );

    await expect(svc.issueAndSendWithSignals(PHONE, ctx)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      message: "Could not send the code, please retry",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(arg.event_name).toBe("worker.otp_send_failed");
    expect(arg.payload).toEqual({ provider: "fast2sms", reason: "provider_rejected" });
    expect(JSON.stringify(arg)).not.toContain("9876543210");
  });

  it("issueAndSendWithSignals resolves the cooldown untouched on success and emits nothing", async () => {
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
    );
    await expect(svc.issueAndSendWithSignals(PHONE, ctx)).resolves.toEqual({
      resendInSeconds: 30,
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
      makeDevices() as never,
      makePins() as never,
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
    );

    const res = await svc.verifyOtp(PHONE, "123456", ctx);

    expect(res.is_new_worker).toBe(false);
    expect(res.worker_id).toBe("worker-1");
    expect(createOrGetByPhoneHash).toHaveBeenCalledOnce();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.otp_verified"]);
  });

  // ---- D-3 — the GATED test-login mint (rides the SAME post-verification seam) ----

  it("testLogin creates a new worker via the SHARED seam, mints the SAME login shape, and emits created + test_login (never otp_verified)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const createOrGetByPhoneHash = vi
      .fn()
      .mockResolvedValue({ worker: { id: "11111111-1111-4111-8111-111111111111", status: "active" }, created: true });
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue(undefined),
      createOrGetByPhoneHash,
    };
    const otp = makeOtp();
    const sessions = makeSessions();
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      otp as never,
      sessions as never,
      makeDevices() as never,
      makePins() as never,
    );

    const res = await svc.testLogin(SYNTHETIC_PHONE, ctx);

    // The OTP machinery is NEVER touched — the guard is the gate, not a code.
    expect(otp.issueAndSend).not.toHaveBeenCalled();
    expect(otp.verify).not.toHaveBeenCalled();

    // SAME response shape as verifyOtp (the shared seam — no forked mint logic).
    expect(res.is_new_worker).toBe(true);
    expect(res.worker_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(res.access_token).toBe("jwt.token.value");
    expect(res.token_type).toBe("Bearer");
    expect(res.pin_set).toBe(false);
    expect(res.refresh_token).toBe("rt_opaque_value");
    expect(res.session.tier).toBe(0);
    expect(typeof res.session.expires_at).toBe("string");
    expect(sessions.create).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", undefined);

    // worker.created (once, keyed) + the DISTINCT worker.test_login — never otp_verified.
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.created", "worker.test_login"]);
    expect(names).not.toContain("worker.otp_verified");

    // The test_login payload is the PII-free mirror of otp_verified — and it VALIDATES.
    const arg = emit.mock.calls[1]![0] as { event_name: string; payload: Record<string, unknown> };
    // The keyed HASH only — matching the `pii` stub above (`hmac:<len>`), never the phone.
    expect(arg.payload).toEqual({
      worker_id: "11111111-1111-4111-8111-111111111111",
      phone_hash: `hmac:${SYNTHETIC_PHONE.length}`,
      is_new_worker: true,
    });
    expect(JSON.stringify(arg)).not.toContain(SYNTHETIC_PHONE); // never the raw phone
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: arg.event_name,
      event_version: 1,
      occurred_at: "2026-07-17T00:00:00.000Z",
      actor: { actor_type: "worker", actor_id: "11111111-1111-4111-8111-111111111111" },
      subject: { subject_type: "worker", subject_id: "11111111-1111-4111-8111-111111111111" },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: arg.payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
  });

  // Review M1 — the mint serves ONLY the reserved unassignable synthetic range.
  it("testLogin REFUSES a real-looking phone with a neutral 404 and never touches the worker table", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const workers = {
      findByPhoneHash: vi.fn(),
      createOrGetByPhoneHash: vi.fn(),
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
    );

    // A REAL Indian mobile (+91 then 10 digits starting 9) — staging runs real
    // Fast2SMS, so such a worker can genuinely exist. The seam must never mint it.
    await expect(svc.testLogin("+919876543210", ctx)).rejects.toMatchObject({ status: 404 });

    // Refused BEFORE any find-or-create / mint / event — no session, no worker, no spine row.
    expect(workers.findByPhoneHash).not.toHaveBeenCalled();
    expect(workers.createOrGetByPhoneHash).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("testLogin refuses every non-synthetic shape (no oracle: all the SAME neutral 404)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const svc = new AuthService(
      { emit } as never,
      { findByPhoneHash: vi.fn(), createOrGetByPhoneHash: vi.fn() } as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
    );
    for (const phone of [
      "+919876543210", // real Indian mobile
      "+910000123456", // only FOUR leading zeros — one short of the reserved run
      "+9100000123456", // right prefix but too long
      "+91000001234", // right prefix but too short
      "+911000000000", // leading 1, not the zero-run
      "+14155550123", // non-India (US)
      "+920000000000", // the zero-run, but the WRONG country code
    ]) {
      await expect(svc.testLogin(phone, ctx), `must refuse ${phone}`).rejects.toMatchObject({
        status: 404,
      });
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it("testLogin ACCEPTS the reserved synthetic range (+9100000XXXXX — incl. the smoke default)", async () => {
    for (const phone of ["+910000000000", "+910000099999"]) {
      const emit = vi.fn().mockResolvedValue(undefined);
      const svc = new AuthService(
        { emit } as never,
        {
          findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
          createOrGetByPhoneHash: vi.fn(),
        } as never,
        pii,
        makeOtp() as never,
        makeSessions() as never,
        makeDevices() as never,
        makePins() as never,
      );
      const res = await svc.testLogin(phone, ctx);
      expect(res.access_token, `must mint for ${phone}`).toBe("jwt.token.value");
      const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
      expect(names).toEqual(["worker.test_login"]);
    }
  });

  it("testLogin for an EXISTING worker emits ONLY worker.test_login (no created, no consent write anywhere)", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const workers = {
      findByPhoneHash: vi.fn().mockResolvedValue({ id: "worker-1", status: "active" }),
      createOrGetByPhoneHash: vi.fn(),
    };
    const svc = new AuthService(
      { emit } as never,
      workers as never,
      pii,
      makeOtp() as never,
      makeSessions() as never,
      makeDevices() as never,
      makePins() as never,
    );

    const res = await svc.testLogin(SYNTHETIC_PHONE, ctx);

    expect(res.is_new_worker).toBe(false);
    expect(workers.createOrGetByPhoneHash).not.toHaveBeenCalled();
    const names = emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["worker.test_login"]);
    // Consent is NEITHER created nor bypassed: no consent.accepted is ever emitted here —
    // the minted session behaves exactly like an OTP session downstream (ConsentGuard applies).
    expect(names).not.toContain("consent.accepted");
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
    );

    const deviceInfo = { device_id: "client-stable-id", platform: "android" as const };
    await svc.verifyOtp(PHONE, "123456", ctx, deviceInfo as never);

    // The device is registered with the worker id from the verified login + the
    // device_info, and the returned device ROW id is threaded into the session as `did`.
    expect(devices.registerOnLogin).toHaveBeenCalledWith("worker-1", deviceInfo, ctx);
    expect(sessions.create).toHaveBeenCalledWith("worker-1", "device-row-1");
  });
});
