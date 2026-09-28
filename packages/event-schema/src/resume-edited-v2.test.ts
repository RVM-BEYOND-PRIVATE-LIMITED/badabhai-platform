import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

const SAFE_FIELDS = ["name", "photo", "show_photo", "night_shift_ready"] as const;

/**
 * `resume.edited_v2` (#1318, owner ruling 2026-09-27 — the résumé SAFE-FIELD edit event).
 *
 * Its own file, like `resume-edited.test.ts` beside it. The contract under test: two opaque ids
 * and a closed field enum, `.strict()` — never the name, never a storage key, never the resulting
 * value of a pref. And v1 stays exactly what it shipped as.
 */
function editedV2Event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "resume.edited_v2",
    event_version: 2,
    occurred_at: "2026-09-27T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "resume", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: UUID_B,
      resume_id: UUID_C,
      field: "name",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("resume.edited_v2", () => {
  it("is registered as a version-2 resume-domain event", () => {
    expect(isEventName("resume.edited_v2")).toBe(true);
    expect(EVENT_REGISTRY["resume.edited_v2"]).toMatchObject({ version: 2, domain: "resume" });
  });

  it("validates a minimal event for every safe field", () => {
    for (const field of SAFE_FIELDS) {
      const parsed = editedV2Event({ field });
      expect(validateEvent(parsed).success).toBe(true);
      expect(createEvent(parsed as never).payload).toEqual({
        worker_id: UUID_B,
        resume_id: UUID_C,
        field,
      });
    }
  });

  it("carries exactly three keys — ids and the field enum, no value", () => {
    const event = createEvent(editedV2Event() as never);
    expect(Object.keys(event.payload as Record<string, unknown>).sort()).toEqual(
      ["field", "resume_id", "worker_id"].sort(),
    );
  });

  it("is STRICT — a name, a value or a storage key cannot ride along", () => {
    for (const smuggled of [
      "full_name",
      "name_value",
      "value",
      "old_value",
      "new_value",
      "storage_path",
      "photo_url",
      "phone",
      "text",
    ]) {
      const result = validateEvent(editedV2Event({ [smuggled]: "Asha Kumari" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects an unknown field — the enum is the PII boundary", () => {
    // v1's extracted-correction fields are NOT v2 fields: the two events describe different edits.
    for (const field of ["salary", "phone", "skills", "whatsapp", ""]) {
      const result = validateEvent(editedV2Event({ field }));
      expect(result.success, field).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects non-uuid ids and a missing résumé id", () => {
    for (const bad of [
      { worker_id: "not-a-uuid" },
      { resume_id: "res-1" },
      { resume_id: 42 },
      { resume_id: undefined },
    ]) {
      const result = validateEvent(editedV2Event(bad));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects the event under v1's version number — one version per name", () => {
    const result = validateEvent({ ...editedV2Event(), event_version: 1 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});

describe("resume.edited v1 — left EXACTLY as it shipped (invariant #8)", () => {
  const V1_PAYLOAD = {
    worker_id: UUID_A,
    profile_id: UUID_B,
    correction_id: UUID_C,
    session_id: UUID_D,
    field: "skills",
  };

  it("is still version 1 with its five extracted-correction fields", () => {
    const v1 = EVENT_REGISTRY["resume.edited"];
    expect(v1).toMatchObject({ version: 1, domain: "resume" });
    for (const field of ["skills", "machines", "experience", "education", "certificates"]) {
      expect(v1.payload.safeParse({ ...V1_PAYLOAD, field }).success).toBe(true);
    }
  });

  it("still REQUIRES correction_id / session_id / profile_id", () => {
    const v1 = EVENT_REGISTRY["resume.edited"];
    for (const key of ["correction_id", "session_id", "profile_id"] as const) {
      const { [key]: _dropped, ...without } = V1_PAYLOAD;
      expect(v1.payload.safeParse(without).success, key).toBe(false);
    }
  });

  it("does NOT accept a v2 shape or a v2 field — the two are genuinely distinct", () => {
    const v1 = EVENT_REGISTRY["resume.edited"];
    expect(
      v1.payload.safeParse({ worker_id: UUID_A, resume_id: UUID_E, field: "name" }).success,
    ).toBe(false);
    for (const field of SAFE_FIELDS) {
      expect(v1.payload.safeParse({ ...V1_PAYLOAD, field }).success, field).toBe(false);
    }
  });
});
