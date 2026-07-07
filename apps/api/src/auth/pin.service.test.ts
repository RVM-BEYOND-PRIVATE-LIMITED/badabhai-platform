import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { PinService, type VerifyPinInput } from "./pin.service";
import { PinHasher, CURRENT_PIN_PEPPER_VERSION } from "./pin-hasher.service";

/**
 * SERVICE behaviour for the device-bound unlock PIN (ADR-0026 Phase 3). Every collaborator is
 * an in-memory double — NO live Redis / Postgres / scrypt. The scrypt round-trip is covered in
 * packages/db/src/crypto.test.ts; here we drive the throttle state machine, the neutral no-
 * oracle contract, the force-OTP durability across a Redis flush, and the PII-free events.
 *
 * Mirrors the auth test style: a `build()` factory wiring doubles, PII-crypto that never echoes
 * the raw value, and explicit `JSON.stringify(event)` PII assertions.
 */

const ctx = { requestId: "req-1", correlationId: "11111111-1111-4111-8111-111111111111" };

const PHONE = "+919876543210";
const WORKER = "worker-1";
const DEVICE = "device-1";
const REFRESH = "rt_opaque_value";
const GOOD_PIN = "1357";
const WRONG_PIN = "2468";

const BASE_CONFIG = {
  PIN_LENGTH: 4,
  PIN_MAX_ATTEMPTS: 5,
  PIN_LOCKOUT_BASE_SECONDS: 60,
  PIN_MAX_LOCKOUT_CYCLES: 5,
} as unknown as ServerConfig;

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

/**
 * Redis double covering ONLY the commands the PIN throttle uses: get / set key val EX sec /
 * del. Same shape as session.service.test.ts makeRedis(), trimmed to the `pin_throttle:*`
 * surface. `store` is exposed so a test can simulate a Redis flush (store.clear()).
 */
function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    async get(key: string) {
      calls.push(["get", key]);
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, mode: "EX", seconds: number) {
      calls.push(["set", key, value, mode, seconds]);
      store.set(key, value);
      return "OK";
    },
    async del(...keys: string[]) {
      calls.push(["del", ...keys]);
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
  };
  return { store, calls, client };
}

/**
 * A deterministic PIN hasher double standing in for the real scrypt boundary. `hash` wraps the
 * PIN in a non-identity envelope; `verify` unwraps + version-checks (fails closed on a wrong
 * version, matching the real boundary). `verify` is a vi.fn so a test can assert scrypt was /
 * was NOT consulted on a given path. The format + denylist methods delegate to the REAL
 * PinHasher (the actual policy under test for setPin/resetConfirm).
 */
function makeHasher() {
  const realPolicy = new PinHasher(BASE_CONFIG, {} as never);
  const verify = vi.fn((pin: string, token: string, version: number) => {
    if (version !== CURRENT_PIN_PEPPER_VERSION) return false;
    return token === `pin$${pin}`;
  });
  const hash = vi.fn((pin: string) => ({
    pinHash: `pin$${pin}`,
    pepperVersion: CURRENT_PIN_PEPPER_VERSION,
  }));
  return {
    verify,
    hash,
    isWeakPin: (pin: string) => realPolicy.isWeakPin(pin),
    isCorrectFormat: (pin: string) => realPolicy.isCorrectFormat(pin),
  };
}

/** A mutable in-memory `worker_credentials` row + a PinRepository double over it. */
function makeCred(over: Partial<{
  pinHash: string;
  pepperVersion: number;
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCycles: number;
  otpCycleCount: number;
}> = {}) {
  return {
    workerId: WORKER,
    pinHash: `pin$${GOOD_PIN}`,
    pepperVersion: CURRENT_PIN_PEPPER_VERSION,
    failedAttempts: 0,
    lockedUntil: null as Date | null,
    lockoutCycles: 0,
    otpCycleCount: 0,
    ...over,
  };
}

/**
 * A PinRepository double over a single mutable credential row (or `null` = no PIN set). All
 * methods are vi.fn so tests can assert call-shape, while mutating the shared `row` so the
 * durable force-OTP state survives a Redis flush exactly like the real DB mirror.
 */
function makePins(initial: ReturnType<typeof makeCred> | null) {
  const state = { row: initial };
  const upsertPin = vi.fn(async (workerId: string, pinHash: string, pepperVersion: number) => {
    // Fresh start: a set/reset clears the WHOLE throttle incl. otp_cycle_count.
    state.row = makeCred({ pinHash, pepperVersion });
    state.row.workerId = workerId;
  });
  const findByWorkerId = vi.fn(async () => state.row ?? undefined);
  const clearThrottle = vi.fn(async () => {
    if (state.row) {
      state.row.failedAttempts = 0;
      state.row.lockedUntil = null;
      state.row.lockoutCycles = 0;
      // Deliberately LEAVES otp_cycle_count.
    }
  });
  const incrementOtpCycle = vi.fn(async () => {
    if (!state.row) return 0;
    state.row.otpCycleCount += 1;
    return state.row.otpCycleCount;
  });
  const recordFailureEscalation = vi.fn(
    async (_workerId: string, args: { lockoutCycles: number; otpCycleCount: number }) => {
      if (state.row) {
        state.row.failedAttempts = 0; // a lockout STEP resets the transient failed counter
        state.row.lockoutCycles = args.lockoutCycles;
        state.row.otpCycleCount = args.otpCycleCount;
      }
    },
  );
  const recordFailedAttempts = vi.fn(async (_workerId: string, failedAttempts: number) => {
    if (state.row) state.row.failedAttempts = failedAttempts;
  });
  return {
    state,
    repo: {
      upsertPin,
      findByWorkerId,
      clearThrottle,
      incrementOtpCycle,
      recordFailureEscalation,
      recordFailedAttempts,
    },
  };
}

/** A SessionService double that mints a deterministic login-shape session. */
function makeSessions(resolved: { workerId: string; deviceId: string } | null) {
  const ABSOLUTE_MS = Date.UTC(2026, 8, 25);
  return {
    resolveRefreshToken: vi.fn().mockResolvedValue(resolved),
    create: vi.fn().mockResolvedValue({
      access: { token: "jwt.token.value", expiresInSeconds: 2592000 },
      refresh: { token: "rt_new_value", expiresInSeconds: 7776000 },
      session: { tier: 0, expiresAtMs: Date.UTC(2026, 6, 27), requiresOtpAfterMs: ABSOLUTE_MS },
    }),
  };
}

/** Stub PII crypto — phone hash never echoes the raw phone. */
const pii = {
  hashPhone: (phone: string) => `hmac:${phone.length}`,
} as never;

interface BuildOpts {
  config?: Partial<ServerConfig>;
  cred?: ReturnType<typeof makeCred> | null;
  resolved?: { workerId: string; deviceId: string } | null;
  device?: { id: string } | null;
  otpVerifyThrows?: boolean;
  /** Latest worker_consents row for the A5 consent-on-resume gate. undefined = never consented. */
  consent?: { revokedAt: Date | null };
}

function build(opts: BuildOpts = {}) {
  const config = { ...BASE_CONFIG, ...opts.config } as ServerConfig;
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = { emit } as never;
  const hasher = makeHasher();

  const credInitial =
    opts.cred === undefined ? makeCred() : opts.cred; // undefined → default row; null → no PIN
  const pins = makePins(credInitial);

  const resolved =
    opts.resolved === undefined ? { workerId: WORKER, deviceId: DEVICE } : opts.resolved;
  const sessions = makeSessions(resolved);

  const device = opts.device === undefined ? { id: DEVICE } : opts.device;
  const devices = { findActiveById: vi.fn().mockResolvedValue(device) };

  const workers = { findByPhoneHash: vi.fn().mockResolvedValue({ id: WORKER }) };

  const otp = {
    verify: opts.otpVerifyThrows
      ? vi.fn().mockRejectedValue(new UnauthorizedException("Incorrect code"))
      : vi.fn().mockResolvedValue(undefined),
  };
  const auth = { requestOtp: vi.fn().mockResolvedValue({ success: true }) };
  const consents = { findLatestByWorker: vi.fn(async () => opts.consent) };

  const svc = new PinService(
    config,
    events,
    pii,
    hasher as unknown as PinHasher,
    pins.repo as never,
    workers as never,
    sessions as never,
    devices as never,
    otp as never,
    auth as never,
    consents as never,
    queue,
  );

  return { svc, redis, emit, hasher, pins, sessions, devices, workers, otp, auth, consents };
}

/** All event names emitted, in order. */
const emittedNames = (emit: ReturnType<typeof vi.fn>) =>
  emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

/** The (last) emitted event with the given name. */
const eventNamed = (emit: ReturnType<typeof vi.fn>, name: string) =>
  emit.mock.calls
    .map(
      (c) =>
        c[0] as {
          event_name: string;
          payload: Record<string, unknown>;
          actor?: Record<string, unknown>;
          subject?: Record<string, unknown>;
        },
    )
    .filter((e) => e.event_name === name)
    .pop();

const verifyInput = (over: Partial<VerifyPinInput> = {}): VerifyPinInput => ({
  refreshToken: REFRESH,
  pin: GOOD_PIN,
  ...over,
});

/** Assert a thrown verify failure is the ONE neutral 401 (no oracle in status/body). */
async function expectNeutral401(p: Promise<unknown>) {
  await expect(p).rejects.toBeInstanceOf(UnauthorizedException);
  await p.catch((e: UnauthorizedException) => {
    expect(e.getStatus()).toBe(401);
    expect(e.message).toBe("Could not verify PIN");
  });
}

// ===========================================================================
// CASE 2 — setPin
// ===========================================================================
describe("PinService.setPin", () => {
  it("rejects a wrong-LENGTH PIN with 400 BEFORE hashing", async () => {
    const { svc, hasher, pins, emit } = build();
    await expect(svc.setPin(WORKER, "135", ctx)).rejects.toBeInstanceOf(BadRequestException);
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(pins.repo.upsertPin).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects EVERY denylisted PIN with 400 BEFORE hashing", async () => {
    const denylist = [
      "0000", "1111", "2222", "9999", // all-same
      "1234", "2345", "6789", // ascending
      "4321", "9876", // descending
      "2580", "6969", // explicit
    ];
    for (const pin of denylist) {
      const { svc, hasher, pins } = build();
      await expect(svc.setPin(WORKER, pin, ctx), `expected ${pin} rejected`).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(hasher.hash, `${pin} must not hash`).not.toHaveBeenCalled();
      expect(pins.repo.upsertPin).not.toHaveBeenCalled();
    }
  });

  it("a good PIN hashes, upserts, and emits a PII-free worker.pin_set ({worker_id} only)", async () => {
    const { svc, hasher, pins, emit } = build();
    await svc.setPin(WORKER, GOOD_PIN, ctx);

    expect(hasher.hash).toHaveBeenCalledWith(GOOD_PIN);
    expect(pins.repo.upsertPin).toHaveBeenCalledWith(
      WORKER,
      `pin$${GOOD_PIN}`,
      CURRENT_PIN_PEPPER_VERSION,
    );

    const ev = eventNamed(emit, "worker.pin_set")!;
    expect(ev).toBeDefined();
    expect(ev.payload).toEqual({ worker_id: WORKER });
    expect(ev.actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    // No PIN / hash anywhere in the event.
    const json = JSON.stringify(ev);
    expect(json).not.toContain(GOOD_PIN);
    expect(json).not.toContain(`pin$${GOOD_PIN}`);
  });

  it("identity is the passed (token) worker id — never a body id (the controller passes CurrentWorker)", async () => {
    const { svc, pins } = build();
    await svc.setPin("worker-from-token", GOOD_PIN, ctx);
    expect(pins.repo.upsertPin).toHaveBeenCalledWith(
      "worker-from-token",
      expect.any(String),
      expect.any(Number),
    );
  });
});

// ===========================================================================
// CASE 3 — verifyPin happy path (trusted device)
// ===========================================================================
describe("PinService.verifyPin — happy path (trusted device)", () => {
  it("a correct PIN on a trusted device clears throttle, mints a session, emits pin_verified", async () => {
    const { svc, redis, pins, sessions, emit } = build();
    // Seed a stale transient throttle to prove SUCCESS clears it.
    redis.store.set(`pin_throttle:${WORKER}:${DEVICE}`, JSON.stringify({ failed: 2, lockedUntil: null, cycle: 0 }));

    const res = await svc.verifyPin(verifyInput(), ctx);

    // Login-shape session returned.
    expect(res.access_token).toBe("jwt.token.value");
    expect(res.token_type).toBe("Bearer");
    expect(res.expires_in_seconds).toBe(2592000);
    expect(res.worker_id).toBe(WORKER);
    expect(res.refresh_token).toBe("rt_new_value");
    expect(res.refresh_expires_in_seconds).toBe(7776000);
    expect(res.session.tier).toBe(0);
    expect(typeof res.session.expires_at).toBe("string");
    // finding #172-#1 — default build() consent is undefined (never consented) → false, matching
    // ConsentGuard admit. The cold PIN-unlock carries it so the app can route to /consent.
    expect(res.consent_accepted).toBe(false);

    // Session minted on the device-bound identity.
    expect(sessions.create).toHaveBeenCalledWith(WORKER, DEVICE);

    // Throttle cleared in BOTH stores.
    expect(redis.store.has(`pin_throttle:${WORKER}:${DEVICE}`)).toBe(false);
    expect(pins.repo.clearThrottle).toHaveBeenCalledWith(WORKER);

    // PII-free pin_verified with ONLY worker_id + device_id.
    const ev = eventNamed(emit, "worker.pin_verified")!;
    expect(ev.payload).toEqual({ worker_id: WORKER, device_id: DEVICE });
    const json = JSON.stringify(ev);
    expect(json).not.toContain(GOOD_PIN);
    expect(json).not.toContain(`pin$${GOOD_PIN}`);
    expect(json).not.toContain(REFRESH);
  });

  it("A5: a correct PIN but REVOKED consent → neutral 401, NO session minted, no pin_verified", async () => {
    const { svc, sessions, emit } = build({ consent: { revokedAt: new Date() } });
    await expectNeutral401(svc.verifyPin(verifyInput(), ctx));
    // A revoked-consent worker cannot resume via PIN, even with the correct PIN.
    expect(sessions.create).not.toHaveBeenCalled();
    expect(emittedNames(emit)).not.toContain("worker.pin_verified");
    // Ops still gets the PII-free verify-failed fact (reason is a log-only static code).
    expect(emittedNames(emit)).toContain("worker.pin_verify_failed");
  });

  it("A5: a correct PIN with never-consented (no row) still succeeds — onboarding not broken", async () => {
    const { svc, sessions } = build({ consent: undefined });
    const res = await svc.verifyPin(verifyInput(), ctx);
    expect(res.worker_id).toBe(WORKER);
    expect(sessions.create).toHaveBeenCalledWith(WORKER, DEVICE);
    // finding #172-#1 — never-consented → consent_accepted false (gate would DENY on /consent).
    expect(res.consent_accepted).toBe(false);
  });

  it("finding #172-#1: a correct PIN with ACTIVE consent (revokedAt null) reports consent_accepted=true", async () => {
    const { svc } = build({ consent: { revokedAt: null } });
    const res = await svc.verifyPin(verifyInput(), ctx);
    expect(res.worker_id).toBe(WORKER);
    // Reuses the same row the A5 revoked-gate read → mirrors ConsentGuard admit (accepted → true).
    expect(res.consent_accepted).toBe(true);
  });
});

// ===========================================================================
// CASE 4 — untrusted / unknown device
// ===========================================================================
describe("PinService.verifyPin — untrusted / unknown device (neutral, scrypt NOT consulted)", () => {
  it("an unresolvable refresh token → neutral 401, scrypt NOT consulted, no session, no event", async () => {
    const { svc, hasher, sessions, emit } = build({ resolved: null });
    await expectNeutral401(svc.verifyPin(verifyInput(), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    // No identity resolved ⇒ nothing to emit.
    expect(emit).not.toHaveBeenCalled();
  });

  it("a refresh token without a deviceId (unbound legacy) → neutral 401, no scrypt, no session", async () => {
    const { svc, hasher, sessions } = build({
      resolved: { workerId: WORKER, deviceId: "" as unknown as string },
    });
    await expectNeutral401(svc.verifyPin(verifyInput(), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("a resolved token whose device is revoked/unknown (findActiveById null) → neutral 401, no scrypt, verify-failed fact", async () => {
    const { svc, hasher, sessions, emit } = build({ device: null });
    await expectNeutral401(svc.verifyPin(verifyInput(), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    // A verify-failed fact is emitted (PII-free), but no pin_verified.
    expect(emittedNames(emit)).toContain("worker.pin_verify_failed");
    expect(emittedNames(emit)).not.toContain("worker.pin_verified");
    const ev = eventNamed(emit, "worker.pin_verify_failed")!;
    expect(ev.payload).toEqual({ worker_id: WORKER, device_id: DEVICE });
  });
});

// ===========================================================================
// CASE 5 — throttle / lockout ladder
// ===========================================================================
describe("PinService.verifyPin — throttle / lockout ladder", () => {
  it("PIN_MAX_ATTEMPTS wrong PINs arm an exponential lockout (locked_until set, base*2^0 on cycle 0)", async () => {
    const { svc, redis, emit } = build();
    const before = Date.now();
    for (let i = 0; i < BASE_CONFIG.PIN_MAX_ATTEMPTS; i += 1) {
      await expectNeutral401(svc.verifyPin(verifyInput({ pin: WRONG_PIN }), ctx));
    }
    const rec = JSON.parse(redis.store.get(`pin_throttle:${WORKER}:${DEVICE}`)!);
    // failed reset to 0, cycle advanced to 1, locked_until ~ now + 60s.
    expect(rec.failed).toBe(0);
    expect(rec.cycle).toBe(1);
    expect(rec.lockedUntil).toBeGreaterThan(before);
    expect(rec.lockedUntil - before).toBeGreaterThanOrEqual(60 * 1000 - 50);
    expect(rec.lockedUntil - before).toBeLessThan(70 * 1000);

    // pin_locked emitted on the cycle step (force_otp:false on a non-final cycle).
    const locked = eventNamed(emit, "worker.pin_locked")!;
    expect(locked.payload).toMatchObject({
      worker_id: WORKER,
      device_id: DEVICE,
      lockout_cycle: 1,
      force_otp: false,
    });
  });

  it("a verify WHILE the transient lockout window is open → neutral 401 WITHOUT consuming a scrypt", async () => {
    const { svc, redis, hasher, emit } = build();
    // Arm a lockout window 60s into the future.
    redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({ failed: 0, lockedUntil: Date.now() + 60_000, cycle: 1 }),
    );
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
    const ev = eventNamed(emit, "worker.pin_verify_failed")!;
    expect(ev.payload).toEqual({ worker_id: WORKER, device_id: DEVICE });
  });

  it("the backoff doubles per cycle (base * 2^cycle) on each ladder step", async () => {
    const { svc, redis } = build();
    // Pre-seed the throttle on cycle 2 with PIN_MAX_ATTEMPTS-1 fails so ONE more wrong PIN steps it.
    redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({ failed: BASE_CONFIG.PIN_MAX_ATTEMPTS - 1, lockedUntil: null, cycle: 2 }),
    );
    const before = Date.now();
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: WRONG_PIN }), ctx));
    const rec = JSON.parse(redis.store.get(`pin_throttle:${WORKER}:${DEVICE}`)!);
    expect(rec.cycle).toBe(3);
    // base * 2^2 = 60 * 4 = 240s.
    expect(rec.lockedUntil - before).toBeGreaterThanOrEqual(240 * 1000 - 50);
    expect(rec.lockedUntil - before).toBeLessThan(250 * 1000);
  });

  it("the FINAL cycle (nextCycle >= PIN_MAX_LOCKOUT_CYCLES) force-OTPs: increments otp_cycle, durably mirrors, emits pin_locked force_otp:true", async () => {
    const { svc, redis, pins, emit } = build();
    // Seed at cycle PIN_MAX_LOCKOUT_CYCLES-1 with one fail short of the lockout.
    redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({
        failed: BASE_CONFIG.PIN_MAX_ATTEMPTS - 1,
        lockedUntil: null,
        cycle: BASE_CONFIG.PIN_MAX_LOCKOUT_CYCLES - 1,
      }),
    );
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: WRONG_PIN }), ctx));

    // Durable escalation: otp_cycle_count incremented + lockout_cycles mirrored.
    expect(pins.repo.incrementOtpCycle).toHaveBeenCalledWith(WORKER);
    expect(pins.repo.recordFailureEscalation).toHaveBeenCalledWith(WORKER, {
      lockoutCycles: BASE_CONFIG.PIN_MAX_LOCKOUT_CYCLES,
      otpCycleCount: 1,
    });
    expect(pins.state.row!.otpCycleCount).toBeGreaterThanOrEqual(1);

    const locked = eventNamed(emit, "worker.pin_locked")!;
    expect(locked.payload).toMatchObject({
      worker_id: WORKER,
      device_id: DEVICE,
      lockout_cycle: BASE_CONFIG.PIN_MAX_LOCKOUT_CYCLES,
      force_otp: true,
    });
  });

  it("once force-OTP'd (otp_cycle_count>=1), a verify is neutral-failed BEFORE any scrypt (durable gate)", async () => {
    const { svc, hasher, emit } = build({ cred: makeCred({ otpCycleCount: 1 }) });
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
    const ev = eventNamed(emit, "worker.pin_verify_failed")!;
    expect(ev.payload).toEqual({ worker_id: WORKER, device_id: DEVICE });
  });

  it("a correct PIN clears the Redis + DB throttle but LEAVES otp_cycle_count untouched", async () => {
    // A row with throttle armed but NOT yet force-OTP'd (otp_cycle_count 0), so verify proceeds.
    const { svc, redis, pins } = build({
      cred: makeCred({ failedAttempts: 3, lockoutCycles: 2, otpCycleCount: 0 }),
    });
    redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({ failed: 3, lockedUntil: null, cycle: 2 }),
    );
    await svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx);
    // Transient gone; clearThrottle called; otp_cycle_count NOT touched by clearThrottle.
    expect(redis.store.has(`pin_throttle:${WORKER}:${DEVICE}`)).toBe(false);
    expect(pins.repo.clearThrottle).toHaveBeenCalledWith(WORKER);
    expect(pins.state.row!.otpCycleCount).toBe(0);
    expect(pins.state.row!.failedAttempts).toBe(0);
    expect(pins.state.row!.lockoutCycles).toBe(0);
  });
});

// ===========================================================================
// CASE 6 — force-OTP durability across a Redis flush
// ===========================================================================
describe("PinService.verifyPin — force-OTP survives a Redis flush", () => {
  it("with otp_cycle_count>=1 in the DB and an EMPTY Redis (flushed), a correct PIN still neutral-fails", async () => {
    const { svc, redis, hasher } = build({ cred: makeCred({ otpCycleCount: 1 }) });
    // Simulate a Redis flush: no transient throttle exists at all.
    redis.store.clear();
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));
    // The durable DB gate short-circuits BEFORE Redis/scrypt.
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it("the durable lockout_cycles mirror ALSO gates (>= PIN_MAX_LOCKOUT_CYCLES) even with otp_cycle_count 0", async () => {
    const { svc, redis, hasher } = build({
      cred: makeCred({ otpCycleCount: 0, lockoutCycles: BASE_CONFIG.PIN_MAX_LOCKOUT_CYCLES }),
    });
    redis.store.clear();
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  // CASE 6b — sub-K ladder REHYDRATION across a Redis flush (security Finding 1): a flush
  // mid-ladder must NOT reset the exponential ladder to cycle 0 with a zero-wait fresh budget.
  it("mid-ladder (cycles < K) + flushed Redis rehydrates from the durable mirror — re-locks, cycle preserved, no scrypt, no fresh budget", async () => {
    const { svc, redis, hasher, emit } = build({
      cred: makeCred({ lockoutCycles: 2, otpCycleCount: 0 }), // mid-ladder, NOT yet force-OTP
    });
    redis.store.clear(); // simulate a Redis flush/eviction of the transient throttle

    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));

    // Re-imposed lockout WITHOUT consuming a scrypt and WITHOUT a fresh attempt budget.
    expect(hasher.verify).not.toHaveBeenCalled();
    // Transient rehydrated from the durable cycle (preserved at 2, NOT reset to 0) + re-locked.
    const key = [...redis.store.keys()].find((k) => k.startsWith("pin_throttle:"));
    expect(key).toBeDefined();
    const rec = JSON.parse(redis.store.get(key!)!) as { cycle: number; lockedUntil: number };
    expect(rec.cycle).toBe(2);
    expect(rec.lockedUntil).toBeGreaterThan(Date.now());
    // Still a PII-free locked fact for ops.
    expect(emittedNames(emit)).toContain("worker.pin_verify_failed");
  });

  // CASE 6c — CYCLE-0 flush must NOT reset the attempt budget (security Finding 1). Before any
  // lockout is armed, lockout_cycles is still 0, so the cycle-mirror rehydration above does not
  // fire — the durable failed_attempts mirror is what stops a flush from handing back a fresh
  // zero-attempt budget.
  it("cycle-0 flush rehydrates failed_attempts from the durable mirror — the next wrong PIN arms the lockout, not a fresh budget", async () => {
    // Worker sits one attempt below PIN_MAX_ATTEMPTS at cycle 0 (no lockout yet), but Redis is
    // EMPTY (flushed/evicted). durable failed_attempts = MAX-1 must rehydrate so the next wrong
    // PIN is the MAX-th failure and arms the lockout.
    const { svc, redis, emit, pins } = build({
      cred: makeCred({
        failedAttempts: BASE_CONFIG.PIN_MAX_ATTEMPTS - 1,
        lockoutCycles: 0,
        otpCycleCount: 0,
      }),
    });
    expect(redis.store.size).toBe(0); // flushed: no transient pin_throttle key survives

    await expectNeutral401(svc.verifyPin(verifyInput({ pin: WRONG_PIN }), ctx));

    // The (MAX-1 durable + 1 now) = MAX-th failure armed the lockout — proof the flush did NOT
    // reset the budget to 0 (which would have given a non-lockout single failure instead).
    expect(emittedNames(emit)).toContain("worker.pin_locked");
    expect(pins.state.row?.lockoutCycles).toBe(1);
    const key = [...redis.store.keys()].find((k) => k.startsWith("pin_throttle:"));
    const rec = JSON.parse(redis.store.get(key!)!) as { cycle: number; lockedUntil: number };
    expect(rec.cycle).toBe(1);
    expect(rec.lockedUntil).toBeGreaterThan(Date.now());
  });
});

// ===========================================================================
// CASE 4b — no PIN set
// ===========================================================================
describe("PinService.verifyPin — no PIN set", () => {
  it("a worker with no credential row → neutral 401, equivalent-cost scrypt run, verify-failed fact", async () => {
    const { svc, hasher, sessions, emit } = build({ cred: null });
    await expectNeutral401(svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx));
    // The no-PIN path runs a throwaway scrypt to keep timing uniform — verify IS called here.
    expect(hasher.verify).toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(emittedNames(emit)).toContain("worker.pin_verify_failed");
    expect(emittedNames(emit)).not.toContain("worker.pin_verified");
  });
});

// ===========================================================================
// CASE 7 — NO-ORACLE: every negative path is the IDENTICAL thrown failure
// ===========================================================================
describe("PinService.verifyPin — NO-ORACLE (identical neutral failure on every negative path)", () => {
  /** Run a verify and capture the thrown UnauthorizedException's status + message + body. */
  async function captureFailure(opts: BuildOpts, pin = GOOD_PIN) {
    const { svc } = build(opts);
    try {
      await svc.verifyPin(verifyInput({ pin }), ctx);
      throw new Error("expected a neutral failure but verify resolved");
    } catch (e) {
      const ex = e as UnauthorizedException;
      return { status: ex.getStatus(), response: ex.getResponse(), message: ex.message };
    }
  }

  it("wrong-PIN, locked, untrusted-device, and no-PIN-set throw the SAME status + body (no distinguishing field)", async () => {
    const wrongPin = await captureFailure({}, WRONG_PIN);

    const lockedBuild = build();
    lockedBuild.redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({ failed: 0, lockedUntil: Date.now() + 60_000, cycle: 1 }),
    );
    const locked = await lockedBuild.svc
      .verifyPin(verifyInput({ pin: GOOD_PIN }), ctx)
      .then(() => {
        throw new Error("expected neutral failure");
      })
      .catch((e: UnauthorizedException) => ({
        status: e.getStatus(),
        response: e.getResponse(),
        message: e.message,
      }));

    const untrusted = await captureFailure({ device: null });
    const noPin = await captureFailure({ cred: null });
    const forceOtp = await captureFailure({ cred: makeCred({ otpCycleCount: 1 }) });
    const unresolved = await captureFailure({ resolved: null });

    const all = [wrongPin, locked, untrusted, noPin, forceOtp, unresolved];
    for (const f of all) {
      expect(f.status).toBe(401);
      expect(f.message).toBe("Could not verify PIN");
      expect(f).toEqual(all[0]); // byte-for-byte identical thrown shape
    }
  });
});

// ===========================================================================
// CASE 8 — Forgot-PIN reset
// ===========================================================================
describe("PinService.resetRequest", () => {
  it("reuses the existing OTP send path (AuthService.requestOtp) — NO new SMS path / oracle", async () => {
    const { svc, auth } = build();
    await svc.resetRequest(PHONE, ctx);
    expect(auth.requestOtp).toHaveBeenCalledWith(PHONE, ctx);
  });
});

describe("PinService.resetConfirm", () => {
  it("a valid OTP → denylist+hash the new PIN, upsert (clears throttle+otp_cycle), emit worker.pin_reset", async () => {
    const { svc, otp, workers, pins, hasher, emit } = build({
      cred: makeCred({ otpCycleCount: 2, failedAttempts: 4 }),
    });
    const NEW_PIN = "4826";

    await svc.resetConfirm(PHONE, "123456", NEW_PIN, ctx);

    expect(otp.verify).toHaveBeenCalledWith(PHONE, "123456");
    expect(workers.findByPhoneHash).toHaveBeenCalledWith("hmac:13"); // phone HASH, not raw
    expect(hasher.hash).toHaveBeenCalledWith(NEW_PIN);
    expect(pins.repo.upsertPin).toHaveBeenCalledWith(
      WORKER,
      `pin$${NEW_PIN}`,
      CURRENT_PIN_PEPPER_VERSION,
    );
    // The upsert double clears the whole throttle incl. otp_cycle_count.
    expect(pins.state.row!.otpCycleCount).toBe(0);
    expect(pins.state.row!.failedAttempts).toBe(0);

    const ev = eventNamed(emit, "worker.pin_reset")!;
    expect(ev.payload).toEqual({ worker_id: WORKER });
    const json = JSON.stringify(ev);
    expect(json).not.toContain(NEW_PIN);
    expect(json).not.toContain("123456"); // the OTP
    expect(json).not.toContain(PHONE);
  });

  it("a BAD OTP → rejected BEFORE any credential write (PIN unchanged, no pin_reset)", async () => {
    const original = makeCred({ otpCycleCount: 2 });
    const { svc, otp, workers, pins, emit } = build({ cred: original, otpVerifyThrows: true });

    await expect(svc.resetConfirm(PHONE, "000000", "4826", ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(otp.verify).toHaveBeenCalledWith(PHONE, "000000");
    // No worker lookup, no upsert, no event — the OTP gate fails first.
    expect(workers.findByPhoneHash).not.toHaveBeenCalled();
    expect(pins.repo.upsertPin).not.toHaveBeenCalled();
    expect(emittedNames(emit)).not.toContain("worker.pin_reset");
    // The credential row is untouched.
    expect(pins.state.row!.otpCycleCount).toBe(2);
  });

  it("a denylisted new PIN is rejected (400) even after a valid OTP, BEFORE hashing", async () => {
    const { svc, hasher, pins } = build();
    await expect(svc.resetConfirm(PHONE, "123456", "1234", ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(pins.repo.upsertPin).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CASE 9 — NO-PII: every emitted event is opaque-id/int/bool only
// ===========================================================================
describe("PinService — every emitted event is PII-free (no PIN / hash / fingerprint)", () => {
  it("across set, a full lockout ladder, a verify, and a reset, NO event leaks the PIN/hash/refresh/phone", async () => {
    // 1) set
    const setB = build();
    await setB.svc.setPin(WORKER, GOOD_PIN, ctx);

    // 2) a wrong-PIN ladder to force-OTP on a fresh service
    const ladderB = build();
    ladderB.redis.store.set(
      `pin_throttle:${WORKER}:${DEVICE}`,
      JSON.stringify({
        failed: BASE_CONFIG.PIN_MAX_ATTEMPTS - 1,
        lockedUntil: null,
        cycle: BASE_CONFIG.PIN_MAX_LOCKOUT_CYCLES - 1,
      }),
    );
    await expectNeutral401(ladderB.svc.verifyPin(verifyInput({ pin: WRONG_PIN }), ctx));

    // 3) a successful verify
    const okB = build();
    await okB.svc.verifyPin(verifyInput({ pin: GOOD_PIN }), ctx);

    // 4) a reset
    const resetB = build();
    await resetB.svc.resetConfirm(PHONE, "123456", "4826", ctx);

    const allCalls = [
      ...setB.emit.mock.calls,
      ...ladderB.emit.mock.calls,
      ...okB.emit.mock.calls,
      ...resetB.emit.mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);

    for (const call of allCalls) {
      const event = call[0] as { event_name: string; payload: Record<string, unknown> };
      const json = JSON.stringify(event);
      // No raw PINs, no hash tokens, no refresh token, no raw phone.
      expect(json, `${event.event_name} leaked a PIN`).not.toContain(GOOD_PIN);
      expect(json, `${event.event_name} leaked a PIN`).not.toContain(WRONG_PIN);
      expect(json, `${event.event_name} leaked a PIN`).not.toContain("4826");
      expect(json, `${event.event_name} leaked a hash`).not.toContain("pin$");
      expect(json, `${event.event_name} leaked a refresh token`).not.toContain(REFRESH);
      expect(json, `${event.event_name} leaked a phone`).not.toContain(PHONE);
      expect(json, `${event.event_name} leaked the OTP`).not.toContain("123456");

      // Every payload value is an opaque string id / number / boolean — never a nested object
      // that could smuggle a fingerprint, and the only known keys are id/int/bool fields.
      for (const [key, value] of Object.entries(event.payload)) {
        expect(
          ["string", "number", "boolean"].includes(typeof value),
          `${event.event_name}.${key} is not a scalar`,
        ).toBe(true);
      }
    }
  });
});
