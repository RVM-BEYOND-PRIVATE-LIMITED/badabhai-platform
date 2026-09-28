import { describe, expect, it } from "vitest";

import { RESUME_SKINS } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `resume.skin_changed` (#1801, owner ruling 2026-09-28 — "Plumbing, Neela only").
 *
 * Its own file, like `resume-edited-v2.test.ts` beside it. The contract under test: one opaque id
 * and two closed skin enums, `.strict()` — a per-worker preference, so no `resume_id` and no
 * template id. The skin enum IS `RESUME_SKINS`, `neela` alone today; a skin the guideline names but
 * the owner has not approved (Saada, Kaagaz, Loha) must not validate.
 */
function skinChangedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "resume.skin_changed",
    event_version: 1,
    occurred_at: "2026-09-28T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: UUID_B,
      skin: "neela",
      previous_skin: null,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("resume.skin_changed", () => {
  it("is registered as a version-1 resume-domain event", () => {
    expect(isEventName("resume.skin_changed")).toBe(true);
    expect(EVENT_REGISTRY["resume.skin_changed"]).toMatchObject({ version: 1, domain: "resume" });
  });

  it("validates a first choice (previous_skin null) and a change between known skins", () => {
    for (const payload of [
      { skin: "neela", previous_skin: null },
      { skin: "neela", previous_skin: "neela" },
    ]) {
      const parsed = skinChangedEvent(payload);
      expect(validateEvent(parsed).success).toBe(true);
      expect(createEvent(parsed as never).payload).toEqual({ worker_id: UUID_B, ...payload });
    }
  });

  it("pins the payload SHAPE — the id and the two skins, nothing else (invariant #8)", () => {
    const def = EVENT_REGISTRY["resume.skin_changed"];
    expect(Object.keys(def.payload.shape).sort()).toEqual(["previous_skin", "skin", "worker_id"]);
    expect(def.payload.shape.skin.options).toEqual([...RESUME_SKINS]);
    expect(def.payload.shape.skin.options).toEqual(["neela"]);
  });

  it("is STRICT — a résumé id, a template id or any value cannot ride along", () => {
    for (const smuggled of [
      "resume_id",
      "template_id",
      "template_version",
      "full_name",
      "phone",
      "colour",
      "css",
    ]) {
      const result = validateEvent(skinChangedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects a skin outside RESUME_SKINS — including the three named but unapproved ones", () => {
    for (const skin of ["saada", "kaagaz", "loha", "Neela", "NEELA", "", "blue"]) {
      for (const payload of [{ skin }, { previous_skin: skin }]) {
        const result = validateEvent(skinChangedEvent(payload));
        expect(result.success, JSON.stringify(payload)).toBe(false);
        if (!result.success) expect(result.error.stage).toBe("payload");
      }
    }
  });

  it("requires skin and previous_skin (null, never absent) and a uuid worker id", () => {
    for (const bad of [
      { skin: undefined },
      { skin: null },
      { previous_skin: undefined },
      { worker_id: "not-a-uuid" },
    ]) {
      const result = validateEvent(skinChangedEvent(bad));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects the event under any version but 1", () => {
    const result = validateEvent({ ...skinChangedEvent(), event_version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});
