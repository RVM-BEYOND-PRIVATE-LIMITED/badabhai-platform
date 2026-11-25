import { describe, expect, it } from "vitest";

import { EVENT_DOMAINS } from "./enums";
import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `app_version.policy_changed` (#3048). The contract under test: which app and platform, the old
 * and new minimum and latest builds, the store link and copy key after the write, and the admin —
 * `.strict()`, closed values, integers and ids only.
 */
function changedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "app_version.policy_changed",
    event_version: 1,
    occurred_at: "2026-11-25T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: UUID_B },
    subject: { subject_type: "admin_session", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      app: "worker",
      platform: "android",
      old_min_supported_build: 0,
      new_min_supported_build: 42,
      old_latest_build: 0,
      new_latest_build: 45,
      store_url: "https://play.google.com/store/apps/details?id=in.badabhai.worker",
      message_key: "update_default",
      updated_by_admin_id: UUID_B,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("app_version.policy_changed", () => {
  it("is registered as a version-1 event in its own app_version domain", () => {
    expect(isEventName("app_version.policy_changed")).toBe(true);
    expect(EVENT_DOMAINS).toContain("app_version");
    expect(EVENT_REGISTRY["app_version.policy_changed"]).toMatchObject({
      version: 1,
      domain: "app_version",
    });
  });

  it("pins the payload SHAPE: app, platform, old and new builds, link, key, admin; nothing else", () => {
    const def = EVENT_REGISTRY["app_version.policy_changed"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "app",
      "message_key",
      "new_latest_build",
      "new_min_supported_build",
      "old_latest_build",
      "old_min_supported_build",
      "platform",
      "store_url",
      "updated_by_admin_id",
    ]);
  });

  it("validates a raise, a lowering back to 0, and an unset store link", () => {
    expect(validateEvent(changedEvent()).success).toBe(true);
    expect(
      validateEvent(
        changedEvent({
          app: "payer",
          platform: "ios",
          old_min_supported_build: 42,
          new_min_supported_build: 0,
          store_url: null,
        }),
      ).success,
    ).toBe(true);
    expect(createEvent(changedEvent() as never).payload).toMatchObject({
      app: "worker",
      platform: "android",
      old_min_supported_build: 0,
      new_min_supported_build: 42,
    });
  });

  it("is STRICT: a device id, a phone or a reason cannot ride along", () => {
    for (const smuggled of ["device_id", "phone", "reason_text", "worker_id", "build_sha"]) {
      const result = validateEvent(changedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses an unknown app or platform, a negative or fractional build, a non-https link", () => {
    for (const over of [
      { app: "admin" },
      { platform: "web" },
      { old_min_supported_build: -1 },
      { new_min_supported_build: 1.5 },
      { new_latest_build: "45" },
      { store_url: "http://example.com/app.apk" },
      { store_url: "javascript:alert(1)" },
      { message_key: "Update Now" },
      { updated_by_admin_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(changedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
