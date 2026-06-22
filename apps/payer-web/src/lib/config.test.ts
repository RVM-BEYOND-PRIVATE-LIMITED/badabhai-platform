import { describe, expect, it, vi, afterEach } from "vitest";
import { agencyFlags, __resetAgencyFlagsForTest } from "./config";

/**
 * Agency PUBLIC feature-flag tests. Every gate is FAIL-CLOSED: only the literal
 * "true" enables it. The portal gate defaults ON; every parked/dead/deferred flag
 * defaults OFF and ships nothing regardless.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  __resetAgencyFlagsForTest();
});

describe("agencyFlags — defaults", () => {
  it("defaults the portal ON and every parked flag OFF when unset", () => {
    const f = agencyFlags();
    expect(f.agencyPortalEnabled).toBe(true);
    expect(f.agencySupplyEnabled).toBe(false);
    expect(f.agencyKycEnabled).toBe(false);
    expect(f.agencyPayoutsEnabled).toBe(false);
    expect(f.agencyBulkUploadEnabled).toBe(false);
    expect(f.agencyOutcomeTrackingEnabled).toBe(false);
  });
});

describe("agencyFlags — fail-closed parsing", () => {
  it("turns the portal OFF only on an explicit non-true value", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_AGENCY_PORTAL", "false");
    __resetAgencyFlagsForTest();
    expect(agencyFlags().agencyPortalEnabled).toBe(false);
  });

  it("treats garbage as OFF for a parked flag (only 'true' enables)", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_AGENCY_KYC", "yes");
    __resetAgencyFlagsForTest();
    expect(agencyFlags().agencyKycEnabled).toBe(false);
  });

  it("accepts 'true' (case/space-insensitive) for a parked flag label", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS", "  TRUE ");
    __resetAgencyFlagsForTest();
    expect(agencyFlags().agencyPayoutsEnabled).toBe(true);
  });
});
