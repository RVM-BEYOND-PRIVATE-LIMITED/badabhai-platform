import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { PinController } from "./pin.controller";
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
  const config = {
    OTP_MAX_SENDS_PER_HOUR: 5,
    OTP_MAX_SENDS_PER_IP_PER_HOUR: 20,
  } as ServerConfig;
  const controller = new PinController(
    pin as unknown as PinService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { controller, pin, ipRateLimit };
}

const reqWith = (overrides: Partial<Request> = {}): Request =>
  ({ ip: "1.2.3.4", ...overrides }) as unknown as Request;

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
