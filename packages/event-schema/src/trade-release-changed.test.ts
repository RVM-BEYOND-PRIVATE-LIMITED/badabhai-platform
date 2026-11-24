import { describe, expect, it } from "vitest";

import { EVENT_DOMAINS } from "./enums";
import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `trade_release.changed` (#3002). The contract under test: the role kind, the two flags after
 * the write, and the admin who switched them — `.strict()`, ids and closed values only, one
 * event per REAL change.
 */
function changedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "trade_release.changed",
    event_version: 1,
    occurred_at: "2026-11-24T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: UUID_B },
    subject: { subject_type: "admin_session", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      role_kind: "gear_cutting_operator",
      posting_enabled: true,
      form_enabled: false,
      updated_by_admin_id: UUID_B,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("trade_release.changed", () => {
  it("is registered as a version-1 event in its own trade_release domain", () => {
    expect(isEventName("trade_release.changed")).toBe(true);
    expect(EVENT_DOMAINS).toContain("trade_release");
    expect(EVENT_REGISTRY["trade_release.changed"]).toMatchObject({
      version: 1,
      domain: "trade_release",
    });
  });

  it("pins the payload SHAPE: the kind, the two flags after the write, the admin, nothing else", () => {
    const def = EVENT_REGISTRY["trade_release.changed"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "form_enabled",
      "posting_enabled",
      "role_kind",
      "updated_by_admin_id",
    ]);
  });

  it("validates a switch on and a switch off", () => {
    expect(validateEvent(changedEvent()).success).toBe(true);
    expect(
      validateEvent(
        changedEvent({ role_kind: "cnc_turner", posting_enabled: false, form_enabled: false }),
      ).success,
    ).toBe(true);
    expect(createEvent(changedEvent() as never).payload).toEqual({
      role_kind: "gear_cutting_operator",
      posting_enabled: true,
      form_enabled: false,
      updated_by_admin_id: UUID_B,
    });
  });

  it("is STRICT: a reason, a name, a label or a second id cannot ride along", () => {
    for (const smuggled of ["reason_text", "reason_code", "role_label", "payer_id", "tenant_key"]) {
      const result = validateEvent(changedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a kind outside the role-kind shape, non-boolean flags and a non-uuid admin", () => {
    for (const over of [
      { role_kind: "" },
      { role_kind: "Gear Cutting" },
      { role_kind: "cnc_turner;" },
      { posting_enabled: "yes" },
      { form_enabled: 1 },
      { updated_by_admin_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(changedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
