import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ReferralHelperController } from "./referral-helper.controller";
import type { ReferralHelperNameService } from "./referral-helper-name.service";

const CODE = "abcdef012345";
const IP = "203.0.113.7";

function make(opts: { enabled?: boolean; name?: string | null } = {}) {
  const service = { displayName: vi.fn().mockResolvedValue(opts.name ?? null) };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn().mockResolvedValue(undefined) };
  const config = {
    // An explicit `enabled: undefined` is kept (the key unset); only an absent key means on.
    REFERRAL_HELPER_NAME_ENABLED: "enabled" in opts ? opts.enabled : true,
    REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR: 20,
  } as unknown as ServerConfig;
  const ctrl = new ReferralHelperController(
    service as unknown as ReferralHelperNameService,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { ctrl, service, ipRateLimit };
}

describe("GET /referrals/helper — switch off (the default)", () => {
  it.each([undefined, false])("REFERRAL_HELPER_NAME_ENABLED=%s → 404", async (enabled) => {
    const { ctrl } = make({ enabled });
    await expect(ctrl.helper(CODE, IP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("off reads nothing: no rate-limit counter, no lookup, no name", async () => {
    const { ctrl, service, ipRateLimit } = make({ enabled: false });
    await expect(ctrl.helper(CODE, IP)).rejects.toThrow();
    expect(ipRateLimit.assertWithinHourlyIpCap).not.toHaveBeenCalled();
    expect(service.displayName).not.toHaveBeenCalled();
  });
});

describe("GET /referrals/helper — switch on", () => {
  it("an agency code → { display_name: <company name> }", async () => {
    const { ctrl, service } = make({ name: "Sharma Placement Agency" });
    await expect(ctrl.helper(CODE, IP)).resolves.toEqual({
      display_name: "Sharma Placement Agency",
    });
    expect(service.displayName).toHaveBeenCalledWith(CODE);
  });

  it("every null case is the SAME body, byte for byte (no oracle by status or shape)", async () => {
    const bodies: string[] = [];
    for (const code of [CODE, "unknown", "ABCDEF012345", undefined, ["a", "b"]]) {
      const { ctrl } = make({ name: null });
      bodies.push(JSON.stringify(await ctrl.helper(code, IP)));
    }
    expect(new Set(bodies)).toEqual(new Set(['{"display_name":null}']));
  });

  it("the raw query value reaches the service unvalidated (a malformed code is not a 400)", async () => {
    const { ctrl, service } = make();
    await ctrl.helper("not a code", IP);
    expect(service.displayName).toHaveBeenCalledWith("not a code");
  });

  it("caps per address with the attribute route's limiter and cap, in its OWN bucket", async () => {
    const { ctrl, ipRateLimit } = make();
    await ctrl.helper(CODE, IP);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("referral_helper", IP, 20);
  });

  it("an address-less request still counts, in the `unknown` bucket", async () => {
    const { ctrl, ipRateLimit } = make();
    await ctrl.helper(CODE, undefined as unknown as string);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith(
      "referral_helper",
      "unknown",
      20,
    );
  });

  it("over the cap → the limiter's 429 propagates and NO lookup runs", async () => {
    const { ctrl, service, ipRateLimit } = make({ name: "Sharma Placement Agency" });
    ipRateLimit.assertWithinHourlyIpCap.mockRejectedValueOnce(
      new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(ctrl.helper(CODE, IP)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(service.displayName).not.toHaveBeenCalled();
  });
});

describe("GET /referrals/helper — wiring", () => {
  it("is mounted at GET /referrals/helper, with no guard (the screen comes before sign-in)", () => {
    expect(Reflect.getMetadata("path", ReferralHelperController)).toBe("referrals");
    expect(Reflect.getMetadata("path", ReferralHelperController.prototype.helper)).toBe("helper");
    expect(Reflect.getMetadata("__guards__", ReferralHelperController.prototype.helper)).toBe(
      undefined,
    );
    expect(Reflect.getMetadata("__guards__", ReferralHelperController)).toBe(undefined);
  });

  it("answers with Cache-Control: no-store (a name for a bearer code is cached nowhere)", () => {
    expect(Reflect.getMetadata("__headers__", ReferralHelperController.prototype.helper)).toEqual([
      { name: "Cache-Control", value: "no-store" },
    ]);
  });
});
