import { describe, expect, it } from "vitest";

import { DISPLAY_PREFS_SUBJECT_KINDS, DISPLAY_THEMES } from "@badabhai/types";

import { EVENT_DOMAINS } from "./enums";
import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `display_prefs.changed` (#2819). The contract under test: the subject kind, one opaque id and
 * two closed themes, `.strict()`, and `from !== to` — one event per REAL change, so a repeat of
 * the theme in force can never be recorded as one.
 */
function changedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "display_prefs.changed",
    event_version: 1,
    occurred_at: "2026-11-15T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: { subject_kind: "worker", subject_id: UUID_B, from: "light", to: "dark", ...over },
    metadata: { environment: "test", service: "api" },
  };
}

describe("display_prefs.changed", () => {
  it("is registered as a version-1 event in its own display_prefs domain", () => {
    expect(isEventName("display_prefs.changed")).toBe(true);
    expect(EVENT_DOMAINS).toContain("display_prefs");
    expect(EVENT_REGISTRY["display_prefs.changed"]).toMatchObject({
      version: 1,
      domain: "display_prefs",
    });
  });

  it.each([
    ["worker", "worker", "worker"],
    ["payer_user", "payer", "payer"],
    ["admin", "admin", "admin_session"],
  ])("validates a change by a %s login", (kind, actorType, subjectType) => {
    const parsed = changedEvent({ subject_kind: kind, from: "dark", to: "system" });
    parsed.actor = { actor_type: actorType, actor_id: UUID_B };
    parsed.subject = { subject_type: subjectType, subject_id: UUID_B };
    expect(validateEvent(parsed).success).toBe(true);
    expect(createEvent(parsed as never).payload).toEqual({
      subject_kind: kind,
      subject_id: UUID_B,
      from: "dark",
      to: "system",
    });
  });

  it("pins the payload SHAPE: the kind, the id and the two themes, nothing else", () => {
    const def = EVENT_REGISTRY["display_prefs.changed"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "from",
      "subject_id",
      "subject_kind",
      "to",
    ]);
    expect(def.payload.shape.from.options).toEqual([...DISPLAY_THEMES]);
    expect(def.payload.shape.to.options).toEqual([...DISPLAY_THEMES]);
    expect(def.payload.shape.subject_kind.options).toEqual([...DISPLAY_PREFS_SUBJECT_KINDS]);
  });

  it("refuses from === to: a repeat of the theme in force is never an event", () => {
    for (const theme of DISPLAY_THEMES) {
      const result = validateEvent(changedEvent({ from: theme, to: theme }));
      expect(result.success, theme).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("is STRICT: a name, a phone, a tenant or a device cannot ride along", () => {
    for (const smuggled of ["full_name", "phone", "email", "payer_id", "tenant_key", "device"]) {
      const result = validateEvent(changedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a theme or a kind outside the closed sets, and a non-uuid id", () => {
    for (const over of [
      { to: "ink" },
      { from: "Dark" },
      { subject_kind: "payer" },
      { subject_kind: "tenant" },
      { subject_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(changedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
