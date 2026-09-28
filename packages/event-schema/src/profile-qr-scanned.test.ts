import { describe, expect, it } from "vitest";

import { REFERRAL_LINK_KINDS } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const LINK = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `profile.qr_scanned` (#1800, owner ruling 2026-09-28 — "Count + attribute worker signups").
 *
 * The contract under test: the résumé OWNER's opaque id, the opaque link row id, and a closed
 * platform enum — `.strict()`. The scanner is anonymous and nothing about them may ride along: not
 * the bearer code, not the IP or User-Agent, not the URL, not a phone or a name.
 */
function qrScannedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "profile.qr_scanned",
    event_version: 1,
    occurred_at: "2026-09-28T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "worker", subject_id: OWNER },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: OWNER,
      referral_link_id: LINK,
      platform: "android",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("profile.qr_scanned", () => {
  it("is registered as a version-1 profile-domain event", () => {
    expect(isEventName("profile.qr_scanned")).toBe(true);
    expect(EVENT_REGISTRY["profile.qr_scanned"]).toMatchObject({ version: 1, domain: "profile" });
  });

  it("validates each platform the resolver can derive", () => {
    for (const platform of ["android", "desktop", "other"]) {
      const parsed = qrScannedEvent({ platform });
      expect(validateEvent(parsed).success, platform).toBe(true);
      expect(createEvent(parsed as never).payload).toEqual({
        worker_id: OWNER,
        referral_link_id: LINK,
        platform,
      });
    }
  });

  it("pins the payload SHAPE — owner id, link id, platform, nothing else (invariant #8)", () => {
    const def = EVENT_REGISTRY["profile.qr_scanned"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "platform",
      "referral_link_id",
      "worker_id",
    ]);
    // The SAME closed enum `referral.link_clicked` carries — one vocabulary for "which device".
    expect(def.payload.shape.platform.options).toEqual(
      EVENT_REGISTRY["referral.link_clicked"].payload.shape.platform.options,
    );
  });

  it("is STRICT — the bearer code, the scanner's IP/UA, the URL or any identity cannot ride along", () => {
    for (const smuggled of [
      "code",
      "referral_code",
      "ip",
      "ip_hash",
      "click_hash",
      "user_agent",
      "ua",
      "url",
      "redirect_to",
      "phone",
      "full_name",
      "name",
      "scanner_worker_id",
      "resume_id",
    ]) {
      const result = validateEvent(qrScannedEvent({ [smuggled]: "abcdef012345" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects a platform outside the closed enum", () => {
    for (const platform of ["ios", "iphone", "Android", "", "windows", null]) {
      const result = validateEvent(qrScannedEvent({ platform }));
      expect(result.success, String(platform)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("requires both ids as uuids — never a code in the link-id slot", () => {
    for (const bad of [
      { worker_id: undefined },
      { referral_link_id: undefined },
      { referral_link_id: "abcdef012345" },
      { worker_id: "not-a-uuid" },
      { platform: undefined },
    ]) {
      const result = validateEvent(qrScannedEvent(bad));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects the event under any version but 1", () => {
    const result = validateEvent({ ...qrScannedEvent(), event_version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});

describe("referral.link_created — `kind` widened at v1 with resume_qr (#1800)", () => {
  function linkCreated(kind: unknown): Record<string, unknown> {
    return {
      event_id: UUID_A,
      event_name: "referral.link_created",
      event_version: 1,
      occurred_at: "2026-09-28T10:00:00.000Z",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "referral_link", subject_id: LINK },
      source: "api",
      correlation_id: UUID_D,
      causation_id: null,
      payload: { referral_link_id: LINK, kind, medium: "organic" },
      metadata: { environment: "test", service: "api" },
    };
  }

  it("the enum IS the shared REFERRAL_LINK_KINDS vocabulary", () => {
    expect(EVENT_REGISTRY["referral.link_created"].payload.shape.kind.options).toEqual([
      ...REFERRAL_LINK_KINDS,
    ]);
  });

  it("still validates every kind it validated before — the widening is additive", () => {
    for (const kind of ["agent", "worker", "campaign"]) {
      expect(validateEvent(linkCreated(kind)).success, kind).toBe(true);
    }
  });

  it("validates resume_qr and still rejects an unknown kind", () => {
    expect(validateEvent(linkCreated("resume_qr")).success).toBe(true);
    for (const kind of ["resume", "qr", "RESUME_QR", ""]) {
      expect(validateEvent(linkCreated(kind)).success, kind).toBe(false);
    }
  });
});
