import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

const V2_INTENTS = [
  "edit_resume",
  "career_talk",
  "jobs_talk",
  "new_resume",
  "faltu",
  "unclear",
] as const;
const INTENT_SOURCES = ["v1_deterministic", "lexicon", "llm", "guard", "fallback"] as const;
const CONFIDENCE_BUCKETS = ["lt50", "50_70", "70_90", "gte90"] as const;
const OUTCOMES = [
  "served",
  "proposed",
  "phase_off",
  "clarify",
  "cooldown",
  "refused",
  "fallback",
] as const;
const SECTIONS = [
  "employment",
  "skills",
  "languages",
  "qualifications",
  "occupations",
  "preferences",
] as const;
const UNSUPPORTED = ["identity", "contact", "other"] as const;

/**
 * ADR-0046 Phase 1 events. Its own file, like the other versioned-payload files beside it.
 * The contract under test: every payload is `.strict()`, every added field is a closed enum or
 * a count, and NO worker text can ride along. The v1 `chat.companion_turn_served` entry stays
 * exactly what it shipped as.
 */
function envelope(eventName: string, version: number, payload: Record<string, unknown>) {
  return {
    event_id: UUID_A,
    event_name: eventName,
    event_version: version,
    occurred_at: "2026-09-28T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

/** A complete v2 turn payload — v1's fields plus the router's four. */
function turnV2Payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker_id: UUID_B,
    trigger: "message",
    intent: "digest",
    applied_count: 2,
    new_jobs_count: 3,
    jobs_scope: "profile",
    job_chips_count: 2,
    resume_source: "form",
    nudge: "apply_new",
    day: "2026-09-28",
    intent_source: "llm",
    v2_intent: "edit_resume",
    confidence_bucket: "70_90",
    outcome: "proposed",
    ...over,
  };
}

describe("chat.companion_turn_served_v2", () => {
  it("is registered as a version-2 chat-domain event; v1 is untouched beside it", () => {
    expect(isEventName("chat.companion_turn_served_v2")).toBe(true);
    expect(EVENT_REGISTRY["chat.companion_turn_served_v2"]).toMatchObject({
      version: 2,
      domain: "chat",
    });
    expect(EVENT_REGISTRY["chat.companion_turn_served"]).toMatchObject({ version: 1, domain: "chat" });
  });

  it("validates a full v2 turn and normalizes it through createEvent", () => {
    const parsed = validateEvent(envelope("chat.companion_turn_served_v2", 2, turnV2Payload()));
    expect(parsed.success).toBe(true);
    const event = createEvent(envelope("chat.companion_turn_served_v2", 2, turnV2Payload()) as never);
    expect(event.payload).toMatchObject({
      worker_id: UUID_B,
      intent_source: "llm",
      v2_intent: "edit_resume",
      confidence_bucket: "70_90",
      outcome: "proposed",
    });
  });

  it("accepts every intent, source, bucket and outcome of the closed sets", () => {
    for (const v2_intent of V2_INTENTS) {
      expect(
        validateEvent(
          envelope("chat.companion_turn_served_v2", 2, turnV2Payload({ v2_intent })),
        ).success,
        v2_intent,
      ).toBe(true);
    }
    for (const intent_source of INTENT_SOURCES) {
      expect(
        validateEvent(
          envelope("chat.companion_turn_served_v2", 2, turnV2Payload({ intent_source })),
        ).success,
        intent_source,
      ).toBe(true);
    }
    for (const confidence_bucket of CONFIDENCE_BUCKETS) {
      expect(
        validateEvent(
          envelope("chat.companion_turn_served_v2", 2, turnV2Payload({ confidence_bucket })),
        ).success,
        confidence_bucket,
      ).toBe(true);
    }
    for (const outcome of OUTCOMES) {
      expect(
        validateEvent(envelope("chat.companion_turn_served_v2", 2, turnV2Payload({ outcome })))
          .success,
        outcome,
      ).toBe(true);
    }
  });

  it("keeps v1's nullable-facts encodings: v2_intent / bucket nullable, jobs refine intact", () => {
    // A v1-resolver hit under the v2 flag: no classifier ran, so both router facts are null.
    const v1Hit = turnV2Payload({
      intent_source: "v1_deterministic",
      v2_intent: null,
      confidence_bucket: null,
      outcome: "served",
    });
    expect(validateEvent(envelope("chat.companion_turn_served_v2", 2, v1Hit)).success).toBe(true);

    // The v1 refine is restated on v2: a count with no scope, and a scope with no count, both fail.
    expect(
      validateEvent(
        envelope("chat.companion_turn_served_v2", 2, turnV2Payload({ jobs_scope: "no_skills" })),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        envelope(
          "chat.companion_turn_served_v2",
          2,
          turnV2Payload({ jobs_scope: null, new_jobs_count: null }),
        ),
      ).success,
    ).toBe(true);
  });

  it("rejects values outside the closed sets", () => {
    for (const bad of [
      { v2_intent: "smalltalk" },
      { intent_source: "model" },
      { confidence_bucket: "0.8" },
      { outcome: "ok" },
      { trigger: "tap" },
    ]) {
      const result = validateEvent(envelope("chat.companion_turn_served_v2", 2, turnV2Payload(bad)));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("is STRICT — worker text cannot ride along", () => {
    for (const smuggled of ["text", "reply", "message", "query", "answer", "transcript"]) {
      const result = validateEvent(
        envelope(
          "chat.companion_turn_served_v2",
          2,
          turnV2Payload({ [smuggled]: "mera naam badlo" }),
        ),
      );
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects the event under v1's version number — one version per name", () => {
    const result = validateEvent(
      envelope("chat.companion_turn_served_v2", 1, turnV2Payload()),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });

  it("v1 does NOT accept the v2 shape, and v1's own payload is unchanged", () => {
    const v1 = EVENT_REGISTRY["chat.companion_turn_served"];
    expect(
      v1.payload.safeParse({
        worker_id: UUID_B,
        trigger: "message",
        intent: "digest",
        applied_count: null,
        new_jobs_count: null,
        jobs_scope: null,
        job_chips_count: 0,
        resume_source: null,
        nudge: null,
        day: "2026-09-28",
      }).success,
    ).toBe(true);
    expect(v1.payload.safeParse(turnV2Payload()).success).toBe(false);
  });
});

describe("chat.companion_edit_proposed", () => {
  function proposed(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proposal_id: UUID_A,
      row_count: 2,
      sections: ["skills", "languages"],
      dropped_count: 0,
      unsupported: [],
      ...over,
    };
  }

  it("is registered v1 and accepts a card's shape", () => {
    expect(EVENT_REGISTRY["chat.companion_edit_proposed"]).toMatchObject({
      version: 1,
      domain: "chat",
    });
    expect(
      validateEvent(envelope("chat.companion_edit_proposed", 1, proposed())).success,
    ).toBe(true);
    expect(
      validateEvent(
        envelope(
          "chat.companion_edit_proposed",
          1,
          proposed({ unsupported: ["identity", "other"], dropped_count: 1 }),
        ),
      ).success,
    ).toBe(true);
  });

  it("accepts every catalogue section and unsupported reason", () => {
    for (const section of SECTIONS) {
      expect(
        validateEvent(
          envelope("chat.companion_edit_proposed", 1, proposed({ sections: [section] })),
        ).success,
        section,
      ).toBe(true);
    }
    for (const reason of UNSUPPORTED) {
      expect(
        validateEvent(
          envelope("chat.companion_edit_proposed", 1, proposed({ unsupported: [reason] })),
        ).success,
        reason,
      ).toBe(true);
    }
  });

  it("refuses a card with no rows / no sections and an unknown section", () => {
    for (const bad of [
      { row_count: 0 },
      { sections: [] },
      { sections: ["identity"] },
      { unsupported: ["phone"] },
      { dropped_count: -1 },
    ]) {
      const result = validateEvent(envelope("chat.companion_edit_proposed", 1, proposed(bad)));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("is STRICT — a before/after value or any text cannot ride along", () => {
    for (const smuggled of ["text", "value", "before", "after", "reply", "rows"]) {
      const result = validateEvent(
        envelope(
          "chat.companion_edit_proposed",
          1,
          proposed({ [smuggled]: "Tata Motors se Mahindra" }),
        ),
      );
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });
});

describe("chat.companion_edit_confirmed", () => {
  function confirmed(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proposal_id: UUID_A,
      applied_count: 2,
      sections: ["skills"],
      resume_regen: "queued",
      ...over,
    };
  }

  it("is registered v1 and accepts every regeneration outcome", () => {
    expect(EVENT_REGISTRY["chat.companion_edit_confirmed"]).toMatchObject({
      version: 1,
      domain: "chat",
    });
    for (const resume_regen of ["queued", "capped", "failed"] as const) {
      expect(
        validateEvent(envelope("chat.companion_edit_confirmed", 1, confirmed({ resume_regen })))
          .success,
        resume_regen,
      ).toBe(true);
    }
  });

  it("refuses a zero applied count, an unknown regen and an unknown section", () => {
    for (const bad of [
      { applied_count: 0 },
      { applied_count: -1 },
      { resume_regen: "retried" },
      { sections: ["photo"] },
      { sections: [] },
    ]) {
      const result = validateEvent(envelope("chat.companion_edit_confirmed", 1, confirmed(bad)));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("is STRICT — no written value may ride along", () => {
    for (const smuggled of ["text", "value", "new_value", "reply"]) {
      const result = validateEvent(
        envelope("chat.companion_edit_confirmed", 1, confirmed({ [smuggled]: "welding" })),
      );
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });
});

describe("chat.companion_edit_cancelled", () => {
  it("is registered v1 and accepts every reason", () => {
    expect(EVENT_REGISTRY["chat.companion_edit_cancelled"]).toMatchObject({
      version: 1,
      domain: "chat",
    });
    for (const reason of ["worker", "expired", "stale"] as const) {
      expect(
        validateEvent(
          envelope("chat.companion_edit_cancelled", 1, { proposal_id: UUID_C, reason }),
        ).success,
        reason,
      ).toBe(true);
    }
  });

  it("refuses an unknown reason, a non-uuid proposal and any smuggled text", () => {
    for (const bad of [
      { reason: "timeout" },
      { proposal_id: "p-1" },
      { proposal_id: UUID_C, reason: "worker", text: "kyun nahi hua" },
    ]) {
      const result = validateEvent(envelope("chat.companion_edit_cancelled", 1, bad));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });
});
