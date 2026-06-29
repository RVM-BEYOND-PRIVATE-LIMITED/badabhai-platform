import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { AdminKillSwitchService } from "./admin-kill-switch.service";

/**
 * ADMIN-3c kill-switch service (ADR-0025 OQ-6) — DISPLAY + safe-direction PAUSE INTENT only.
 * The lens: the status snapshot is PII-free + secret-free and honestly derived from config; a
 * pause request emits EXACTLY ONE value-free `admin.kill_switch_pause_requested`; and there is
 * NO code path that enables/disables/toggles a provider (§2 #5).
 */

const SECRET_GEMINI = "gemini-secret-key-should-never-surface";
const SECRET_WHATSAPP = "whatsapp-secret-key-should-never-surface";

/** A config fixture covering exactly the fields the status helpers read. */
function configFixture(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    AI_ENABLE_REAL_CALLS: false,
    GEMINI_FLASH_API_KEY: undefined,
    LITELLM_API_KEY: undefined,
    PAYMENTS_ENABLE_REAL: false,
    PAYMENTS_PROVIDER_KEY: undefined,
    MESSAGING_ENABLE_REAL: false,
    WHATSAPP_API_KEY: undefined,
    WHATSAPP_PHONE_NUMBER_ID: undefined,
    OTP_GLOBAL_MAX_SENDS_PER_DAY: 2000,
    PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 2000,
    RESUME_RENDER_ENABLED: false,
    ADMIN_PII_REVEAL_ENABLED: false,
    ...overrides,
  } as unknown as ServerConfig;
}

function makeService(config: ServerConfig) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = { emit } as unknown as EventsService;
  return { service: new AdminKillSwitchService(events, config), emit };
}

const ctx = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" } as unknown as RequestContext;
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";

describe("AdminKillSwitchService.buildStatus (DISPLAY, OQ-6 a)", () => {
  it("returns all seven known switches with the invariant note", () => {
    const { service } = makeService(configFixture());
    const res = service.buildStatus();
    expect(res.switches.map((s) => s.key).sort()).toEqual(
      [
        "ai_real_calls",
        "real_payments",
        "real_messaging",
        "worker_otp_sms",
        "payer_otp_email",
        "resume_render",
        "admin_pii_reveal",
      ].sort(),
    );
    expect(res.note.toLowerCase()).toContain("never a portal toggle");
  });

  it("derives the safe (alpha-default) states: real paths blocked, OTP live, flags disabled", () => {
    const { service } = makeService(configFixture());
    const res = service.buildStatus();
    const stateOf = (k: string) => res.switches.find((s) => s.key === k)!.state;
    expect(stateOf("ai_real_calls")).toBe("blocked");
    expect(stateOf("real_payments")).toBe("blocked");
    expect(stateOf("real_messaging")).toBe("blocked");
    expect(stateOf("worker_otp_sms")).toBe("live");
    expect(stateOf("payer_otp_email")).toBe("live");
    expect(stateOf("resume_render")).toBe("disabled");
    expect(stateOf("admin_pii_reveal")).toBe("disabled");
  });

  it("reflects a real-enabled + paused posture (ai live, OTP paused at cap 0)", () => {
    const { service } = makeService(
      configFixture({
        AI_ENABLE_REAL_CALLS: true,
        GEMINI_FLASH_API_KEY: SECRET_GEMINI,
        OTP_GLOBAL_MAX_SENDS_PER_DAY: 0,
        ADMIN_PII_REVEAL_ENABLED: true,
      }),
    );
    const res = service.buildStatus();
    const stateOf = (k: string) => res.switches.find((s) => s.key === k)!.state;
    expect(stateOf("ai_real_calls")).toBe("live");
    expect(stateOf("worker_otp_sms")).toBe("paused");
    expect(stateOf("admin_pii_reveal")).toBe("live");
  });

  it("NEVER surfaces a secret value (only var NAMES + PII-free reasons appear)", () => {
    const { service } = makeService(
      configFixture({
        AI_ENABLE_REAL_CALLS: true,
        GEMINI_FLASH_API_KEY: SECRET_GEMINI,
        MESSAGING_ENABLE_REAL: true,
        WHATSAPP_API_KEY: SECRET_WHATSAPP,
        WHATSAPP_PHONE_NUMBER_ID: "123456",
      }),
    );
    const serialized = JSON.stringify(service.buildStatus());
    expect(serialized).not.toContain(SECRET_GEMINI);
    expect(serialized).not.toContain(SECRET_WHATSAPP);
  });

  it("every pause_via is a SAFE-DIRECTION lever (=false or =0); none enables anything", () => {
    const { service } = makeService(configFixture());
    for (const s of service.buildStatus().switches) {
      expect(s.pause_via).toMatch(/=(false|0)\b/);
      expect(s.pause_via.toLowerCase()).not.toContain("=true");
    }
  });

  it("emits NO event for a status read (observability, not a state change)", () => {
    const { service, emit } = makeService(configFixture());
    service.buildStatus();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("AdminKillSwitchService.requestPause (safe-direction INTENT, OQ-6 b)", () => {
  it("emits EXACTLY ONE value-free admin.kill_switch_pause_requested with the correct envelope", async () => {
    const { service, emit } = makeService(configFixture());
    const res = await service.requestPause(
      ADMIN_ID,
      { switch_key: "ai_real_calls", reason_code: "incident_response" },
      ctx,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("admin.kill_switch_pause_requested");
    expect(arg.actor).toEqual({ actor_type: "admin", actor_id: ADMIN_ID });
    expect(arg.subject).toEqual({ subject_type: "kill_switch", subject_id: null });
    // PII-FREE & VALUE-FREE: opaque admin_id + switch KEY + reason CODE ONLY.
    expect(arg.payload).toEqual({
      admin_id: ADMIN_ID,
      switch_key: "ai_real_calls",
      reason_code: "incident_response",
    });

    expect(res.recorded).toBe(true);
    expect(res.switch_key).toBe("ai_real_calls");
    // The response is honest: it records intent + points at the env lever; it does not flip runtime.
    expect(res.action_required).toContain("AI_ENABLE_REAL_CALLS=false");
  });

  it("the emitted payload carries no value beyond {admin_id, switch_key, reason_code}", async () => {
    const { service, emit } = makeService(configFixture());
    await service.requestPause(
      ADMIN_ID,
      { switch_key: "real_payments", reason_code: "cost_spike" },
      ctx,
    );
    const payload = (emit.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(["admin_id", "reason_code", "switch_key"].sort());
  });

  it("the service exposes ONLY buildStatus + requestPause (no enable/disable/toggle method)", () => {
    const methods = Object.getOwnPropertyNames(AdminKillSwitchService.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual(["buildStatus", "requestPause"].sort());
    // Defense-in-depth: no method name hints at enabling a provider.
    for (const m of methods) {
      expect(m.toLowerCase()).not.toMatch(/enable|resume|toggle|activate/);
    }
  });
});
