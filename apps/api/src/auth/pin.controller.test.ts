import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { PinController } from "./pin.controller";
import { createHash } from "node:crypto";
import { OtpRequestIdempotency } from "./otp-request-idempotency.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { PinService } from "./pin.service";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { RequestContext } from "../common/request-context";

/**
 * PinController — thin HTTP. This suite covers the security-Finding-2 fix: POST
 * /auth/pin/reset/request MUST pass through the SAME per-IP hourly cap the login OTP path
 * (auth.controller requestOtp) applies BEFORE it reaches the OTP send. The cap shares the
 * "otp_request" scope so PIN-reset and login draw from ONE per-IP SMS budget.
 */

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PHONE = "+919876543210";

function make() {
  const pin = {
    setPin: vi.fn(async () => undefined),
    verifyPin: vi.fn(async () => ({}) as never),
    resetRequest: vi.fn(async () => undefined),
    resetConfirm: vi.fn(async () => undefined),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  // Distinct values: the per-IP limiter must read the per-IP knob, never the per-phone
  // SMS budget. Equal numbers would hide that regression (see auth.controller.test.ts).
  // #1019 — the Idempotency-Key seam. A PASS-THROUGH double here: these cases send no
  // `Idempotency-Key`, which is exactly the path where `runOnce` must run the work unchanged,
  // so every existing assertion below keeps testing the handler and not the seam. The seam's
  // own behaviour is tested in otp-request-idempotency.service.test.ts.
  const otpIdempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const config = {
    OTP_MAX_SENDS_PER_HOUR: 5,
    OTP_MAX_SENDS_PER_IP_PER_HOUR: 20,
  } as ServerConfig;
  const controller = new PinController(
    pin as unknown as PinService,
    ipRateLimit as unknown as IpRateLimit,
    otpIdempotency as unknown as OtpRequestIdempotency,
    config,
  );
  return { controller, pin, ipRateLimit, otpIdempotency };
}

// `header` is part of the stub because the handler now reads `Idempotency-Key` (#1019). A
// real Express Request always has it; leaving it off would fail on the shape, not the behaviour.
const reqWith = (overrides: Partial<Request> & { idempotencyKey?: string } = {}): Request => {
  const { idempotencyKey, ...rest } = overrides;
  return {
    ip: "1.2.3.4",
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key" ? idempotencyKey : undefined,
    ...rest,
  } as unknown as Request;
};

describe("PinController.resetRequest — per-IP cap (security Finding 2)", () => {
  it("applies the per-IP hourly cap FIRST (shared otp_request scope + config cap), then sends", async () => {
    const { controller, pin, ipRateLimit } = make();
    const res = await controller.resetRequest({ phone: PHONE } as never, reqWith(), CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("otp_request", "1.2.3.4", 20);
    expect(pin.resetRequest).toHaveBeenCalledWith(PHONE, CTX);
    expect(res).toEqual({ success: true });
  });

  it("a cap rejection (429) BLOCKS the send — no OTP is dispatched", async () => {
    const { controller, pin, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Too many requests from this network; please try again later"),
    );
    await expect(
      controller.resetRequest({ phone: PHONE } as never, reqWith(), CTX),
    ).rejects.toBeTruthy();
    // The send never happened — the cap fired before pin.resetRequest.
    expect(pin.resetRequest).not.toHaveBeenCalled();
  });

  it('a missing req.ip falls back to "unknown" (still capped, fails closed)', async () => {
    const { controller, ipRateLimit } = make();
    await controller.resetRequest({ phone: PHONE } as never, reqWith({ ip: undefined }), CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("otp_request", "unknown", 20);
  });
});

describe("PinController.resetConfirm — returns the minted session (#994)", () => {
  it("is 200 with a body, not 204 — a reset that returns nothing cannot re-credential the app", () => {
    // The status is the contract here: 204 is the shape that CAUSED #994 (the client stayed
    // on its dead refresh token). Asserted by reflection, like the ADR-0031 change to
    // /auth/account/delete/confirm, so a silently re-added @HttpCode(204) fails the build.
    expect(
      Reflect.getMetadata("__httpCode__", PinController.prototype.resetConfirm as object),
    ).toBe(200);
  });

  it("returns the service's session payload unchanged and forwards device_info", () => {
    // The controller is HTTP only — no re-shaping, no consent compose, no mint. And
    // device_info must reach the service: without it the minted session is unbound, and the
    // very next PIN unlock rejects it (pin.service verifyPin requires a resolved deviceId).
    const { controller, pin } = make();
    const minted = { access_token: "a", refresh_token: "r", worker_id: "w-1" };
    (pin.resetConfirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(minted);
    const deviceInfo = { device_id: "device-abcdef12", platform: "android" as const };

    const promise = controller.resetConfirm(
      { phone: PHONE, otp: "123456", pin: "4826", device_info: deviceInfo } as never,
      CTX,
    );

    expect(pin.resetConfirm).toHaveBeenCalledWith(PHONE, "123456", "4826", CTX, deviceInfo);
    return expect(promise).resolves.toBe(minted);
  });

  it("forwards an ABSENT device_info as undefined (still resets, just unbound)", () => {
    const { controller, pin } = make();
    void controller.resetConfirm({ phone: PHONE, otp: "123456", pin: "4826" } as never, CTX);
    expect(pin.resetConfirm).toHaveBeenCalledWith(PHONE, "123456", "4826", CTX, undefined);
  });
});

/**
 * #1019 — placement, with the REAL seam. The block above uses a pass-through double, which
 * cannot tell whether the per-IP cap sits inside the guarded work or in front of it — and
 * "in front of it" is the bug: that bucket is shared across a whole CGNAT egress, so one
 * worker's flaky connection would still eat a network's hourly budget three times over.
 * auth.controller.test.ts pins this for the login route; this pins it for PIN reset.
 */
describe("#1019 — POST /auth/pin/reset/request honours Idempotency-Key", () => {
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
    // Real digests: a length-based fake collides "k-1" with "k-2" and would make the
    // fresh-key case below pass for the wrong reason.
    const pii = {
      hashPhone: (p: string) => createHash("sha256").update(p).digest("hex"),
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
    } as unknown as PiiCryptoService;
    const seam = new OtpRequestIdempotency(pii, queue as never);

    const pin = { resetRequest: vi.fn(async () => undefined) };
    const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
    const config = { OTP_MAX_SENDS_PER_IP_PER_HOUR: 20 } as ServerConfig;
    const controller = new PinController(
      pin as unknown as PinService,
      ipRateLimit as unknown as IpRateLimit,
      seam,
      config,
    );
    return { controller, pin, ipRateLimit };
  }

  it("sends once and caps once across the client's three transport retries", async () => {
    const { controller, pin, ipRateLimit } = withRealSeam();
    const req = reqWith({ idempotencyKey: "k-1" });

    const a = await controller.resetRequest({ phone: PHONE } as never, req, CTX);
    const b = await controller.resetRequest({ phone: PHONE } as never, req, CTX);
    const c = await controller.resetRequest({ phone: PHONE } as never, req, CTX);

    expect(pin.resetRequest).toHaveBeenCalledTimes(1);
    // The per-IP cap is INSIDE the guard — this is the assertion the pass-through double cannot make.
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([{ success: true }, { success: true }, { success: true }]);
  });

  it("sends again for a genuine retry by the worker, which carries a fresh key", async () => {
    const { controller, pin } = withRealSeam();

    await controller.resetRequest(
      { phone: PHONE } as never,
      reqWith({ idempotencyKey: "k-1" }),
      CTX,
    );
    await controller.resetRequest(
      { phone: PHONE } as never,
      reqWith({ idempotencyKey: "k-2" }),
      CTX,
    );

    expect(pin.resetRequest).toHaveBeenCalledTimes(2);
  });

  it("does not share a dedupe bucket with the login route", async () => {
    // Same phone, same key, different scope: a login retry must never suppress a PIN reset.
    const { controller, pin } = withRealSeam();
    await controller.resetRequest(
      { phone: PHONE } as never,
      reqWith({ idempotencyKey: "shared" }),
      CTX,
    );
    expect(pin.resetRequest).toHaveBeenCalledTimes(1);
    // The scope is baked into the key, asserted directly in otp-request-idempotency.service.test.ts.
  });
});
