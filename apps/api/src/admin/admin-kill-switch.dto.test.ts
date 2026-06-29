import { describe, it, expect } from "vitest";
import { AdminKillSwitchPauseRequestSchema } from "./admin-kill-switch.dto";

/**
 * DTO contract for the ADMIN-3c pause-request body (ADR-0025 OQ-6). The body is `.strict()` with
 * CLOSED enums — so no value/secret/free-text can ride onto the audited intent (Control: the spine
 * is never a value sink, §2 #2), and an unknown switch/reason is a 400 with no effect.
 */
describe("ADMIN-3c pause-request DTO", () => {
  it("accepts a known switch_key + reason_code", () => {
    const parsed = AdminKillSwitchPauseRequestSchema.safeParse({
      switch_key: "ai_real_calls",
      reason_code: "incident_response",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown switch_key (closed enum — no free text)", () => {
    const parsed = AdminKillSwitchPauseRequestSchema.safeParse({
      switch_key: "enable_everything",
      reason_code: "incident_response",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown reason_code (closed enum)", () => {
    const parsed = AdminKillSwitchPauseRequestSchema.safeParse({
      switch_key: "real_payments",
      reason_code: "owner_said_so",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing switch_key / reason_code (both required)", () => {
    expect(AdminKillSwitchPauseRequestSchema.safeParse({ switch_key: "ai_real_calls" }).success).toBe(
      false,
    );
    expect(
      AdminKillSwitchPauseRequestSchema.safeParse({ reason_code: "maintenance" }).success,
    ).toBe(false);
  });

  it("rejects an extra (value/secret-shaped) key (.strict — no value can ride in)", () => {
    const parsed = AdminKillSwitchPauseRequestSchema.safeParse({
      switch_key: "real_payments",
      reason_code: "cost_spike",
      provider_key: "sk_live_should_never_be_here",
    });
    expect(parsed.success).toBe(false);
  });

  it("offers NO field that could enable a provider (the body cannot carry a toggle/enable value)", () => {
    // A would-be "enable" body must fail strict parsing — there is no enable affordance at all.
    const parsed = AdminKillSwitchPauseRequestSchema.safeParse({
      switch_key: "ai_real_calls",
      reason_code: "maintenance",
      enable: true,
    });
    expect(parsed.success).toBe(false);
  });
});
