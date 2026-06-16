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

describe("registry", () => {
  it("exposes all 54 event names (48 prior + 6 ADR-0013 monetization/pricing)", () => {
    expect(EVENT_NAMES).toHaveLength(54);
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
