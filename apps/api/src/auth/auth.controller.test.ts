import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { OtpSendFailedException } from "../common/otp-send-failure";
import { AuthController } from "./auth.controller";
import { createHash } from "node:crypto";
import { OtpRequestIdempotency } from "./otp-request-idempotency.service";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import type { AuthService } from "./auth.service";
import type { SessionService } from "./session.service";
import type { OtpService } from "./otp.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { AccountDeletionService } from "./account-deletion.service";
import type { WorkersRepository } from "../workers/workers.repository";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { AuthenticatedWorker } from "./worker-auth.guard";
import {
  WorkerAccountDeletedException,
  WORKER_ACCOUNT_DELETED_CODE,
} from "./worker-account-deleted.exception";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid-1" };
// D-3 (review M1): a phone in the reserved synthetic range the test-login mint serves.
// The synthetic-range REFUSAL itself is the SERVICE's chokepoint (auth.service.test.ts);
// here the service is a double, so these cases cover the controller's caps/compose only.
const SYNTHETIC_PHONE = "+910000000000";

function make() {
  const auth = {
    requestOtp: vi.fn(async () => ({ success: true, channel: "sms" })),
    // pin_set is surfaced on the login response (ADR-0026 Phase 4) — the controller passes it through.
    verifyOtp: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok", pin_set: false })),
    // D-3 — the gated test-login mint (same login shape; the guard gates the route).
    testLogin: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok", pin_set: false })),
    // F4 (#168): the shared failure-signal seam — the account-delete step-up request
    // routes its Fast2SMS send through this so a delivery failure emits worker.otp_send_failed.
    issueAndSendWithSignals: vi.fn(async () => ({ resendInSeconds: 30 })),
  };
  const MINTED = {
    access: { token: "fresh", expiresInSeconds: 3600 },
    refresh: { token: "rt_new", expiresInSeconds: 7776000 },
    session: {
      tier: 1,
      expiresAtMs: Date.UTC(2026, 6, 27),
      requiresOtpAfterMs: Date.UTC(2026, 8, 25),
    },
  };
  const sessions = {
    refresh: vi.fn(async () => ({ token: "fresh", expiresInSeconds: 3600 })),
    revoke: vi.fn(async () => undefined),
    refreshByToken: vi.fn(async () => ({ ok: true, minted: MINTED })),
    resolveRefreshToken: vi.fn(async () => ({
      workerId: WORKER.id,
      sid: WORKER.sid,
      familyId: "fam-1",
    })),
    revokeAll: vi.fn(async () => 2),
    describe: vi.fn(async () => ({
      tier: 1,
      expiresAtMs: Date.UTC(2026, 6, 27),
      requiresOtpAfterMs: null,
    })),
  };
  const workers = {
    // SELECT * — the account-delete step-up path needs the encrypted phone to send the OTP.
    findById: vi.fn(async () => ({ id: WORKER.id, status: "active", phoneE164: "ENC(+91999)" })),
    // The out-of-band-deletion existence probe on POST /auth/token/refresh — DEFAULT-true (the
    // row is present); a case overrides it to false to assert the reserved 410 signal.
    existsById: vi.fn(async () => true),
    // ADR-0031 — GET /auth/me's EXPLICIT-projection read: status + the deletion marker only.
    // The absence of PII keys here is the point (see the /auth/me tests below).
    findSelfView: vi.fn(
      async (): Promise<{ status: string; deletionScheduledAt: Date | null } | undefined> => ({
        status: "active",
        deletionScheduledAt: null,
      }),
    ),
    // QA-ONLY immediate hard-delete seam — the transactional cascade delete the route reuses.
    // DEFAULT-true (a row was deleted); idempotent, so an already-gone row would return false.
    hardDelete: vi.fn(async () => true),
  };
  const ipRateLimit = {
    assertWithinHourlyIpCap: vi.fn(async () => undefined),
    // #1035 — the per-SENDER cap (device where the client named one, address otherwise). The
    // gate that is supposed to trip on the OTP routes; the per-IP one above is now only the
    // crude network flood ceiling above it.
    assertWithinHourlySenderCap: vi.fn(async () => undefined),
    // Review L1 — the IP-INDEPENDENT daily backstop on the test-login mint.
    assertWithinGlobalDailyCap: vi.fn(async () => undefined),
  };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn((t: string) => t.replace(/^ENC\(|\)$/g, "")) };
  // ADR-0031 — confirm SCHEDULES (never executes in-request); cancel is idempotent.
  const accountDeletion = {
    execute: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ scheduled_for: "2026-07-21T10:00:00.000Z" })),
    cancel: vi.fn(async () => ({ cancelled: true })),
  };
  const consents = { findLatestByWorker: vi.fn(async () => undefined) };
  // The two caps carry DIFFERENT values here on purpose. They are different questions —
  // a per-phone SMS budget vs a per-network abuse backstop — and the controller passing
  // the per-phone one to the per-IP limiter is the defect these values expose. Equal
  // numbers would let that regression pass unnoticed.
  // #1019 — the Idempotency-Key seam. A PASS-THROUGH double here: these cases send no
  // `Idempotency-Key`, which is exactly the path where `runOnce` must run the work unchanged,
  // so every existing assertion below keeps testing the handler and not the seam. The seam's
  // own behaviour is tested in otp-request-idempotency.service.test.ts.
  const otpIdempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const config = {
    OTP_MAX_SENDS_PER_HOUR: 5,
    OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR: 100,
    OTP_MAX_VERIFY_PER_IP_PER_HOUR: 5000,
    OTP_MAX_SENDS_PER_DEVICE_PER_HOUR: 20,
    // THREE DISTINCT VALUES ON PURPOSE (#1035 widened the pair to a trio). A per-phone SMS
    // budget, a per-handset send gate and a per-network flood ceiling are three different
    // questions, and every one of them has been passed to the wrong limiter at some point in
    // this file's history. Equal numbers would let the next such swap pass unnoticed.
    OTP_MAX_SENDS_PER_IP_PER_HOUR: 1000,
    TEST_LOGIN_MAX_PER_DAY: 200,
    // QA-ONLY immediate hard-delete seam — DEFAULT OFF, so the route 404s unless a case flips it.
    TEST_IMMEDIATE_DELETE_ENABLED: false,
  } as ServerConfig;
  const controller = new AuthController(
    auth as unknown as AuthService,
    sessions as unknown as SessionService,
    workers as unknown as WorkersRepository,
    ipRateLimit as unknown as IpRateLimit,
    otp as unknown as OtpService,
    pii as unknown as PiiCryptoService,
    accountDeletion as unknown as AccountDeletionService,
    consents as unknown as ConsentRepository,
    otpIdempotency as unknown as OtpRequestIdempotency,
    config,
  );
  return {
    controller,
    auth,
    sessions,
    workers,
    ipRateLimit,
    otp,
    pii,
    accountDeletion,
    consents,
    config,
  };
}

const reqWith = (overrides: Partial<Request> = {}): Request =>
  ({
    ip: "1.2.3.4",
    header: (k: string) => (k === "authorization" ? "Bearer tok" : undefined),
    ...overrides,
  }) as unknown as Request;

/** A device id of realistic shape — the worker app persists a UUID (`device_id.dart`). */
const DEVICE = "3f7c1b9a-0d4e-4c62-9a11-77b2c5e8d013";

/**
 * A request from a real worker-app build: same address as {@link reqWith}, plus the
 * `X-Device-Id` header `AuthedClient` puts on EVERY request. The pair is what lets these
 * cases hold the address constant and vary only the handset (#1035).
 */
const reqWithDevice = (deviceId: string = DEVICE): Request =>
  ({
    ip: "1.2.3.4",
    header: (k: string) => (k === "x-device-id" ? deviceId : undefined),
  }) as unknown as Request;

/** A request carrying the required Idempotency-Key header for POST /auth/token/refresh. */
const reqIdem = (): Request =>
  ({
    ip: "1.2.3.4",
    header: (k: string) => (k === "idempotency-key" ? "idem-1" : undefined),
  }) as unknown as Request;

describe("AuthController — consent-on-resume (A5 · ADR-0026 amendment)", () => {
  it("token/refresh: REVOKED consent → 403 and the token is NOT rotated", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: new Date(),
    });
    await expect(
      controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Denied BEFORE any rotation — the presented token is not consumed.
    expect(sessions.refreshByToken).not.toHaveBeenCalled();
  });

  it("token/refresh: NEVER-consented (no row) is ALLOWED — onboarding window not broken", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("token/refresh: ACTIVE consent (revokedAt null) is ALLOWED", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: null,
    });
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("token/refresh: an UNRESOLVABLE token skips the consent check (no oracle) and falls through", async () => {
    const { controller, sessions, consents } = make();
    (sessions.resolveRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });
});

// The cold-start half of the contract: POST /auth/token/refresh carries NO WorkerAuthGuard (the
// refresh token in the body IS the credential), so the guard's out-of-band-deletion 410 cannot
// run here. When a deleted worker's refresh token survives a raw row delete, the endpoint returns
// the SAME reserved 410 rather than minting a token for a ghost.
describe("AuthController — token/refresh out-of-band deletion → 410 WORKER_ACCOUNT_DELETED", () => {
  it("resolvable worker whose row is DELETED → 410 WORKER_ACCOUNT_DELETED and the token is NOT rotated", async () => {
    const { controller, sessions, workers, consents } = make();
    // Resolvable (refresh record survives) + not-revoked consent, but the DB row is gone.
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: null,
    });
    (workers.existsById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const err = await controller
      .tokenRefresh({ refresh_token: "rt" } as never, reqIdem())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerAccountDeletedException);
    expect((err as WorkerAccountDeletedException).getResponse()).toEqual({
      code: WORKER_ACCOUNT_DELETED_CODE,
      message: expect.any(String),
    });
    // Denied BEFORE any rotation — the presented token is not consumed / reuse-flagged.
    expect(sessions.refreshByToken).not.toHaveBeenCalled();
    expect(workers.existsById).toHaveBeenCalledWith(WORKER.id);
  });

  it("existing worker → rotates normally (no 410)", async () => {
    const { controller, sessions, workers } = make();
    (workers.existsById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("FAIL-SAFE: existence probe THROWS (DB down) → rotates normally, never a false 410", async () => {
    const { controller, sessions, workers } = make();
    (workers.existsById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("pg down"));
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("UNRESOLVABLE token → never probes existence (no oracle), falls through to the neutral 401 path", async () => {
    const { controller, sessions, workers } = make();
    (sessions.resolveRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(workers.existsById).not.toHaveBeenCalled();
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });
});

describe("AuthController", () => {
  it("requestOtp applies the sender cap FIRST, then the network cap, then delegates", async () => {
    const { controller, auth, ipRateLimit } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWithDevice(), CTX);
    expect(ipRateLimit.assertWithinHourlySenderCap).toHaveBeenCalledWith(
      "otp_request",
      { kind: "device", value: DEVICE },
      20,
    );
    // Its OWN scope, so it cannot collide with the `otp_request` address bucket the
    // no-device-header fallback still writes into.
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "otp_request_net",
      "1.2.3.4",
      1000,
    );
    expect(auth.requestOtp).toHaveBeenCalledWith("+91999", CTX);
  });

  it("#1035 — two handsets on ONE wifi do NOT share a bucket", async () => {
    // THE REPORTED BUG, as an assertion. Keyed on `req.ip` these two requests landed in one
    // bucket, so a handful of sign-ins on a factory wifi or a carrier CGNAT pool locked
    // everybody else out — and changing your phone number did nothing, because the number
    // was never the key. Same address, two device ids, two buckets.
    const { controller, ipRateLimit } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWithDevice("device-aaa1"), CTX);
    await controller.requestOtp({ phone: "+91888" } as never, reqWithDevice("device-bbb2"), CTX);
    const senders = (
      ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[1]);
    expect(senders).toEqual([
      { kind: "device", value: "device-aaa1" },
      { kind: "device", value: "device-bbb2" },
    ]);
  });

  it("#1035 — a client that sends no device id keeps the pre-change per-IP behaviour", async () => {
    // NOT A LOOPHOLE. An older build, a browser or curl lands in the SAME address bucket at
    // the SAME number as before this change; only clients that identify a handset get their
    // own. Dropping the header moves a caller into the shared bucket, which is stricter.
    const { controller, ipRateLimit, config } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWith(), CTX);
    expect(ipRateLimit.assertWithinHourlySenderCap).toHaveBeenCalledWith(
      "otp_request",
      { kind: "ip", value: "1.2.3.4" },
      config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
    );
  });

  it("#1035 — a device id too short to identify a handset falls back to the address", async () => {
    const { controller, ipRateLimit } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWithDevice("short"), CTX);
    expect(ipRateLimit.assertWithinHourlySenderCap).toHaveBeenCalledWith(
      "otp_request",
      { kind: "ip", value: "1.2.3.4" },
      20,
    );
  });

  it("each cap reads its OWN knob — never the per-phone SMS budget", async () => {
    // THE REGRESSION THIS LOCKS. The controller passed OTP_MAX_SENDS_PER_HOUR (5) to the
    // per-IP limiter: a per-PHONE budget sized against paid SMS spend, silently reused as a
    // per-NETWORK one. With no reverse proxy in the shipped topology `req.ip` is the NAT
    // egress address, so that made one office wifi — or one carrier CGNAT pool fronting
    // thousands of Jio / Airtel subscribers — worth five sign-ins an hour IN TOTAL, and the
    // 429 a locked-out worker saw was indistinguishable from the platform being down.
    //
    // #1035 adds the third number, and the same swap is available again: the sender gate must
    // read the per-DEVICE knob and the flood ceiling the per-IP one, never each other's.
    const { controller, ipRateLimit, config } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWithDevice(), CTX);
    const senderCap = (ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    const netCap = (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(senderCap).toBe(config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR);
    expect(netCap).toBe(config.OTP_MAX_SENDS_PER_IP_PER_HOUR);
    expect(senderCap).not.toBe(config.OTP_MAX_SENDS_PER_HOUR);
    expect(netCap).not.toBe(config.OTP_MAX_SENDS_PER_HOUR);
    // The flood ceiling must stay far ABOVE the sender gate, or it becomes the thing that
    // trips for a shared network — the bug, restored under a new name.
    expect(netCap).toBeGreaterThan(senderCap);
  });

  it("requestOtp sender-cap rejection blocks the send AND spares the shared bucket", async () => {
    // Sender first is why the second assertion holds: a handset that has already spent its
    // allowance must not also charge the ceiling its neighbours are counted against.
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.requestOtp({ phone: "+91999" } as never, reqWithDevice(), CTX),
    ).rejects.toBeTruthy();
    expect(auth.requestOtp).not.toHaveBeenCalled();
    expect(ipRateLimit.assertWithinHourlyIpCap).not.toHaveBeenCalled();
  });

  it("requestOtp network-cap rejection blocks the send", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.requestOtp({ phone: "+91999" } as never, reqWithDevice(), CTX),
    ).rejects.toBeTruthy();
    expect(auth.requestOtp).not.toHaveBeenCalled();
  });

  it("verifyOtp delegates phone + otp (+ optional device_info) and passes through pin_set", async () => {
    const { controller, auth } = make();
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWith(), CTX);
    // device_info is undefined when the client omits it (ADR-0026 Phase 2 — additive/opt-in).
    expect(auth.verifyOtp).toHaveBeenCalledWith("+91999", "1234", CTX, undefined);
    // ADR-0026 Phase 4 — the controller surfaces pin_set unchanged from the service.
    expect(res.pin_set).toBe(false);
  });

  // ---- #1132 — /auth/otp/verify carries the two-tier cap (device then network) ----

  it("verifyOtp caps the HANDSET first (senderOf), then the network — with the verify scopes (#1132)", async () => {
    const { controller, ipRateLimit, config } = make();
    await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWithDevice(), CTX);
    // Keyed on the DEVICE the client named, at the per-DEVICE knob — NOT req.ip (the #1035 rule).
    expect(ipRateLimit.assertWithinHourlySenderCap).toHaveBeenCalledWith(
      "otp_verify",
      { kind: "device", value: DEVICE },
      config.OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR,
    );
    // Its OWN network scope, at the flood-ceiling knob — never the per-device one.
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "otp_verify_net",
      "1.2.3.4",
      config.OTP_MAX_VERIFY_PER_IP_PER_HOUR,
    );
    // ...and its own knobs, NOT the send route's: a verify is not a send, each send licenses up
    // to OTP_MAX_ATTEMPTS of them, and these run outside `runOnce` so a retry ladder spends
    // three units where the send route spends one. Reusing the send budget would lock a worker
    // out of spending a code they are already holding.
    expect(config.OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR).not.toBe(
      config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
    );
    expect(config.OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR).toBeGreaterThan(
      config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
    );
  });

  it("verifyOtp: a sender-cap rejection blocks the verify device-first (no network charge, no work)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWithDevice(), CTX),
    ).rejects.toBeTruthy();
    // Device-first: a handset over its budget never charges the shared network bucket, and the
    // verify work never runs.
    expect(ipRateLimit.assertWithinHourlyIpCap).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  // ---- TD62 — additive consent_accepted on the login response ----

  it("verifyOtp: NEVER-consented worker (no row) → consent_accepted false", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWith(), CTX);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith(WORKER.id);
    expect(res.consent_accepted).toBe(false);
  });

  it("verifyOtp: ACTIVE consent (revokedAt null) → consent_accepted true", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: null,
    });
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWith(), CTX);
    expect(res.consent_accepted).toBe(true);
  });

  it("verifyOtp: REVOKED consent → consent_accepted false (client routes back to /consent)", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: new Date(),
    });
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWith(), CTX);
    expect(res.consent_accepted).toBe(false);
  });

  it("verifyOtp: a consent-read FAILURE still returns the 200 login — field OMITTED (F1)", async () => {
    // The OTP is consumed + session minted by the time the compose runs; a repo blip
    // must not 500 the succeeded login (the worker would burn another OTP against the
    // TD60 daily cap). The field is omitted; the app's tri-state passes through.
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db blip"),
    );
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, reqWith(), CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect(res.access_token).toBe("tok");
    expect("consent_accepted" in res).toBe(false); // omitted, never a defaulted value
  });

  // ---- D-3 — POST /auth/test-login (the guard 404s/401s the route; here: handler behaviour) ----

  it("testLogin applies ALL THREE caps (sender hour + network hour + global day) BEFORE the mint seam", async () => {
    const { controller, auth, ipRateLimit } = make();
    await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    // No device header on this caller (the e2e smoke does not send one), so the sender
    // resolves to the address — the pre-#1035 bucket, at the pre-#1035 number.
    expect(ipRateLimit.assertWithinHourlySenderCap).toHaveBeenCalledWith(
      "test_login",
      { kind: "ip", value: "1.2.3.4" },
      20,
    );
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "test_login_net",
      "1.2.3.4",
      1000,
    );
    // Review L1 — the IP-INDEPENDENT backstop: a token holder rotating IPs is still bounded.
    expect(ipRateLimit.assertWithinGlobalDailyCap).toHaveBeenCalledWith("test_login", 200);
    expect(auth.testLogin).toHaveBeenCalledWith(SYNTHETIC_PHONE, CTX);
  });

  it("testLogin buckets are the seam's OWN — they never compete with real sign-ins", async () => {
    // A shared scope would let e2e smoke traffic spend the throttle a real worker signs in
    // against. Both of this route's per-caller scopes must be distinct from the OTP ones.
    const { controller, ipRateLimit } = make();
    await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWithDevice(), CTX);
    const senderScope = (ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    const netScope = (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(senderScope).toBe("test_login");
    expect(netScope).toBe("test_login_net");
    expect(senderScope).not.toBe(netScope);
  });

  it("testLogin sender cap rejection blocks the mint (fail closed)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlySenderCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX),
    ).rejects.toBeTruthy();
    expect(auth.testLogin).not.toHaveBeenCalled();
  });

  it("testLogin per-IP cap rejection blocks the mint (fail closed)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(
      controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX),
    ).rejects.toBeTruthy();
    expect(auth.testLogin).not.toHaveBeenCalled();
  });

  it("testLogin GLOBAL daily cap rejection blocks the mint (L1 — the IP-rotation backstop)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinGlobalDailyCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("global cap"),
    );
    await expect(
      controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX),
    ).rejects.toBeTruthy();
    expect(auth.testLogin).not.toHaveBeenCalled();
  });

  it("testLogin does NOT mark consent: a never-consented worker gets consent_accepted false and consent is only READ", async () => {
    // Consent is NOT bypassed — the minted session behaves exactly like an OTP session:
    // the response carries the same TD62 tri-state compose (false here), and the only
    // consent interaction is the READ (ConsentRepository has no write called; the §6
    // ConsentGuard still denies the profiling routes until the worker accepts).
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith(WORKER.id);
    expect(res.consent_accepted).toBe(false);
  });

  it("testLogin returns the SAME login shape as verifyOtp (session/token pass-through, no PII)", async () => {
    const { controller } = make();
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect(res.access_token).toBe("tok");
    expect(res.pin_set).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("testLogin: a consent-read FAILURE still returns the 200 login — field OMITTED (F1 parity with verifyOtp)", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db blip"),
    );
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect("consent_accepted" in res).toBe(false);
  });

  it("me returns the authed worker id + status (no PII)", async () => {
    const { controller } = make();
    const res = await controller.me(WORKER);
    expect(res).toEqual({ worker_id: WORKER.id, status: "active" });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  // ---- ADR-0031 — /auth/me is the pending-deletion seam for EVERY entry path ----

  it("me CARRIES deletion_scheduled_for (ISO-8601) while a deletion is pending", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "active",
      deletionScheduledAt: new Date("2026-07-21T10:00:00.000Z"),
    });

    const res = await controller.me(WORKER);

    // The seam a PIN-unlock / refresh cold start can reach — OTP-verify is never hit there,
    // so without this the app has no banner and no way to cancel for the rest of the grace.
    expect(res).toEqual({
      worker_id: WORKER.id,
      status: "active",
      deletion_scheduled_for: "2026-07-21T10:00:00.000Z",
    });
  });

  it("me OMITS deletion_scheduled_for when nothing is pending (absent — never null)", async () => {
    const { controller } = make();
    const res = await controller.me(WORKER);
    // Absent vs null matters: the client's rule is `field present ⇔ deletion pending`.
    expect("deletion_scheduled_for" in res).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/deletion_scheduled_for/);
  });

  it("me reads the marker EXPLICITLY (findSelfView) — never the SELECT-* findById that carries PII", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "active",
      deletionScheduledAt: new Date("2026-07-21T10:00:00.000Z"),
    });

    const res = await controller.me(WORKER);

    expect(workers.findSelfView).toHaveBeenCalledWith(WORKER.id);
    expect(workers.findById).not.toHaveBeenCalled();
    // The pending response is PII-free: no phone/name/hash key, and no encrypted blob
    // (findById's row carries phoneE164: "ENC(+91999)" — it must not reach the wire).
    const serialized = JSON.stringify(res);
    expect(serialized).not.toMatch(/phone|full_?name|hash|ENC\(|\+91/i);
    expect(Object.keys(res).sort()).toEqual(["deletion_scheduled_for", "status", "worker_id"]);
  });

  it("me never FABRICATES a date: a worker row that vanished mid-session → status fallback, no field", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.me(WORKER);
    expect(res).toEqual({ worker_id: WORKER.id, status: "active" });
  });

  it("refresh mints a fresh token from the bearer", async () => {
    const { controller, sessions } = make();
    const res = await controller.refresh(reqWith());
    expect(sessions.refresh).toHaveBeenCalledWith("tok");
    expect(res).toEqual({ access_token: "fresh", token_type: "Bearer", expires_in_seconds: 3600 });
  });

  it("refresh 401s when the session is invalid/expired", async () => {
    const { controller, sessions } = make();
    (sessions.refresh as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(controller.refresh(reqWith())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logout revokes the current session id (and drops it from the worker set)", async () => {
    const { controller, sessions } = make();
    await controller.logout(WORKER);
    expect(sessions.revoke).toHaveBeenCalledWith(WORKER.sid, WORKER.id);
  });

  // ---- ADR-0026 Phase 1 endpoints ----

  const reqWithIdem = (key?: string): Request =>
    ({
      ip: "1.2.3.4",
      header: (k: string) => (k.toLowerCase() === "idempotency-key" ? key : undefined),
    }) as unknown as Request;

  it("tokenRefresh rejects a missing Idempotency-Key header with 400", async () => {
    const { controller, sessions } = make();
    await expect(
      controller.tokenRefresh({ refresh_token: "rt_old" } as never, reqWithIdem(undefined)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.refreshByToken).not.toHaveBeenCalled();
  });

  it("tokenRefresh rotates and returns the new access + refresh + session block", async () => {
    const { controller, sessions } = make();
    const res = await controller.tokenRefresh(
      { refresh_token: "rt_old" } as never,
      reqWithIdem("idem-1"),
    );
    expect(sessions.refreshByToken).toHaveBeenCalledWith("rt_old", "idem-1");
    expect(res.access_token).toBe("fresh");
    expect(res.refresh_token).toBe("rt_new");
    expect(res.token_type).toBe("Bearer");
    expect(res.session.tier).toBe(1);
    expect(typeof res.session.expires_at).toBe("string");
    expect(typeof res.session.requires_otp_after).toBe("string");
  });

  it("tokenRefresh 401s on an invalid/reused/expired refresh token (no oracle on which)", async () => {
    const { controller, sessions } = make();
    (sessions.refreshByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "reuse_detected",
    });
    await expect(
      controller.tokenRefresh({ refresh_token: "rt_used" } as never, reqWithIdem("idem-2")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logoutAll revokes all sessions for the worker (204, count in the event)", async () => {
    const { controller, sessions } = make();
    await controller.logoutAll(WORKER);
    expect(sessions.revokeAll).toHaveBeenCalledWith(WORKER.id);
  });

  it("session returns the tier/expiry introspection for the current session", async () => {
    const { controller, sessions } = make();
    const res = await controller.session(WORKER);
    expect(sessions.describe).toHaveBeenCalledWith(WORKER.id, WORKER.sid);
    expect(res.tier).toBe(1);
    expect(res.requires_otp_after).toBeNull();
    expect(typeof res.expires_at).toBe("string");
  });

  it("session 401s when the session record is gone", async () => {
    const { controller, sessions } = make();
    (sessions.describe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(controller.session(WORKER)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ---- ADR-0026 Phase 5 — DPDP account deletion (step-up OTP) ----

  it("accountDeleteRequest resolves the TOKEN worker's phone (never a body) and sends the OTP via the F4 signal seam", async () => {
    const { controller, workers, pii, auth } = make();
    const res = await controller.accountDeleteRequest(WORKER, reqWith(), CTX);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(pii.decrypt).toHaveBeenCalledWith("ENC(+91999)");
    // The send rides the SHARED AuthService seam (never otp.issueAndSend directly), so a
    // delivery failure emits worker.otp_send_failed exactly like the login path.
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
  });

  it("accountDeleteRequest 401s when the token worker row is gone (no oracle, fail closed)", async () => {
    const { controller, workers, auth } = make();
    (workers.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(controller.accountDeleteRequest(WORKER, reqWith(), CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auth.issueAndSendWithSignals).not.toHaveBeenCalled();
  });

  it("accountDeleteRequest on a send failure surfaces the neutral 502 THROUGH the emitting seam (F4)", async () => {
    // The seam (AuthService.issueAndSendWithSignals) emits worker.otp_send_failed once and
    // re-throws — proven in auth.service.test.ts. Here: the delete-request path delegates to
    // that exact seam and propagates the SAME neutral 502 unchanged.
    const { controller, auth } = make();
    (auth.issueAndSendWithSignals as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OtpSendFailedException({ provider: "fast2sms", reason: "transport" }),
    );
    await expect(controller.accountDeleteRequest(WORKER, reqWith(), CTX)).rejects.toMatchObject({
      status: 502,
      message: "Could not send the code, please retry",
    });
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
  });

  it("accountDeleteConfirm verifies the step-up OTP THEN schedules (ADR-0031) — 200 {success, scheduled_for}", async () => {
    const { controller, otp, accountDeletion } = make();
    const res = await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never, CTX);
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    // Confirm SCHEDULES — the erasure itself runs in the sweep after the grace elapses.
    expect(accountDeletion.schedule).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(accountDeletion.execute).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, scheduled_for: "2026-07-21T10:00:00.000Z" });
  });

  it("accountDeleteConfirm schedules NOTHING when the OTP verify throws (fail closed)", async () => {
    const { controller, otp, accountDeletion } = make();
    (otp.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new UnauthorizedException("bad otp"),
    );
    await expect(
      controller.accountDeleteConfirm(WORKER, { otp: "000000" } as never, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(accountDeletion.schedule).not.toHaveBeenCalled();
    expect(accountDeletion.execute).not.toHaveBeenCalled();
  });

  // ---- Phase 5 added coverage (QA gap-closure) ----

  it("accountDeleteConfirm IDENTITY is the GUARD's worker.id — a body worker_id is IGNORED (no IDOR)", async () => {
    // The handler signature only accepts {otp}; even if a hostile body smuggles a worker_id,
    // schedule() must always run against the TOKEN's worker.id, never the body. Assert the
    // scheduling + the OTP gate both target the guard identity, not the injected victim id.
    const { controller, otp, accountDeletion } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteConfirm(
      WORKER,
      {
        otp: "123456",
        worker_id: VICTIM,
      } as never,
      CTX,
    );
    // The OTP was verified against the TOKEN worker's phone (resolved from WORKER.id).
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    // The schedule targets the GUARD's id — never the injected victim id.
    expect(accountDeletion.schedule).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(accountDeletion.schedule).not.toHaveBeenCalledWith(VICTIM, expect.anything());
  });

  it("accountDeleteRequest resolves the phone from the GUARD worker (not a body) — body is unused", async () => {
    // /request takes no body param at all; the phone is derived from the token worker's
    // decrypted ciphertext. A would-be body worker_id can never redirect the OTP send.
    const { controller, workers, auth } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteRequest(WORKER, reqWith(), CTX);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(workers.findById).not.toHaveBeenCalledWith(VICTIM);
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
  });

  it("accountDeleteRequest NEVER returns the phone or the OTP — only success + resend_in_seconds", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteRequest(WORKER, reqWith(), CTX);
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
    const json = JSON.stringify(res);
    // No decrypted phone, no E.164 run, no OTP code in the response body.
    expect(json).not.toContain("+91999");
    expect(json).not.toMatch(/\d{6,}/); // no OTP-length / phone-length digit run
    expect(json).not.toMatch(/otp/i);
  });

  it("accountDeleteConfirm returns 200 {success, scheduled_for} and surfaces no PII", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never, CTX);
    expect(res).toEqual({ success: true, scheduled_for: "2026-07-21T10:00:00.000Z" });
    const json = JSON.stringify(res);
    // No decrypted phone, no OTP code — only the success flag + the PII-free due time.
    expect(json).not.toContain("+91999");
    expect(json).not.toMatch(/otp/i);
  });

  // ---- ADR-0031 — cancel-anytime during the grace window ----

  it("accountDeleteCancel delegates to cancel(worker.id, ctx) and returns { success: true }", async () => {
    const { controller, accountDeletion } = make();
    const res = await controller.accountDeleteCancel(WORKER, CTX);
    expect(accountDeletion.cancel).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(res).toEqual({ success: true });
  });

  it("accountDeleteCancel is idempotent: still { success: true } when nothing was pending (no oracle)", async () => {
    const { controller, accountDeletion } = make();
    (accountDeletion.cancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      cancelled: false,
    });
    const res = await controller.accountDeleteCancel(WORKER, CTX);
    expect(res).toEqual({ success: true });
  });

  it("accountDeleteCancel NEVER runs the erasure or the OTP gate (purely recoverable action)", async () => {
    const { controller, otp, accountDeletion } = make();
    await controller.accountDeleteCancel(WORKER, CTX);
    expect(otp.verify).not.toHaveBeenCalled();
    expect(accountDeletion.execute).not.toHaveBeenCalled();
    expect(accountDeletion.schedule).not.toHaveBeenCalled();
  });

  // ---- TD — QA-ONLY immediate hard-delete seam (POST /auth/account/delete/immediate) ----

  it("accountDeleteImmediate: FLAG ON → hard-deletes the GUARD's worker and returns { ok: true }", async () => {
    const { controller, workers, config } = make();
    config.TEST_IMMEDIATE_DELETE_ENABLED = true;
    const res = await controller.accountDeleteImmediate(WORKER);
    // The delete targets the TOKEN's worker.id (never a body) — reusing the existing cascade delete.
    expect(workers.hardDelete).toHaveBeenCalledWith(WORKER.id);
    expect(res).toEqual({ ok: true });
  });

  it("accountDeleteImmediate: FLAG ON, idempotent — an already-gone row is STILL { ok: true }", async () => {
    const { controller, workers, config } = make();
    config.TEST_IMMEDIATE_DELETE_ENABLED = true;
    (workers.hardDelete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const res = await controller.accountDeleteImmediate(WORKER);
    expect(res).toEqual({ ok: true });
  });

  it("accountDeleteImmediate: FLAG OFF (default) → 404 and NOTHING is deleted", async () => {
    // The neutral 404 makes the seam invisible on a normal build; the delete must never run.
    const { controller, workers } = make();
    await expect(controller.accountDeleteImmediate(WORKER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(workers.hardDelete).not.toHaveBeenCalled();
  });

  it("accountDeleteImmediate: does NOT route through the graceful AccountDeletionService (raw row delete only)", async () => {
    // Faithful to the out-of-band `DELETE FROM workers`: no grace schedule, no execute, no OTP gate.
    const { controller, accountDeletion, otp, config } = make();
    config.TEST_IMMEDIATE_DELETE_ENABLED = true;
    await controller.accountDeleteImmediate(WORKER);
    expect(accountDeletion.schedule).not.toHaveBeenCalled();
    expect(accountDeletion.execute).not.toHaveBeenCalled();
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it("accountDeleteImmediate: returns ONLY { ok: true } — no PII, no worker id echoed", async () => {
    const { controller, config } = make();
    config.TEST_IMMEDIATE_DELETE_ENABLED = true;
    const res = await controller.accountDeleteImmediate(WORKER);
    const json = JSON.stringify(res);
    expect(json).toBe('{"ok":true}');
    expect(json).not.toMatch(/phone|full_?name|1111/i);
  });
});

// Guard metadata (401 for an unauthenticated caller) is asserted structurally in
// account-deletion.module.boot.test.ts: all three deletion routes (request/confirm/cancel)
// carry @UseGuards(WorkerAuthGuard), so an unauthenticated request is rejected by the guard
// before any handler body runs. Cancel deliberately carries NO ConsentGuard (ADR-0031).

/**
 * #1019 — the route wiring, with the REAL seam rather than a pass-through double.
 *
 * The seam's own semantics are covered in `otp-request-idempotency.service.test.ts`. What can
 * only be asserted HERE is placement: the per-IP cap has to run INSIDE the guarded work, not in
 * front of it. It is one of the four counters the retry ladder was burning, and under carrier
 * CGNAT its bucket is shared by thousands of workers — so a dedupe that started after it would
 * still let one worker's flaky connection eat a whole network's hourly budget.
 */
describe("#1019 — POST /auth/otp/request honours Idempotency-Key", () => {
  function withRealSeam() {
    const store = new Map<string, string>();
    const redis = {
      set: async (k: string, v: string, _m: string, _t: number, nx?: string) => {
        if (nx === "NX" && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      },
      get: async (k: string) => store.get(k) ?? null,
    };
    const queue = {
      get client() {
        return Promise.resolve(redis);
      },
    };
    // Real digests, not length-based fakes: a fake that collides distinct keys would make the
    // fresh-key case below pass for the wrong reason.
    const pii = {
      hashPhone: (p: string) => createHash("sha256").update(p).digest("hex"),
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
    } as unknown as PiiCryptoService;
    const seam = new OtpRequestIdempotency(pii, new RequestIdempotency(pii, queue as never));

    const auth = {
      requestOtp: vi.fn(async () => ({
        success: true as const,
        channel: "sms" as const,
        resend_in_seconds: 30,
      })),
    };
    const ipRateLimit = {
      assertWithinHourlyIpCap: vi.fn(async () => undefined),
      assertWithinHourlySenderCap: vi.fn(async () => undefined),
    };
    const config = {
      OTP_MAX_SENDS_PER_DEVICE_PER_HOUR: 20,
      OTP_MAX_SENDS_PER_IP_PER_HOUR: 1000,
      OTP_RESEND_COOLDOWN_SECONDS: 30,
    } as ServerConfig;

    const controller = new AuthController(
      auth as unknown as AuthService,
      {} as unknown as SessionService,
      {} as unknown as WorkersRepository,
      ipRateLimit as unknown as IpRateLimit,
      {} as unknown as OtpService,
      {} as unknown as PiiCryptoService,
      {} as unknown as AccountDeletionService,
      {} as unknown as ConsentRepository,
      seam,
      config,
    );
    return { controller, auth, ipRateLimit };
  }

  const withKey = (key: string) =>
    reqWith({ header: ((k: string) => (k === "idempotency-key" ? key : undefined)) as never });

  it("sends once and caps once across the client's three transport retries", async () => {
    const { controller, auth, ipRateLimit } = withRealSeam();
    const req = withKey("k-1");

    const a = await controller.requestOtp({ phone: "+919876543210" } as never, req, CTX);
    const b = await controller.requestOtp({ phone: "+919876543210" } as never, req, CTX);
    const c = await controller.requestOtp({ phone: "+919876543210" } as never, req, CTX);

    // The whole defect: this used to be 3 — three counted sends, three paid SMS.
    expect(auth.requestOtp).toHaveBeenCalledTimes(1);
    // And the per-IP bucket — shared across a whole CGNAT egress — is charged once, not thrice.
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([
      { success: true, channel: "sms", resend_in_seconds: 30 },
      { success: true, channel: "sms", resend_in_seconds: 30 },
      { success: true, channel: "sms", resend_in_seconds: 30 },
    ]);
  });

  it("still sends for a genuine resend, which carries a fresh key", async () => {
    const { controller, auth } = withRealSeam();

    await controller.requestOtp({ phone: "+919876543210" } as never, withKey("k-1"), CTX);
    await controller.requestOtp({ phone: "+919876543210" } as never, withKey("k-2"), CTX);

    expect(auth.requestOtp).toHaveBeenCalledTimes(2);
  });

  it("is unchanged for a caller that sends no header at all (§3)", async () => {
    const { controller, auth, ipRateLimit } = withRealSeam();

    await controller.requestOtp({ phone: "+919876543210" } as never, reqWith(), CTX);
    await controller.requestOtp({ phone: "+919876543210" } as never, reqWith(), CTX);

    expect(auth.requestOtp).toHaveBeenCalledTimes(2);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(2);
  });
});


/**
 * #1023 — the two remaining routes on the same retry ladder, with the REAL seam.
 *
 * The seam's own semantics live in `otp-request-idempotency.service.test.ts`. What can only be
 * asserted HERE is that these two handlers actually read the header and pass the right scope —
 * and, for verify, that the whole `withConsentAccepted` compose sits INSIDE the guarded work, so
 * what a retry replays is the exact response the first attempt produced.
 */
describe("#1023 — verify and account-delete honour Idempotency-Key", () => {
  function withRealSeam() {
    const store = new Map<string, string>();
    const redis = {
      set: async (k: string, v: string, _m: string, _t: number, nx?: string) => {
        if (nx === "NX" && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      },
      get: async (k: string) => store.get(k) ?? null,
    };
    const queue = {
      get client() {
        return Promise.resolve(redis);
      },
    };
    const pii = {
      hashPhone: (v: string) => createHash("sha256").update(v).digest("hex"),
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
      encrypt: (t: string) => `enc:${Buffer.from(t, "utf8").toString("base64")}`,
      decrypt: (t: string) =>
        t.startsWith("enc:")
          ? Buffer.from(t.slice(4), "base64").toString("utf8")
          : // The controller ALSO calls decrypt() on the stored phone in resolvePhone, which is
            // not one of our ciphertexts — pass it through so both users of this stub work.
            t,
    } as unknown as PiiCryptoService;
    const seam = new OtpRequestIdempotency(pii, new RequestIdempotency(pii, queue as never));

    const auth = {
      verifyOtp: vi.fn(async () => ({ access_token: "at", refresh_token: "rt", pin_set: false })),
      issueAndSendWithSignals: vi.fn(async () => ({ resendInSeconds: 30 })),
    };
    const workers = { findById: vi.fn(async () => ({ phoneE164: "+919876543210" })) };
    const consents = { findLatestByWorker: vi.fn(async () => ({ revokedAt: null })) };
    // #1132 — verify now caps the handset+network BEFORE the reservation. A pass-through double
    // here: these cases exercise the idempotency ladder, not the cap, so the caps must resolve.
    const ipRateLimit = {
      assertWithinHourlySenderCap: vi.fn(async () => undefined),
      assertWithinHourlyIpCap: vi.fn(async () => undefined),
    };
    const config = {
      OTP_RESEND_COOLDOWN_SECONDS: 30,
      OTP_MAX_SENDS_PER_DEVICE_PER_HOUR: 20,
      OTP_MAX_SENDS_PER_IP_PER_HOUR: 1000,
    } as ServerConfig;

    const controller = new AuthController(
      auth as unknown as AuthService,
      {} as unknown as SessionService,
      workers as unknown as WorkersRepository,
      ipRateLimit as unknown as IpRateLimit,
      {} as unknown as OtpService,
      pii,
      {} as unknown as AccountDeletionService,
      consents as unknown as ConsentRepository,
      seam,
      config,
    );
    return { controller, auth, consents, store };
  }

  const key = (k: string) =>
    reqWith({ header: ((h: string) => (h === "idempotency-key" ? k : undefined)) as never });

  it("verify: one key across the ladder verifies ONCE — the attempt counter moves once", async () => {
    const { controller, auth } = withRealSeam();
    const body = { phone: "+919876543210", otp: "1234" } as never;

    const a = await controller.verifyOtp(body, key("k-1"), CTX);
    const b = await controller.verifyOtp(body, key("k-1"), CTX);
    const c = await controller.verifyOtp(body, key("k-1"), CTX);

    // ONE call to OtpService.verify — so `otp:attempts:<phoneHash>` moved once and the code was
    // consumed once, instead of a correct code being counted three times and refused.
    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("verify: replays the consent-composed RESPONSE, not a re-derived one", async () => {
    // `withConsentAccepted` is inside `work`, so the consent read happens once too. If the
    // compose sat outside the guard, a replay would re-read consent and could answer differently
    // from the response the first attempt actually sent.
    const { controller, consents } = withRealSeam();
    const body = { phone: "+919876543210", otp: "1234" } as never;

    const first = await controller.verifyOtp(body, key("k-2"), CTX);
    const replay = await controller.verifyOtp(body, key("k-2"), CTX);

    expect(consents.findLatestByWorker).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(first);
    expect(first.consent_accepted).toBe(true);
  });

  it("verify: never leaves the tokens in Redis in the clear", async () => {
    const { controller, store } = withRealSeam();
    await controller.verifyOtp({ phone: "+919876543210", otp: "1234" } as never, key("k-3"), CTX);

    const written = [...store.values()].join("\n");
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain('"access_token":"at"');
    expect(written).not.toContain('"refresh_token":"rt"');
  });

  it("verify: a fresh key is a real second attempt — a worker retyping is never replayed", async () => {
    const { controller, auth } = withRealSeam();
    const body = { phone: "+919876543210", otp: "1234" } as never;

    await controller.verifyOtp(body, key("k-4"), CTX);
    await controller.verifyOtp(body, key("k-5"), CTX);

    expect(auth.verifyOtp).toHaveBeenCalledTimes(2);
  });

  it("verify: a caller sending no header is unchanged (§3)", async () => {
    const { controller, auth } = withRealSeam();
    const body = { phone: "+919876543210", otp: "1234" } as never;

    await controller.verifyOtp(body, reqWith(), CTX);
    await controller.verifyOtp(body, reqWith(), CTX);

    expect(auth.verifyOtp).toHaveBeenCalledTimes(2);
  });

  it("account-delete: one key across the ladder sends ONE OTP", async () => {
    const { controller, auth } = withRealSeam();

    const a = await controller.accountDeleteRequest(WORKER, key("d-1"), CTX);
    const b = await controller.accountDeleteRequest(WORKER, key("d-1"), CTX);

    // One call to the SHARED issueAndSendWithSignals — so the per-phone hourly/daily counters
    // and the platform-wide breaker each moved once.
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(a).toEqual({ success: true, resend_in_seconds: 30 });
  });

  it("account-delete: a fresh key still sends, so a deliberate resend works", async () => {
    const { controller, auth } = withRealSeam();

    await controller.accountDeleteRequest(WORKER, key("d-2"), CTX);
    await controller.accountDeleteRequest(WORKER, key("d-3"), CTX);

    expect(auth.issueAndSendWithSignals).toHaveBeenCalledTimes(2);
  });

  it("account-delete and verify cannot replay into each other on one reused key", async () => {
    // Both routes resolve the SAME phone, so only the scope separates them. A client that
    // reuses one UUID across the two must get two independent operations.
    const { controller, auth } = withRealSeam();

    await controller.verifyOtp({ phone: "+919876543210", otp: "1234" } as never, key("same"), CTX);
    await controller.accountDeleteRequest(WORKER, key("same"), CTX);

    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1132 — POST /auth/otp/verify is rate-capped, and the cap runs BEFORE the reservation.
 *
 * Wires the REAL `IpRateLimit` and the REAL idempotency seam over ONE in-memory Redis, so these
 * assert BEHAVIOUR the mocked double cannot: the per-DEVICE budget actually trips (a), two
 * handsets on one address stay independent — the #1035 CGNAT guard (b) — and a throttled call
 * mints NO reservation because the limiter runs in FRONT of `runOnce`'s `SET NX` (c).
 */
describe("#1132 — /auth/otp/verify device-first cap, ahead of the idempotency reservation", () => {
  function harness(deviceCap: number) {
    // ONE store, two consumers: `incr`/`expire` back the rate-limit counters and `set`/`get`
    // back the idempotency reservation. Their key namespaces (`ratelimit:…` vs `otp_idem:…`)
    // never collide, so a single map faithfully models the shared Redis both write to.
    const store = new Map<string, string>();
    const redis = {
      incr: async (k: string) => {
        const n = Number(store.get(k) ?? "0") + 1;
        store.set(k, String(n));
        return n;
      },
      expire: async () => 1,
      set: async (k: string, v: string, _m?: string, _t?: number, nx?: string) => {
        if (nx === "NX" && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      },
      get: async (k: string) => store.get(k) ?? null,
    };
    const queue = {
      get client() {
        return Promise.resolve(redis);
      },
    };
    const pii = {
      hashPhone: (p: string) => createHash("sha256").update(p).digest("hex"),
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
      hashIp: (v: string) => createHash("sha256").update(`ip:${v}`).digest("hex"),
      encrypt: (t: string) => `enc:${Buffer.from(t, "utf8").toString("base64")}`,
      decrypt: (t: string) =>
        t.startsWith("enc:") ? Buffer.from(t.slice(4), "base64").toString("utf8") : t,
    } as unknown as PiiCryptoService;

    const ipRateLimit = new IpRateLimit(pii, queue as never);
    const seam = new OtpRequestIdempotency(pii, new RequestIdempotency(pii, queue as never));

    const auth = {
      verifyOtp: vi.fn(async () => ({ access_token: "at", refresh_token: "rt", pin_set: false })),
    };
    const consents = { findLatestByWorker: vi.fn(async () => ({ revokedAt: null })) };
    const config = {
      // The SEND knobs are set to a sentinel deliberately far from `deviceCap`: if verifyOtp
      // ever reads them again instead of its own pair, every cap assertion in this block stops
      // tripping and fails loudly, rather than passing for the wrong reason.
      OTP_MAX_SENDS_PER_DEVICE_PER_HOUR: 9999,
      OTP_MAX_SENDS_PER_IP_PER_HOUR: 9999,
      OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR: deviceCap,
      OTP_MAX_VERIFY_PER_IP_PER_HOUR: 1000,
    } as ServerConfig;

    const controller = new AuthController(
      auth as unknown as AuthService,
      {} as unknown as SessionService,
      {} as unknown as WorkersRepository,
      ipRateLimit,
      {} as unknown as OtpService,
      pii,
      {} as unknown as AccountDeletionService,
      consents as unknown as ConsentRepository,
      seam,
      config,
    );
    return { controller, auth, store };
  }

  const body = { phone: "+919876543210", otp: "1234" } as never;
  /** A request carrying BOTH the handset id and an idempotency key (the (c) case). */
  const deviceKeyReq = (deviceId: string, idemKey: string): Request =>
    ({
      ip: "1.2.3.4",
      header: (k: string) =>
        k === "x-device-id" ? deviceId : k === "idempotency-key" ? idemKey : undefined,
    }) as unknown as Request;

  it("(a) throttles a single handset after its per-device budget — the (cap+1)th verify is 429", async () => {
    const { controller, auth } = harness(3);
    // Three verifies from ONE handset land inside the budget...
    for (let i = 0; i < 3; i++) {
      await controller.verifyOtp(body, reqWithDevice("device-throttle-a"), CTX);
    }
    // ...the fourth trips the per-DEVICE cap with the neutral 429 every OTP throttle answers.
    await expect(
      controller.verifyOtp(body, reqWithDevice("device-throttle-a"), CTX),
    ).rejects.toMatchObject({ status: 429 });
    // The throttled call never reached the verify work — fail closed.
    expect(auth.verifyOtp).toHaveBeenCalledTimes(3);
  });

  it("(b) CGNAT guard — a second handset on the SAME address is NOT locked out by the first (#1035)", async () => {
    // THE REGRESSION #1035 FIXED, as an assertion. Both requests carry the SAME `req.ip`
    // (1.2.3.4) — the NAT egress / carrier-CGNAT address. Keyed on the address, device A
    // exhausting the budget would 429 device B too, locking out everyone behind the pool.
    // Keyed on the HANDSET, device B keeps its own full budget.
    const { controller } = harness(2);
    // Device A spends its entire budget and then trips.
    await controller.verifyOtp(body, reqWithDevice("device-aaa1"), CTX);
    await controller.verifyOtp(body, reqWithDevice("device-aaa1"), CTX);
    await expect(
      controller.verifyOtp(body, reqWithDevice("device-aaa1"), CTX),
    ).rejects.toMatchObject({ status: 429 });
    // Device B, on the SAME address, is untouched: two clean verifies, no 429.
    await expect(controller.verifyOtp(body, reqWithDevice("device-bbb2"), CTX)).resolves.toBeTruthy();
    await expect(controller.verifyOtp(body, reqWithDevice("device-bbb2"), CTX)).resolves.toBeTruthy();
  });

  it("(d) verify spends its OWN budget — the send buckets are untouched, at its own cap", async () => {
    // TWO PROPERTIES, both regressions waiting to happen if someone "tidies" the knobs back
    // together. (1) The verify caps read OTP_MAX_VERIFY_* — the harness sets the SEND knobs to
    // 9999, so a route reading those would never trip at all and (a) plus the 429 below would
    // both go green-but-wrong. (2) The buckets are scoped `otp_verify` / `otp_verify_net`, so
    // burning the verify budget does NOT spend the send budget: a worker throttled on verify
    // can still request a fresh code, which is the whole point of separating them.
    const { controller, store } = harness(2);
    await controller.verifyOtp(body, reqWithDevice("device-ddd4"), CTX);
    await controller.verifyOtp(body, reqWithDevice("device-ddd4"), CTX);
    await expect(
      controller.verifyOtp(body, reqWithDevice("device-ddd4"), CTX),
    ).rejects.toMatchObject({ status: 429 });

    const rateKeys = [...store.keys()].filter((k) => k.startsWith("ratelimit:"));
    // The device tier counted under the VERIFY scope...
    expect(rateKeys.some((k) => k.startsWith("ratelimit:dev:otp_verify:"))).toBe(true);
    // ...the network tier under its own...
    expect(rateKeys.some((k) => k.startsWith("ratelimit:ip:otp_verify_net:"))).toBe(true);
    // ...and NOTHING landed in the send route's buckets, so the code-request path is unspent.
    expect(rateKeys.some((k) => k.includes(":otp_request:"))).toBe(false);
    expect(rateKeys.some((k) => k.includes(":otp_request_net:"))).toBe(false);
  });

  it("(c) a throttled verify writes NO idempotency reservation (the limiter runs BEFORE runOnce)", async () => {
    // The core of #1132: the cap sits in FRONT of `runOnce`'s `SET NX`, so a call that is over
    // budget is refused before any reservation key is minted — an unauthenticated flood cannot
    // fill the noeviction Redis with idempotency keys. cap=1 so the SECOND call is throttled.
    const { controller, auth, store } = harness(1);
    const idemKeys = () => [...store.keys()].filter((k) => k.startsWith("otp_idem:"));

    await controller.verifyOtp(body, deviceKeyReq("device-ccc3", "k-1"), CTX);
    const afterFirst = idemKeys().length; // the first (accepted) call reserved exactly one key.
    expect(afterFirst).toBe(1);

    await expect(
      controller.verifyOtp(body, deviceKeyReq("device-ccc3", "k-2"), CTX),
    ).rejects.toMatchObject({ status: 429 });

    // No NEW reservation for the throttled key — proof the cap ran before the reservation write.
    // (Move the caps inside `runOnce.work` and this count becomes 2 and the test fails.)
    expect(idemKeys().length).toBe(afterFirst);
    // ...and the throttled call never ran the verify work.
    expect(auth.verifyOtp).toHaveBeenCalledTimes(1);
  });
});
