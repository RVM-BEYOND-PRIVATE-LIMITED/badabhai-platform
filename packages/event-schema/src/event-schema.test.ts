import { describe, it, expect } from "vitest";
import {
  validateEvent,
  createEvent,
  assertValidEvent,
  EventValidationException,
  EVENT_NAMES,
  EVENT_REGISTRY,
  isEventName,
  MAX_VOICE_NOTE_SECONDS,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

/** A minimal valid `worker.created` event used as a base for mutation tests. */
function workerCreatedEvent(): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "worker.created",
    event_version: 1,
    occurred_at: "2026-06-08T10:00:00.000Z",
    actor: { actor_type: "system" },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_C,
    causation_id: null,
    payload: { worker_id: UUID_B, phone_hash: "hash_abc123", status: "pending" },
    metadata: { environment: "test", service: "api" },
  };
}

describe("validateEvent", () => {
  it("passes a valid worker.created event", () => {
    const result = validateEvent(workerCreatedEvent());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.event.event_name).toBe("worker.created");
      // Defaults applied:
      expect(result.event.actor.actor_id).toBeNull();
      expect(result.event.metadata.schema_version).toBe("1.0.0");
    }
  });

  it("fails on an invalid (unknown) event_name", () => {
    const evt = { ...workerCreatedEvent(), event_name: "worker.not_a_real_event" };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("event_name");
  });

  it("fails when actor is missing", () => {
    const evt = workerCreatedEvent();
    delete evt.actor;
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("envelope");
  });

  it("fails when the payload is invalid for the event name", () => {
    const evt = { ...workerCreatedEvent(), payload: { worker_id: "not-a-uuid" } };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("fails on an unsupported event_version", () => {
    const evt = { ...workerCreatedEvent(), event_version: 99 };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});

describe("voice_note.uploaded duration guard", () => {
  function voiceEvent(duration: number): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "voice_note.uploaded",
      subject: { subject_type: "voice_note", subject_id: UUID_A },
      payload: {
        voice_note_id: UUID_A,
        worker_id: UUID_B,
        session_id: UUID_C,
        duration_seconds: duration,
        storage_path: "voice/worker/abc.m4a",
      },
    };
  }

  it("accepts a voice note at the 120s limit", () => {
    expect(validateEvent(voiceEvent(MAX_VOICE_NOTE_SECONDS)).success).toBe(true);
  });

  it("rejects a voice note longer than 120s", () => {
    const result = validateEvent(voiceEvent(121));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });
});

describe("profile extraction events", () => {
  it("validates profile.extraction_requested", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "profile.extraction_requested",
      subject: { subject_type: "profile", subject_id: null },
      payload: { worker_id: UUID_B, session_id: UUID_C, ai_job_id: UUID_A },
    };
    expect(validateEvent(evt).success).toBe(true);
  });

  it("validates profile.extraction_completed with defaults", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "profile.extraction_completed",
      subject: { subject_type: "profile", subject_id: UUID_A },
      payload: {
        worker_id: UUID_B,
        profile_id: UUID_A,
        ai_job_id: UUID_C,
        profile_status: "extracted",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "profile.extraction_completed") {
      expect(result.event.payload.field_count).toBe(0);
    }
  });
});

describe("ai.pseudonymization_failed fails closed", () => {
  it("requires blocked=true", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.pseudonymization_failed",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: { request_id: "req_1", reason: "parser error", blocked: false },
    };
    expect(validateEvent(evt).success).toBe(false);
  });
});

describe("createEvent", () => {
  it("builds a valid event with generated ids and timestamp", () => {
    const event = createEvent({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: { phone_hash: "hash_xyz" },
    });
    expect(event.event_name).toBe("worker.otp_requested");
    expect(event.event_version).toBe(1);
    expect(event.payload.channel).toBe("sms"); // default applied
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    // The produced event must itself validate.
    expect(validateEvent(event).success).toBe(true);
  });

  it("throws EventValidationException on an invalid payload", () => {
    expect(() =>
      createEvent({
        event_name: "worker.created",
        actor: { actor_type: "system" },
        subject: { subject_type: "worker" },
        source: "api",
        metadata: { environment: "test", service: "api" },
        // @ts-expect-error intentionally invalid payload for the runtime guard
        payload: { worker_id: "nope" },
      }),
    ).toThrow(EventValidationException);
  });
});

describe("assertValidEvent", () => {
  it("returns the typed event on success", () => {
    const event = assertValidEvent(workerCreatedEvent());
    expect(event.event_name).toBe("worker.created");
  });
});

describe("action.recorded", () => {
  function actionEvent(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "action.recorded",
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  it("validates a minimal action and applies defaults", () => {
    const result = validateEvent(
      actionEvent({ worker_id: UUID_B, action_type: "resume_downloaded" }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "action.recorded") {
      expect(result.event.payload.target_type).toBeNull();
      expect(result.event.payload.source_surface).toBe("worker_app");
      expect(result.event.payload.context).toEqual({});
    }
  });

  it("rejects an unknown action_type", () => {
    const result = validateEvent(
      actionEvent({ worker_id: UUID_B, action_type: "definitely_not_an_action" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("rejects a context with too many keys", () => {
    const context: Record<string, number> = {};
    for (let i = 0; i < 21; i++) context[`k${i}`] = i;
    const result = validateEvent(
      actionEvent({ worker_id: UUID_B, action_type: "app_opened", context }),
    );
    expect(result.success).toBe(false);
  });
});

describe("interview-turn contract (extraction-ready, cost, ai-job)", () => {
  it("validates profile.extraction_ready and applies defaults", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "profile.extraction_ready",
      subject: { subject_type: "chat_session", subject_id: UUID_C },
      payload: { worker_id: UUID_B, session_id: UUID_C, answered_topics: ["role", "machines"] },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "profile.extraction_ready") {
      expect(result.event.payload.role_family).toBe("cnc_vmc"); // default
      expect(result.event.payload.turn_count).toBe(0); // default
    }
  });

  it("validates ai.cost_recorded with guardrail flags", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_A,
        task_type: "profile_extraction",
        model: "claude-haiku-or-gemini-flash",
        provider: "anthropic",
        estimated_cost_inr: 5.5,
        cost_alert: false,
        above_target: true,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded") {
      expect(result.event.payload.real_call).toBe(false); // default
      expect(result.event.payload.tokens_in).toBe(0); // default
    }
  });

  it("rejects ai.cost_recorded with an unknown task_type", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_A,
        task_type: "not_a_task",
        model: "m",
        provider: "p",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("validates ai.spend_cap_exceeded and applies real_call/null defaults", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.spend_cap_exceeded",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_B,
        ai_job_id: UUID_A,
        task_type: "profile_extraction",
        model: "gemini-flash",
        provider: "google",
        reason: "daily_cap_exceeded",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.spend_cap_exceeded") {
      expect(result.event.payload.real_call).toBe(false); // default
      expect(result.event.payload.request_id).toBeNull(); // default
    }
  });

  it("accepts every TD27 block reason on ai.spend_cap_exceeded", () => {
    const reasons = [
      "daily_cap_exceeded",
      "cumulative_cap_exceeded",
      "user_daily_cap_exceeded",
      "kill_switch_engaged",
      "retry_budget_exhausted",
      "cost_ceiling_exceeded",
    ];
    for (const reason of reasons) {
      const evt = {
        ...workerCreatedEvent(),
        event_name: "ai.spend_cap_exceeded",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: UUID_A },
        payload: {
          ai_call_id: UUID_B,
          task_type: "profile_extraction",
          model: "m",
          provider: "p",
          reason,
        },
      };
      expect(validateEvent(evt).success).toBe(true);
    }
  });

  it("rejects ai.spend_cap_exceeded with an unknown reason (enum-only → no free text)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.spend_cap_exceeded",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_B,
        task_type: "profile_extraction",
        model: "m",
        provider: "p",
        reason: "some_other_block_reason",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("validates ai.job_completed", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.job_completed",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: { ai_job_id: UUID_A, job_type: "profile_extraction", result_id: UUID_B },
    };
    expect(validateEvent(evt).success).toBe(true);
  });

  it("validates ai.cost_recorded with operational usage/cost (the shape the extraction processor emits)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_B,
        ai_job_id: UUID_A,
        task_type: "profile_extraction",
        model: "gpt-4o-mini",
        provider: "openai",
        real_call: true,
        tokens_in: 1200,
        tokens_out: 300,
        estimated_cost_inr: 0.42,
        latency_ms: 850,
      },
    };
    expect(validateEvent(evt).success).toBe(true);
  });
});

describe("reach foundation events (feed.* / application.*)", () => {
  it("validates feed.shown and applies score/hot defaults", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "feed.shown",
      actor: { actor_type: "system" },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload: { worker_id: UUID_B, job_id: UUID_A, rank: 3 },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "feed.shown") {
      expect(result.event.payload.score).toBe(0); // default
      expect(result.event.payload.hot).toBe(false); // default
    }
  });

  it("rejects feed.shown with rank <= 0", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "feed.shown",
      actor: { actor_type: "system" },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload: { worker_id: UUID_B, job_id: UUID_A, rank: 0 },
    };
    expect(validateEvent(evt).success).toBe(false);
  });

  it("validates application.submitted (worker actor, job subject)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "application.submitted",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload: { worker_id: UUID_B, job_id: UUID_A },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "application.submitted") {
      expect(result.event.payload.source_surface).toBe("feed"); // default
    }
  });

  it("validates application.skipped and rejects a free-text reason", () => {
    const ok = {
      ...workerCreatedEvent(),
      event_name: "application.skipped",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload: { worker_id: UUID_B, job_id: UUID_A, reason: "too_far" },
    };
    expect(validateEvent(ok).success).toBe(true);

    const bad = { ...ok, payload: { worker_id: UUID_B, job_id: UUID_A, reason: "9876543210" } };
    expect(validateEvent(bad).success).toBe(false); // enum-only, no free text → no PII
  });
});

describe("interview_kit events (per-trade, PII-free)", () => {
  it("validates interview_kit.downloaded and applies source/cache_hit defaults", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "interview_kit.downloaded",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: { trade_key: "cnc_operator", content_version: 1, kit_id: "cnc_operator:v1" },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "interview_kit.downloaded") {
      expect(result.event.payload.source).toBe("worker_app"); // default
      expect(result.event.payload.cache_hit).toBe(true); // default
    }
  });

  it("rejects a trade_key that is not a lowercase slug (no free text → no PII)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "interview_kit.downloaded",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: { trade_key: "CNC Operator 9876543210", content_version: 1, kit_id: "x:v1" },
    };
    expect(validateEvent(evt).success).toBe(false);
  });

  it("validates interview_kit.render_completed", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "interview_kit.render_completed",
      actor: { actor_type: "system" },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: { trade_key: "vmc_operator", content_version: 1, kit_id: "vmc_operator:v1" },
    };
    expect(validateEvent(evt).success).toBe(true);
  });
});

describe("job_posting events (ops-created, vacancy-banded, PII-free)", () => {
  it("validates job_posting.created (ops actor, job_posting subject)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "job_posting.created",
      actor: { actor_type: "ops", actor_id: UUID_C },
      subject: { subject_type: "job_posting", subject_id: UUID_A },
      payload: {
        job_posting_id: UUID_A,
        vacancy_band: "2-5",
        status: "draft",
        created_by: UUID_C,
        has_location: true,
        has_description: false,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "job_posting.created") {
      expect(result.event.payload.vacancy_band).toBe("2-5");
      expect(result.event.payload.status).toBe("draft");
    }
  });

  it("rejects job_posting.created with an unknown vacancy band (enum-only → no free text)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "job_posting.created",
      actor: { actor_type: "ops", actor_id: UUID_C },
      subject: { subject_type: "job_posting", subject_id: UUID_A },
      payload: {
        job_posting_id: UUID_A,
        vacancy_band: "lots",
        status: "draft",
        created_by: UUID_C,
        has_location: true,
        has_description: false,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("validates job_posting.updated with changed field KEYS and a nullable band", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "job_posting.updated",
      actor: { actor_type: "ops", actor_id: UUID_C },
      subject: { subject_type: "job_posting", subject_id: UUID_A },
      payload: {
        job_posting_id: UUID_A,
        changed_fields: ["role_title", "vacancy_band"],
        status: "open",
        vacancy_band: "6-10",
      },
    };
    expect(validateEvent(evt).success).toBe(true);

    const noBandChange = {
      ...evt,
      payload: {
        job_posting_id: UUID_A,
        changed_fields: ["role_title"],
        status: "open",
        vacancy_band: null,
      },
    };
    expect(validateEvent(noBandChange).success).toBe(true);
  });

  it("validates job_posting.closed and pins status to the literal 'closed'", () => {
    const ok = {
      ...workerCreatedEvent(),
      event_name: "job_posting.closed",
      actor: { actor_type: "ops", actor_id: UUID_C },
      subject: { subject_type: "job_posting", subject_id: UUID_A },
      payload: { job_posting_id: UUID_A, previous_status: "open", status: "closed" },
    };
    expect(validateEvent(ok).success).toBe(true);

    const wrongStatus = { ...ok, payload: { ...ok.payload, status: "open" } };
    expect(validateEvent(wrongStatus).success).toBe(false);
  });
});

describe("unlock/contact/payment events (ADR-0010 — PII-free, ids/enums/counts only)", () => {
  function unlockEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "unlock", subject_id: UUID_A },
      payload,
    };
  }

  it("validates unlock.requested and defaults job_id to null", () => {
    const result = validateEvent(
      unlockEvent("unlock.requested", { unlock_id: UUID_A, payer_id: UUID_B, worker_id: UUID_C }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "unlock.requested") {
      expect(result.event.payload.job_id).toBeNull();
    }
  });

  it("validates unlock.granted with an expiry timestamp", () => {
    const result = validateEvent(
      unlockEvent("unlock.granted", {
        unlock_id: UUID_A,
        payer_id: UUID_B,
        worker_id: UUID_C,
        expires_at: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("validates unlock.denied with an internal deny enum and rejects free text", () => {
    const ok = validateEvent(
      unlockEvent("unlock.denied", { payer_id: UUID_B, worker_id: UUID_C, reason: "no_consent" }),
    );
    expect(ok.success).toBe(true);
    const bad = validateEvent(
      unlockEvent("unlock.denied", { payer_id: UUID_B, worker_id: UUID_C, reason: "9876543210" }),
    );
    expect(bad.success).toBe(false); // enum-only → no PII / no oracle leak
  });

  it("validates unlock.cap_exceeded with cap + window enums", () => {
    const result = validateEvent(
      unlockEvent("unlock.cap_exceeded", {
        payer_id: UUID_B,
        worker_id: UUID_C,
        cap: "daily_reveals",
        window: "day",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("validates contact.revealed (channel KIND only) and rejects a number-shaped channel", () => {
    const ok = validateEvent(
      unlockEvent("contact.revealed", {
        unlock_id: UUID_A,
        payer_id: UUID_B,
        worker_id: UUID_C,
        channel: "in_app_relay",
        reveal_count: 1,
      }),
    );
    expect(ok.success).toBe(true);
    if (ok.success && ok.event.event_name === "contact.revealed") {
      // The payload schema has NO field that could hold a number/handle/destination.
      expect(Object.keys(ok.event.payload).sort()).toEqual(
        ["channel", "payer_id", "reveal_count", "unlock_id", "worker_id"].sort(),
      );
    }
    const bad = validateEvent(
      unlockEvent("contact.revealed", {
        unlock_id: UUID_A,
        payer_id: UUID_B,
        worker_id: UUID_C,
        channel: "+919876543210", // a raw number is NOT a valid channel kind
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("defaults real_call to false on every payment.* event (mock-honesty, F-6)", () => {
    for (const name of ["payment.authorized", "payment.captured"] as const) {
      const result = validateEvent(
        unlockEvent(name, { payer_id: UUID_B, amount_credits: 1 }),
      );
      expect(result.success).toBe(true);
      if (result.success && (result.event.event_name === "payment.authorized" || result.event.event_name === "payment.captured")) {
        expect(result.event.payload.real_call).toBe(false);
      }
    }
    const failed = validateEvent(
      unlockEvent("payment.failed", { payer_id: UUID_B, reason: "insufficient_credits" }),
    );
    expect(failed.success).toBe(true);
    if (failed.success && failed.event.event_name === "payment.failed") {
      expect(failed.event.payload.real_call).toBe(false);
    }
  });

  it("rejects an unknown payment.failed reason (enum-only → no free text)", () => {
    const result = validateEvent(
      unlockEvent("payment.failed", { payer_id: UUID_B, reason: "card_declined_by_bank_xyz" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("monetization + pricing events (ADR-0013 — PII-free, ids/codes/enums/amounts only)", () => {
  function payerEvent(
    name: string,
    payload: Record<string, unknown>,
    subjectType = "job_posting",
  ): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: subjectType, subject_id: UUID_A },
      payload,
    };
  }

  it("validates job_posting.purchased and defaults discount/coupon/real_call", () => {
    const result = validateEvent(
      payerEvent("job_posting.purchased", {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        tier: "standard",
        applicant_visibility_quota: 10,
        validity_days: 14,
        price_inr: 1000,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "job_posting.purchased") {
      expect(result.event.payload.discount_inr).toBe(0);
      expect(result.event.payload.coupon_applied).toBe(false);
      expect(result.event.payload.real_call).toBe(false);
    }
  });

  it("rejects a job_posting.purchased tier outside the enum", () => {
    const bad = validateEvent(
      payerEvent("job_posting.purchased", {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        tier: "platinum",
        applicant_visibility_quota: 10,
        validity_days: 14,
        price_inr: 1000,
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates job_posting.boosted and applicant.viewed (faceless quota view)", () => {
    expect(
      validateEvent(
        payerEvent("job_posting.boosted", {
          boost_id: UUID_A,
          job_posting_id: UUID_B,
          payer_id: UUID_C,
          boost_days: 2,
          price_inr: 1200,
        }),
      ).success,
    ).toBe(true);
    const viewed = validateEvent(
      payerEvent(
        "applicant.viewed",
        { plan_id: UUID_A, job_posting_id: UUID_B, payer_id: UUID_C, worker_id: UUID_A, viewed_count: 1, quota: 10 },
        "worker",
      ),
    );
    expect(viewed.success).toBe(true);
  });

  it("validates resume.disclosed as a FACT only (no bytes/name/link fields)", () => {
    const result = validateEvent(
      payerEvent(
        "resume.disclosed",
        { disclosure_id: UUID_A, payer_id: UUID_B, worker_id: UUID_C },
        "resume",
      ),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "resume.disclosed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["disclosure_id", "job_posting_id", "payer_id", "resume_ref", "worker_id"].sort(),
      );
      expect(result.event.payload.job_posting_id).toBeNull();
      expect(result.event.payload.resume_ref).toBeNull();
    }
  });

  it("validates coupon.redeemed + pricing.changed (codes/keys only, no values)", () => {
    expect(
      validateEvent(
        payerEvent(
          "coupon.redeemed",
          { coupon_code: "launch20", payer_id: UUID_B, product: "job_posting", tier: "standard", discount_inr: 200 },
          "pricing_plan",
        ),
      ).success,
    ).toBe(true);
    const changed = validateEvent(
      payerEvent(
        "pricing.changed",
        { change_type: "plan", entity_code: "job_posting", changed_fields: ["priceInr"], changed_by: UUID_A },
        "pricing_plan",
      ),
    );
    expect(changed.success).toBe(true);
    // field KEYS only — a values-bearing change_type outside the enum is rejected
    expect(
      validateEvent(
        payerEvent(
          "pricing.changed",
          { change_type: "secret_values", entity_code: "x", changed_fields: [], changed_by: UUID_A },
          "pricing_plan",
        ),
      ).success,
    ).toBe(false);
  });
});

describe("capacity / posting_plan lifecycle events (ADR-0016 — PII-free, ids/codes/enums only)", () => {
  it("validates capacity.purchased on the payer-scoped pricing_plan subject and defaults real_call", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "capacity.purchased",
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "pricing_plan", subject_id: UUID_A },
      payload: { payer_id: UUID_A, tier: "cap_5", max_active_vacancies: 5, price_inr: 5000 },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "capacity.purchased") {
      expect(result.event.payload.real_call).toBe(false); // mock-honesty default
      expect(result.event.payload.max_active_vacancies).toBe(5);
    }
  });

  it("validates posting_plan.paused / .resumed on the posting_plan subject with enum reasons", () => {
    const paused = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.paused",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: { plan_id: UUID_A, job_posting_id: UUID_B, payer_id: UUID_C, reason: "capacity_exceeded" },
    });
    expect(paused.success).toBe(true);

    const resumed = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.resumed",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: { plan_id: UUID_A, job_posting_id: UUID_B, payer_id: UUID_C, reason: "capacity_restored" },
    });
    expect(resumed.success).toBe(true);
  });

  it("rejects a free-text pause/resume reason (enum-only → no PII)", () => {
    const bad = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.paused",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: { plan_id: UUID_A, job_posting_id: UUID_B, payer_id: UUID_C, reason: "owner_requested" },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates posting_plan.quota_topped (B2 — ids/tier/counts/₹ only, no PII)", () => {
    const topped = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.quota_topped",
      actor: { actor_type: "payer", actor_id: UUID_C },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        tier: "topup_10",
        quota_added: 10,
        quota_topup_total: 10,
        price_inr: 1000,
      },
    });
    expect(topped.success).toBe(true);
  });

  it("rejects a non-positive quota_added on quota_topped (a top-up must grant views)", () => {
    const bad = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.quota_topped",
      actor: { actor_type: "payer", actor_id: UUID_C },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        tier: "topup_10",
        quota_added: 0,
        quota_topup_total: 0,
        price_inr: 1000,
      },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });
});

describe("pace supply-widening events (ADR-0021 — PII-free, faceless, no-LLM)", () => {
  function paceEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "system" },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload,
    };
  }

  it("validates pace.wave_widened for each widen stage (area / adjacent_trade)", () => {
    for (const stage of ["area", "adjacent_trade"] as const) {
      const result = validateEvent(
        paceEvent("pace.wave_widened", {
          job_id: UUID_A,
          stage,
          supply_count: 2,
          elapsed_hours: 6,
        }),
      );
      expect(result.success).toBe(true);
    }
  });

  it("rejects pace.wave_widened with an unknown stage (enum-only → no free text)", () => {
    const result = validateEvent(
      paceEvent("pace.wave_widened", {
        job_id: UUID_A,
        stage: "widen_everything",
        supply_count: 0,
        elapsed_hours: 0,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("validates pace.ops_alert_raised and carries only faceless fields", () => {
    const result = validateEvent(
      paceEvent("pace.ops_alert_raised", {
        job_id: UUID_A,
        supply_count: 0,
        elapsed_hours: 24,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "pace.ops_alert_raised") {
      // No field could carry a worker/employer/location — opaque job_id + counts only.
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["elapsed_hours", "job_id", "supply_count"].sort(),
      );
    }
  });

  it("rejects a negative supply_count (counts are non-negative integers)", () => {
    const result = validateEvent(
      paceEvent("pace.ops_alert_raised", { job_id: UUID_A, supply_count: -1, elapsed_hours: 1 }),
    );
    expect(result.success).toBe(false);
  });
});

describe("payer auth events (ADR-0019 Decision B — FACELESS, ids/role/method enums only)", () => {
  function payerAuthEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "payer", subject_id: UUID_A },
      payload,
    };
  }

  it("validates payer.created with role + method enums and NO contact-PII fields", () => {
    const result = validateEvent(
      payerAuthEvent("payer.created", { payer_id: UUID_A, role: "employer", method: "email_otp" }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "payer.created") {
      // The payload schema has NO field that could hold an email/phone/org-name — only
      // the opaque id + two enums (the B-R2 contact PII lives encrypted in `payers`).
      expect(Object.keys(result.event.payload).sort()).toEqual(["method", "payer_id", "role"].sort());
    }
  });

  it("rejects a payer.created role outside the {employer,agent} enum (no free text)", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.created", { payer_id: UUID_A, role: "Acme Pvt Ltd", method: "email_otp" }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects a login method outside the enum (e.g. an email-shaped value → no PII)", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.login_requested", { payer_id: UUID_A, method: "boss@acme.com" }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates payer.session_started and defaults is_new_payer to false", () => {
    const result = validateEvent(
      payerAuthEvent("payer.session_started", { payer_id: UUID_A, method: "whatsapp" }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "payer.session_started") {
      expect(result.event.payload.is_new_payer).toBe(false);
    }
  });

  it("validates payer.account_updated with KEYS-ONLY changed_fields and no value fields", () => {
    const result = validateEvent(
      payerAuthEvent("payer.account_updated", {
        payer_id: UUID_A,
        changed_fields: ["org_name", "phone"],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "payer.account_updated") {
      // The payload schema has NO field that could hold an org-name/phone VALUE — only
      // the opaque id + the changed field KEYS (the B-R2 contact PII lives encrypted in
      // `payers`). The keys are restricted to {org_name, phone}.
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["changed_fields", "payer_id"].sort(),
      );
    }
  });

  it("rejects a payer.account_updated payload carrying a VALUE field (keys only)", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.account_updated", {
        payer_id: UUID_A,
        changed_fields: ["org_name"],
        // A leaked org-name VALUE must never validate — the schema is strict on the
        // payload's allowed fields via the envelope's payload contract.
        org_name: "Acme Pvt Ltd",
        phone: "+919876543210",
      }),
    );
    // Extra keys are stripped by z.object (not its own failure), so prove instead that
    // the VALIDATED payload never carries them — only the opaque id + field KEYS survive.
    expect(bad.success).toBe(true);
    if (bad.success && bad.event.event_name === "payer.account_updated") {
      expect(Object.keys(bad.event.payload).sort()).toEqual(["changed_fields", "payer_id"].sort());
      expect(JSON.stringify(bad.event.payload)).not.toContain("Acme Pvt Ltd");
      expect(JSON.stringify(bad.event.payload)).not.toContain("9876543210");
    }
  });

  it("rejects payer.account_updated with an empty changed_fields (must change ≥1 field)", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.account_updated", { payer_id: UUID_A, changed_fields: [] }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects a payer.account_updated changed_fields key outside {org_name,phone}", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.account_updated", {
        payer_id: UUID_A,
        changed_fields: ["email"], // email is immutable here → not an allowed key
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });
});

describe("job entity + agency_invite events (ADR-0022 — FACELESS, ids/enums/bands only)", () => {
  function jobEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "job", subject_id: UUID_A },
      payload,
    };
  }

  it("validates job.created and defaults the optional bands to null", () => {
    const result = validateEvent(
      jobEvent("job.created", {
        job_id: UUID_A,
        payer_id: UUID_B,
        status: "open",
        trade_key: "cnc_operator",
        city: "Pune",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "job.created") {
      expect(result.event.payload.pay_min).toBeNull();
      expect(result.event.payload.max_experience_years).toBeNull();
      // No field could carry an employer name / address / worker id — opaque ids +
      // coarse bands only (the city label is the only non-id string, capped + coarse).
      expect(Object.keys(result.event.payload).sort()).toEqual(
        [
          "city",
          "job_id",
          "max_experience_years",
          "min_experience_years",
          "pay_max",
          "pay_min",
          "payer_id",
          "status",
          "trade_key",
        ].sort(),
      );
    }
  });

  it("rejects job.created with a non-slug trade_key (no free text → no PII)", () => {
    const bad = validateEvent(
      jobEvent("job.created", {
        job_id: UUID_A,
        payer_id: UUID_B,
        status: "open",
        trade_key: "CNC Operator 9876543210",
        city: "Pune",
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates job.updated with changed field KEYS only", () => {
    const ok = validateEvent(
      jobEvent("job.updated", {
        job_id: UUID_A,
        payer_id: UUID_B,
        status: "open",
        changed_fields: ["title", "pay_min", "status"],
      }),
    );
    expect(ok.success).toBe(true);

    const bad = validateEvent(
      jobEvent("job.updated", {
        job_id: UUID_A,
        payer_id: UUID_B,
        status: "open",
        changed_fields: ["employer_name"],
      }),
    );
    expect(bad.success).toBe(false); // not a known field key → rejected
  });

  it("validates job.closed and pins status to the literal 'closed'", () => {
    const ok = validateEvent(
      jobEvent("job.closed", {
        job_id: UUID_A,
        payer_id: UUID_B,
        previous_status: "open",
        status: "closed",
      }),
    );
    expect(ok.success).toBe(true);

    const wrong = validateEvent(
      jobEvent("job.closed", {
        job_id: UUID_A,
        payer_id: UUID_B,
        previous_status: "open",
        status: "open",
      }),
    );
    expect(wrong.success).toBe(false);
  });

  it("validates agency_invite.created (NO worker id, no phone/name/email fields)", () => {
    const result = validateEvent({
      ...workerCreatedEvent(),
      event_name: "agency_invite.created",
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "agency_invite", subject_id: UUID_A },
      payload: { agency_invite_id: UUID_A, inviter_payer_id: UUID_B, channel: "whatsapp" },
    });
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "agency_invite.created") {
      // No worker handle on create + no contact-PII field exists at all (the code itself
      // is a shareable secret and is NOT carried).
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["agency_invite_id", "channel", "inviter_payer_id"].sort(),
      );
    }
  });

  it("validates agency_invite.accepted (carries the post-consent worker handle, opaque)", () => {
    const result = validateEvent({
      ...workerCreatedEvent(),
      event_name: "agency_invite.accepted",
      actor: { actor_type: "system" },
      subject: { subject_type: "agency_invite", subject_id: UUID_A },
      payload: {
        agency_invite_id: UUID_A,
        inviter_payer_id: UUID_B,
        invited_worker_id: UUID_C,
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "agency_invite.accepted") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["agency_invite_id", "invited_worker_id", "inviter_payer_id"].sort(),
      );
    }
  });

  it("rejects an agency_invite.created channel outside the enum (no free text → no PII)", () => {
    const bad = validateEvent({
      ...workerCreatedEvent(),
      event_name: "agency_invite.created",
      actor: { actor_type: "payer", actor_id: UUID_A },
      subject: { subject_type: "agency_invite", subject_id: UUID_A },
      payload: { agency_invite_id: UUID_A, inviter_payer_id: UUID_B, channel: "boss@acme.com" },
    });
    expect(bad.success).toBe(false);
  });
});

describe("otp send-cap-exceeded events (OTP-5 — AGGREGATE, PII-free, no identity)", () => {
  function capEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "system" },
      subject: { subject_type: name.startsWith("payer") ? "payer" : "worker", subject_id: null },
      payload,
    };
  }

  it("validates worker.otp_send_cap_exceeded with the aggregate shape (no PII fields exist)", () => {
    const result = validateEvent(
      capEvent("worker.otp_send_cap_exceeded", {
        channel: "worker_sms",
        cap: "global_daily",
        limit: 2000,
        window: "20260626",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.otp_send_cap_exceeded") {
      // The payload schema has NO field that could hold a phone/email/IP/code/id — only
      // the two enums, the integer limit, and the UTC-day string.
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["cap", "channel", "limit", "window"].sort(),
      );
    }
  });

  it("validates payer.otp_send_cap_exceeded (channel payer_email)", () => {
    const result = validateEvent(
      capEvent("payer.otp_send_cap_exceeded", {
        channel: "payer_email",
        cap: "global_daily",
        limit: 0, // kill-switch
        window: "20260626",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an out-of-enum channel (no free text → no PII / no destination leak)", () => {
    const bad = validateEvent(
      capEvent("worker.otp_send_cap_exceeded", {
        channel: "+919876543210",
        cap: "global_daily",
        limit: 2000,
        window: "20260626",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects a cap other than the 'global_daily' literal, and a non-day window", () => {
    expect(
      validateEvent(
        capEvent("worker.otp_send_cap_exceeded", {
          channel: "worker_sms",
          cap: "per_phone",
          limit: 5,
          window: "20260626",
        }),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        capEvent("payer.otp_send_cap_exceeded", {
          channel: "payer_email",
          cap: "global_daily",
          limit: 2000,
          window: "2026-06-26T00:00:00.000Z", // a timestamp is NOT a UTC-day stamp
        }),
      ).success,
    ).toBe(false);
  });
});

describe("admin auth events (ADR-0025 — the 4th principal, FACELESS, ids/role/code enums only)", () => {
  function adminSessionEvent(
    name: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload,
    };
  }

  it("validates admin.session_started with admin_id + role enum and NO email/value fields", () => {
    const result = validateEvent(
      adminSessionEvent("admin.session_started", { admin_id: UUID_A, role: "support" }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.session_started") {
      // ids + the role enum ONLY — there is no field that could carry the admin's email.
      expect(Object.keys(result.event.payload).sort()).toEqual(["admin_id", "role"].sort());
    }
  });

  it("rejects an admin.session_started role outside the 4-role enum (no free text)", () => {
    const bad = validateEvent(
      adminSessionEvent("admin.session_started", { admin_id: UUID_A, role: "boss@acme.com" }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects an admin.session_started carrying an extra PII-shaped key (.strict)", () => {
    // Unlike the looser payer payloads (which strip extras), the admin payloads are
    // `.strict()` so an email/value smuggled alongside the id+enum FAILS validation —
    // a structural backstop against the spine becoming a PII sink (CLAUDE.md invariant #2).
    const bad = validateEvent(
      adminSessionEvent("admin.session_started", {
        admin_id: UUID_A,
        role: "support",
        email: "admin@badabhai.in",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates admin.session_revoked with admin_id only", () => {
    const result = validateEvent(adminSessionEvent("admin.session_revoked", { admin_id: UUID_A }));
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.session_revoked") {
      expect(Object.keys(result.event.payload)).toEqual(["admin_id"]);
    }
  });

  it("rejects admin.session_revoked with an extra key (.strict — no value can ride along)", () => {
    const bad = validateEvent(
      adminSessionEvent("admin.session_revoked", { admin_id: UUID_A, reason: "logout" }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates admin.action_performed with action_code + target ids and NO values (ADMIN-3)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "payer", subject_id: UUID_B },
      payload: {
        admin_id: UUID_A,
        action_code: "suspend_payer",
        target_type: "payer",
        target_id: UUID_B,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.action_performed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["action_code", "admin_id", "target_id", "target_type"].sort(),
      );
    }
  });

  it("rejects admin.action_performed carrying an old/new VALUE key (.strict — codes only, ADMIN-3)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "payer", subject_id: UUID_B },
      payload: {
        admin_id: UUID_A,
        action_code: "suspend_payer",
        target_type: "payer",
        target_id: UUID_B,
        old_value: "active", // a changed VALUE must never validate into the spine
      },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates admin.pii_viewed with reason_code + subject id and NEVER the PII (ADMIN-3)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.pii_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: { admin_id: UUID_A, subject_id: UUID_B, reason_code: "worker_support_callback" },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.pii_viewed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["admin_id", "reason_code", "subject_id"].sort(),
      );
    }
  });

  it("rejects admin.pii_viewed carrying a phone/name VALUE key (.strict — never the PII, ADMIN-3)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.pii_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: {
        admin_id: UUID_A,
        subject_id: UUID_B,
        reason_code: "worker_support_callback",
        phone: "+919876543210", // the revealed PII must never validate into the spine
      },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates admin.pii_reveal_cap_exceeded with admin_id + window enum and NO subject/value (ADMIN-3b)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.pii_reveal_cap_exceeded",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, window: "hour" },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.pii_reveal_cap_exceeded") {
      // PII-FREE: opaque admin_id + window enum ONLY — never a worker/subject id or value.
      expect(Object.keys(result.event.payload).sort()).toEqual(["admin_id", "window"].sort());
    }
  });

  it("rejects admin.pii_reveal_cap_exceeded with an unknown window (enum-only — no free text)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.pii_reveal_cap_exceeded",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, window: "minute" },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects admin.pii_reveal_cap_exceeded carrying a worker/subject id (.strict — aggregate, no per-subject data, ADMIN-3b)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.pii_reveal_cap_exceeded",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, window: "day", subject_id: UUID_B },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates admin.kill_switch_pause_requested with switch_key + reason_code and NO value (ADMIN-3c)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.kill_switch_pause_requested",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "kill_switch", subject_id: null },
      payload: { admin_id: UUID_A, switch_key: "ai_real_calls", reason_code: "incident_response" },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.kill_switch_pause_requested") {
      // PII-FREE & VALUE-FREE: opaque admin_id + a switch KEY enum + a reason CODE ONLY.
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["admin_id", "reason_code", "switch_key"].sort(),
      );
    }
  });

  it("rejects admin.kill_switch_pause_requested with an unknown switch_key (enum-only — no free text)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.kill_switch_pause_requested",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "kill_switch", subject_id: null },
      payload: { admin_id: UUID_A, switch_key: "enable_everything", reason_code: "incident_response" },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects admin.kill_switch_pause_requested with an unknown reason_code (enum-only)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.kill_switch_pause_requested",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "kill_switch", subject_id: null },
      payload: { admin_id: UUID_A, switch_key: "ai_real_calls", reason_code: "owner_said_so" },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects admin.kill_switch_pause_requested carrying a provider-key/value (.strict — never a secret/value, ADMIN-3c)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.kill_switch_pause_requested",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "kill_switch", subject_id: null },
      payload: {
        admin_id: UUID_A,
        switch_key: "real_payments",
        reason_code: "cost_spike",
        provider_key: "sk_live_should_never_be_here", // a secret/value must never validate
      },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("admits `admin` as an actor_type and `admin_session` as a subject_type (additive enums)", () => {
    // The enum additions break no existing event (z.enum widening only); a wrong actor for
    // an admin event still validates the envelope — the principal binding is the guard's job.
    expect(
      validateEvent(adminSessionEvent("admin.session_revoked", { admin_id: UUID_A })).success,
    ).toBe(true);
  });
});

describe("worker refresh/session auth events (ADR-0026 Phase 1 — PII-free, ids/counts only)", () => {
  function workerAuthEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  it("validates worker.refresh_reuse_detected with ONLY worker_id + family_id (no token field exists)", () => {
    const result = validateEvent(
      workerAuthEvent("worker.refresh_reuse_detected", { worker_id: UUID_B, family_id: UUID_A }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.refresh_reuse_detected") {
      // The payload schema has NO field that could carry the refresh token value, its
      // sha256, a phone, or a session secret — only two opaque UUIDs.
      expect(Object.keys(result.event.payload).sort()).toEqual(["family_id", "worker_id"].sort());
    }
  });

  it("rejects worker.refresh_reuse_detected with a non-uuid family_id (no free text → no token leak)", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.refresh_reuse_detected", {
        worker_id: UUID_B,
        family_id: "rt_abc123_raw_token_like_value",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("validates worker.logged_out_all with worker_id + a non-negative count and nothing else", () => {
    const result = validateEvent(
      workerAuthEvent("worker.logged_out_all", { worker_id: UUID_B, sessions_revoked: 3 }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.logged_out_all") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["sessions_revoked", "worker_id"].sort(),
      );
    }
  });

  it("rejects worker.logged_out_all with a negative sessions_revoked (counts are non-negative)", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.logged_out_all", { worker_id: UUID_B, sessions_revoked: -1 }),
    );
    expect(bad.success).toBe(false);
  });

  // ADR-0026 Phase 5 — DPDP account deletion. PII-FREE: opaque worker id + counts/flags only.
  it("validates worker.account_deleted with worker_id + counts/flags and NOTHING else", () => {
    const result = validateEvent(
      workerAuthEvent("worker.account_deleted", {
        worker_id: UUID_B,
        sessions_revoked: 2,
        devices_revoked: 1,
        storage_objects_deleted: 3,
        storage_objects_failed: 0,
        had_pin: true,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.account_deleted") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        [
          "devices_revoked",
          "had_pin",
          "sessions_revoked",
          "storage_objects_deleted",
          "storage_objects_failed",
          "worker_id",
        ].sort(),
      );
    }
  });

  it("rejects worker.account_deleted with a negative storage_objects_failed (counts non-negative)", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.account_deleted", {
        worker_id: UUID_B,
        sessions_revoked: 0,
        devices_revoked: 0,
        storage_objects_deleted: 0,
        storage_objects_failed: -1,
        had_pin: false,
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects worker.account_deleted with an EXTRA field (strict — no phone/key smuggling)", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.account_deleted", {
        worker_id: UUID_B,
        sessions_revoked: 0,
        devices_revoked: 0,
        storage_objects_deleted: 0,
        storage_objects_failed: 0,
        had_pin: false,
        phone_hash: "leaked",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects worker.account_deleted carrying a RAW-PHONE-looking field (strict — never the value)", () => {
    // The §2/D6 invariant: the number NEVER appears. A smuggled raw phone (under any field
    // name) must be rejected by .strict() at the payload stage, not silently passed through.
    for (const smuggle of [{ phone: "+919876512345" }, { phone_e164: "+919876512345" }, { full_name: "Ramesh Kumar" }, { otp: "482915" }]) {
      const bad = validateEvent(
        workerAuthEvent("worker.account_deleted", {
          worker_id: UUID_B,
          sessions_revoked: 1,
          devices_revoked: 1,
          storage_objects_deleted: 1,
          storage_objects_failed: 0,
          had_pin: true,
          ...smuggle,
        }),
      );
      expect(bad.success, `must reject ${JSON.stringify(smuggle)}`).toBe(false);
      if (!bad.success) expect(bad.error.stage).toBe("payload");
    }
  });
});

describe("worker device events (ADR-0026 Phase 2 — PII-free, two opaque uuids only)", () => {
  function workerDeviceEvent(
    name: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  it("validates worker.device_registered with ONLY worker_id + device_id (no hash/raw-id/push-token field exists)", () => {
    const result = validateEvent(
      workerDeviceEvent("worker.device_registered", { worker_id: UUID_B, device_id: UUID_A }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.device_registered") {
      // The payload schema has NO field that could carry the device_hash, the raw client
      // device id, the push_token, or platform/model/app_version — only two opaque UUIDs.
      expect(Object.keys(result.event.payload).sort()).toEqual(["device_id", "worker_id"].sort());
    }
  });

  it("validates worker.device_revoked with ONLY worker_id + device_id", () => {
    const result = validateEvent(
      workerDeviceEvent("worker.device_revoked", { worker_id: UUID_B, device_id: UUID_A }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.device_revoked") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["device_id", "worker_id"].sort());
    }
  });

  it("rejects worker.device_registered with a non-uuid device_id (no free text → no hash/id/token leak)", () => {
    const bad = validateEvent(
      workerDeviceEvent("worker.device_registered", {
        worker_id: UUID_B,
        device_id: "hmac<raw-android-device-id-value>",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });
});

describe("worker PIN events (ADR-0026 Phase 3 — device-bound PIN, PII-free, ids/ints/bools only)", () => {
  function workerPinEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  it("validates worker.pin_set with ONLY worker_id (no PIN/hash/throttle field exists)", () => {
    const result = validateEvent(workerPinEvent("worker.pin_set", { worker_id: UUID_B }));
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.pin_set") {
      // The payload schema has NO field that could carry the raw PIN, the pin_hash, the
      // device fingerprint, or a phone — only the opaque worker uuid.
      expect(Object.keys(result.event.payload).sort()).toEqual(["worker_id"].sort());
    }
  });

  it("validates worker.pin_reset with ONLY worker_id (never the new PIN / OTP / phone)", () => {
    const result = validateEvent(workerPinEvent("worker.pin_reset", { worker_id: UUID_B }));
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.pin_reset") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["worker_id"].sort());
    }
  });

  it("validates worker.pin_verified with ONLY worker_id + device_id (the device the PIN rode)", () => {
    const result = validateEvent(
      workerPinEvent("worker.pin_verified", { worker_id: UUID_B, device_id: UUID_A }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.pin_verified") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["device_id", "worker_id"].sort());
    }
  });

  it("validates worker.pin_verify_failed with ONLY worker_id + device_id (no submitted-PIN field)", () => {
    const result = validateEvent(
      workerPinEvent("worker.pin_verify_failed", { worker_id: UUID_B, device_id: UUID_A }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.pin_verify_failed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["device_id", "worker_id"].sort());
    }
  });

  it("validates worker.pin_locked with ids + the integer cycle + the force_otp boolean only", () => {
    const result = validateEvent(
      workerPinEvent("worker.pin_locked", {
        worker_id: UUID_B,
        device_id: UUID_A,
        lockout_cycle: 5,
        force_otp: true,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.pin_locked") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["device_id", "force_otp", "lockout_cycle", "worker_id"].sort(),
      );
    }
  });

  it("rejects worker.pin_verified with a non-uuid device_id (no free text → no fingerprint leak)", () => {
    const bad = validateEvent(
      workerPinEvent("worker.pin_verified", {
        worker_id: UUID_B,
        device_id: "raw-android-device-fingerprint-value",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects worker.pin_set carrying an extra free-text field (.strict() blocks PII smuggling)", () => {
    const bad = validateEvent(
      // A careless caller tries to smuggle a value (e.g. the PIN or a phone) onto the spine.
      workerPinEvent("worker.pin_set", { worker_id: UUID_B, pin: "1357" }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects worker.pin_locked with a negative lockout_cycle (cycles are non-negative ints)", () => {
    const bad = validateEvent(
      workerPinEvent("worker.pin_locked", {
        worker_id: UUID_B,
        device_id: UUID_A,
        lockout_cycle: -1,
        force_otp: false,
      }),
    );
    expect(bad.success).toBe(false);
  });
});

describe("registry", () => {
  it("exposes all 99 event names (93 prior + job_posting.paused/resumed [B1] + posting_plan.quota_topped [B2] + payer_member.invited/accepted/removed [ADR-0027 / B5])", () => {
    expect(EVENT_NAMES).toHaveLength(99);
    expect(isEventName("job_posting.paused")).toBe(true);
    expect(isEventName("job_posting.resumed")).toBe(true);
    expect(isEventName("posting_plan.quota_topped")).toBe(true);
    expect(isEventName("payer_member.invited")).toBe(true);
    expect(isEventName("payer_member.accepted")).toBe(true);
    expect(isEventName("payer_member.removed")).toBe(true);
    expect(isEventName("worker.pin_set")).toBe(true);
    expect(isEventName("worker.pin_verified")).toBe(true);
    expect(isEventName("worker.pin_verify_failed")).toBe(true);
    expect(isEventName("worker.pin_locked")).toBe(true);
    expect(isEventName("worker.pin_reset")).toBe(true);
    expect(isEventName("worker.account_deleted")).toBe(true);
    expect(isEventName("admin.session_started")).toBe(true);
    expect(isEventName("admin.session_revoked")).toBe(true);
    expect(isEventName("admin.action_performed")).toBe(true);
    expect(isEventName("admin.pii_viewed")).toBe(true);
    expect(isEventName("admin.pii_reveal_cap_exceeded")).toBe(true);
    expect(isEventName("admin.kill_switch_pause_requested")).toBe(true);
    expect(isEventName("worker.refresh_reuse_detected")).toBe(true);
    expect(isEventName("worker.logged_out_all")).toBe(true);
    expect(isEventName("worker.device_registered")).toBe(true);
    expect(isEventName("worker.device_revoked")).toBe(true);
    expect(isEventName("worker.account_deleted")).toBe(true);
    expect(isEventName("worker.otp_send_cap_exceeded")).toBe(true);
    expect(isEventName("payer.otp_send_cap_exceeded")).toBe(true);
    expect(isEventName("payer.account_updated")).toBe(true);
    expect(isEventName("job.created")).toBe(true);
    expect(isEventName("job.updated")).toBe(true);
    expect(isEventName("job.closed")).toBe(true);
    expect(isEventName("agency_invite.created")).toBe(true);
    expect(isEventName("agency_invite.accepted")).toBe(true);
    expect(isEventName("pace.wave_widened")).toBe(true);
    expect(isEventName("pace.ops_alert_raised")).toBe(true);
    expect(isEventName("payer.created")).toBe(true);
    expect(isEventName("payer.login_requested")).toBe(true);
    expect(isEventName("payer.session_started")).toBe(true);
    expect(isEventName("invite.created")).toBe(true);
    expect(isEventName("invite.clicked")).toBe(true);
    expect(isEventName("invite.accepted")).toBe(true);
    expect(isEventName("messaging.requested")).toBe(true);
    expect(isEventName("messaging.sent")).toBe(true);
    expect(isEventName("messaging.suppressed")).toBe(true);
    expect(isEventName("messaging.failed")).toBe(true);
    expect(isEventName("capacity.purchased")).toBe(true);
    expect(isEventName("posting_plan.paused")).toBe(true);
    expect(isEventName("posting_plan.resumed")).toBe(true);
    expect(isEventName("job_posting.purchased")).toBe(true);
    expect(isEventName("job_posting.boosted")).toBe(true);
    expect(isEventName("applicant.viewed")).toBe(true);
    expect(isEventName("resume.disclosed")).toBe(true);
    expect(isEventName("coupon.redeemed")).toBe(true);
    expect(isEventName("pricing.changed")).toBe(true);
    expect(isEventName("job_posting.created")).toBe(true);
    expect(isEventName("job_posting.updated")).toBe(true);
    expect(isEventName("job_posting.closed")).toBe(true);
    expect(isEventName("unlock.requested")).toBe(true);
    expect(isEventName("unlock.granted")).toBe(true);
    expect(isEventName("unlock.denied")).toBe(true);
    expect(isEventName("unlock.cap_exceeded")).toBe(true);
    expect(isEventName("contact.revealed")).toBe(true);
    expect(isEventName("payment.authorized")).toBe(true);
    expect(isEventName("payment.captured")).toBe(true);
    expect(isEventName("payment.failed")).toBe(true);
    expect(isEventName("interview_kit.downloaded")).toBe(true);
    expect(isEventName("interview_kit.render_completed")).toBe(true);
    expect(isEventName("interview_kit.render_failed")).toBe(true);
    expect(isEventName("resume.generated")).toBe(true);
    expect(isEventName("resume.downloaded")).toBe(true);
    expect(isEventName("resume.regenerated")).toBe(true);
    expect(isEventName("resume.shared")).toBe(true);
    expect(isEventName("action.recorded")).toBe(true);
    expect(isEventName("profile.extraction_ready")).toBe(true);
    expect(isEventName("ai.cost_recorded")).toBe(true);
    expect(isEventName("ai.spend_cap_exceeded")).toBe(true);
    expect(isEventName("ai.job_completed")).toBe(true);
    expect(isEventName("voice_note.transcription_failed")).toBe(true);
    expect(isEventName("worker.name_recorded")).toBe(true);
    expect(isEventName("feed.shown")).toBe(true);
    expect(isEventName("application.submitted")).toBe(true);
    expect(isEventName("application.skipped")).toBe(true);
    expect(isEventName("nope")).toBe(false);
  });

  it("every registry entry has version 1 in Phase 1", () => {
    for (const name of EVENT_NAMES) {
      expect(EVENT_REGISTRY[name].version).toBe(1);
    }
  });
});
