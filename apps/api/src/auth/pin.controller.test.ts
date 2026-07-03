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
  const config = { OTP_MAX_SENDS_PER_HOUR: 5 } as ServerConfig;
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
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("otp_request", "1.2.3.4", 5);
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
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("otp_request", "unknown", 5);
  });
});
