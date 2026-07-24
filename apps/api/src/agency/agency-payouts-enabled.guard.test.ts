import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { AgencyPayoutsEnabledGuard } from "./agency-payouts-enabled.guard";

function guard(enabled: boolean): AgencyPayoutsEnabledGuard {
  return new AgencyPayoutsEnabledGuard({ AGENCY_PAYOUTS_ENABLED: enabled } as unknown as ServerConfig);
}

describe("AgencyPayoutsEnabledGuard — launch gate (fail-safe inert)", () => {
  it("throws a NEUTRAL 404 when the flag is OFF (the default) — surface is fully inert", () => {
    expect(() => guard(false).canActivate()).toThrow(NotFoundException);
  });

  it("allows the request when the flag is ON", () => {
    expect(guard(true).canActivate()).toBe(true);
  });
});
