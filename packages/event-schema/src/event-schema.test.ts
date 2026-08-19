import { describe, it, expect } from "vitest";
import {
  WORKER_FEEDBACK_CATEGORIES,
  WORKER_FEEDBACK_APP_BUILD_MAX,
  WORKER_FEEDBACK_SCREEN_MAX,
} from "@badabhai/types";
import {
  validateEvent,
  createEvent,
  assertValidEvent,
  EventValidationException,
  EVENT_NAMES,
  EVENT_REGISTRY,
  isEventName,
  MAX_VOICE_NOTE_SECONDS,
  FeedbackSubmittedPayload,
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

  // BL-23: additive widen so "spent ₹X successfully" is distinguishable from "spent
  // ₹X and the call still failed". Defaults preserve the OLD implicit reading of every
  // historical row (no failure signal existed, so nothing ever looked like a failure).
  it("ai.cost_recorded defaults success=true/error_code=null/failure_reason=null (old-shape rows stay valid)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_A,
        task_type: "profile_extraction",
        model: "m",
        provider: "p",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded") {
      expect(result.event.payload.success).toBe(true);
      expect(result.event.payload.error_code).toBeNull();
      expect(result.event.payload.failure_reason).toBeNull();
    }
  });

  it("ai.cost_recorded carries a failed call's closed-set error_code/failure_reason", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_A,
        task_type: "profile_extraction",
        model: "m",
        provider: "p",
        success: false,
        error_code: "retry_budget_exhausted",
        failure_reason: "LlmTransportError",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded") {
      expect(result.event.payload.success).toBe(false);
      expect(result.event.payload.error_code).toBe("retry_budget_exhausted");
      expect(result.event.payload.failure_reason).toBe("LlmTransportError");
    }
  });

  // ── Phase 4 attribution: worker_id / session_id ────────────────────────────────────────
  //
  // The reason these exist at all: `ai_job_id` is null on four spending surfaces by design
  // (an interview turn, a résumé, a skill embed and a payer chat turn have no async job), so
  // there was no `ai_jobs.input_ref` to join through and no field either. "What did this
  // worker cost?" summed to ₹0 and read as free rather than as unattributed.
  it("ai.cost_recorded carries worker_id + session_id when the surface knows them", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: null },
      payload: {
        ai_call_id: UUID_A,
        // Null on purpose: the interview turn this shape describes has no `ai_jobs` row, and
        // the attribution is exactly what replaces the join it cannot make.
        ai_job_id: null,
        worker_id: UUID_B,
        session_id: UUID_C,
        task_type: "profiling_chat_turn",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        estimated_cost_inr: 0.157,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded") {
      expect(result.event.payload.worker_id).toBe(UUID_B);
      expect(result.event.payload.session_id).toBe(UUID_C);
    }
  });

  it("ai.cost_recorded still validates with NEITHER field — every historical row stays valid", () => {
    // BACKWARD COMPATIBILITY IS THE ASSERTION. Both default to null, so a row written before
    // these fields existed parses identically, and no consumer of the old shape breaks. This
    // is the same additive discipline BL-23 used; the registry stays at version 1.
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: UUID_A },
      payload: {
        ai_call_id: UUID_A,
        task_type: "profile_extraction",
        model: "m",
        provider: "p",
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded") {
      expect(result.event.payload.worker_id).toBeNull();
      expect(result.event.payload.session_id).toBeNull();
    }
  });

  it("ai.cost_recorded accepts an explicitly UNATTRIBUTED payer-side call", () => {
    // `skill_embedding` on a job-posting write and `job_posting_chat_turn` are employer spend
    // with no worker in any sense. Nulls are the honest answer, and inventing a worker to
    // satisfy the field would file an employer's money against a candidate.
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: null },
      payload: {
        ai_call_id: UUID_A,
        ai_job_id: null,
        worker_id: null,
        session_id: null,
        task_type: "skill_embedding",
        model: "text-embedding-004",
        provider: "google",
      },
    };
    expect(validateEvent(evt).success).toBe(true);
  });

  it("rejects a non-uuid worker_id — the attribution is an id, never a name", () => {
    // §2. The ONLY thing that makes attributing cost by identifier safe is that the
    // identifier is opaque. A payload that accepted free text here is one prompt-debugging
    // session away from carrying a worker's name into the events table.
    const evt = {
      ...workerCreatedEvent(),
      event_name: "ai.cost_recorded",
      subject: { subject_type: "ai_job", subject_id: null },
      payload: {
        ai_call_id: UUID_A,
        worker_id: "Ramesh Kumar",
        task_type: "profiling_chat_turn",
        model: "m",
        provider: "p",
      },
    };
    expect(validateEvent(evt).success).toBe(false);
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

  // ── OPTIONAL worker attribution (admin journey step 7) ────────────────────────────────
  // Additive widen, no version bump — the `ai.cost_recorded` precedent (26ad1598). The
  // three tests below pin the whole contract: the field defaults to null, an anonymous
  // download is STILL valid, and a garbage id is rejected rather than stored.

  it("interview_kit.downloaded defaults worker_id to null — an ANONYMOUS download stays valid", () => {
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
      // The route is public. "No worker id" is the ordinary case, not a validation failure —
      // if this ever fails, an unauthenticated download has become unrecordable.
      expect(result.event.payload.worker_id).toBeNull();
    }
  });

  it("interview_kit.downloaded carries worker_id when a valid worker session was present", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "interview_kit.downloaded",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: {
        trade_key: "cnc_operator",
        content_version: 1,
        kit_id: "cnc_operator:v1",
        worker_id: UUID_B,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "interview_kit.downloaded") {
      expect(result.event.payload.worker_id).toBe(UUID_B);
    }
  });

  it("rejects a non-uuid worker_id (the field is an opaque id, never free text)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "interview_kit.downloaded",
      actor: { actor_type: "worker", actor_id: UUID_B },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: {
        trade_key: "cnc_operator",
        content_version: 1,
        kit_id: "cnc_operator:v1",
        worker_id: "Ramesh Kumar 9876543210",
      },
    };
    expect(validateEvent(evt).success).toBe(false);
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
      const result = validateEvent(unlockEvent(name, { payer_id: UUID_B, amount_credits: 1 }));
      expect(result.success).toBe(true);
      if (
        result.success &&
        (result.event.event_name === "payment.authorized" ||
          result.event.event_name === "payment.captured")
      ) {
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
        {
          plan_id: UUID_A,
          job_posting_id: UUID_B,
          payer_id: UUID_C,
          worker_id: UUID_A,
          viewed_count: 1,
          quota: 10,
        },
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
          {
            coupon_code: "launch20",
            payer_id: UUID_B,
            product: "job_posting",
            tier: "standard",
            discount_inr: 200,
          },
          "pricing_plan",
        ),
      ).success,
    ).toBe(true);
    const changed = validateEvent(
      payerEvent(
        "pricing.changed",
        {
          change_type: "plan",
          entity_code: "job_posting",
          changed_fields: ["priceInr"],
          changed_by: UUID_A,
        },
        "pricing_plan",
      ),
    );
    expect(changed.success).toBe(true);
    // field KEYS only — a values-bearing change_type outside the enum is rejected
    expect(
      validateEvent(
        payerEvent(
          "pricing.changed",
          {
            change_type: "secret_values",
            entity_code: "x",
            changed_fields: [],
            changed_by: UUID_A,
          },
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
      payload: {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        reason: "capacity_exceeded",
      },
    });
    expect(paused.success).toBe(true);

    const resumed = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.resumed",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        reason: "capacity_restored",
      },
    });
    expect(resumed.success).toBe(true);
  });

  it("rejects a free-text pause/resume reason (enum-only → no PII)", () => {
    const bad = validateEvent({
      ...workerCreatedEvent(),
      event_name: "posting_plan.paused",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: UUID_A },
      payload: {
        plan_id: UUID_A,
        job_posting_id: UUID_B,
        payer_id: UUID_C,
        reason: "owner_requested",
      },
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

describe("payer lifecycle events (ADR-0037 — FACELESS, opaque id + closed status enums)", () => {
  function lifecycleEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "admin", actor_id: UUID_B },
      subject: { subject_type: "payer", subject_id: UUID_A },
      payload,
    };
  }

  const base = { payer_id: UUID_A, previous_status: "pending", new_status: "active" };

  for (const name of ["payer.activated", "payer.suspended", "payer.reinstated"]) {
    it(`${name} validates and carries BOTH ends of the transition`, () => {
      const result = validateEvent(lifecycleEvent(name, base));
      expect(result.success).toBe(true);
      if (result.success) {
        // Recording only that "something happened" would not meet "audit every state
        // transition" — the FROM state is what makes a reinstate auditable.
        expect(Object.keys(result.event.payload).sort()).toEqual(
          ["new_status", "payer_id", "previous_status"].sort(),
        );
      }
    });
  }

  it("rejects a status outside the closed enum (no free text → no PII)", () => {
    const result = validateEvent(
      lifecycleEvent("payer.suspended", {
        ...base,
        new_status: "banned after call from boss@acme.com",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a REASON on the payload — the spine stays value-free", () => {
    // A suspension reason lives on the system of record, never on the event: free text is
    // exactly how a name, an email or a phone number reaches the spine.
    const result = validateEvent(
      lifecycleEvent("payer.suspended", { ...base, reason: "fraud reported by boss@acme.com" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid payer_id (an email-shaped id would be PII)", () => {
    const result = validateEvent(
      lifecycleEvent("payer.activated", { ...base, payer_id: "boss@acme.com" }),
    );
    expect(result.success).toBe(false);
  });

  // ── Decision 1 — the INVENTORY cascade ────────────────────────────────────────
  const inventory = { payer_id: UUID_A, postings_affected: 3, jobs_affected: 1 };

  for (const name of ["payer.inventory_suspended", "payer.inventory_reinstated"]) {
    it(`${name} validates with COUNTS only — never posting ids or titles`, () => {
      const result = validateEvent(lifecycleEvent(name, inventory));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.event.payload).sort()).toEqual(
          ["jobs_affected", "payer_id", "postings_affected"].sort(),
        );
      }
    });
  }

  it("accepts a ZERO-count cascade — the evidence that it ran and found nothing", () => {
    // Suppressing this event when nothing moved would make "the payer had no live jobs"
    // indistinguishable from "the cascade never executed" — the exact question an
    // investigator asks after a job is reported still-visible post-suspension.
    const result = validateEvent(
      lifecycleEvent("payer.inventory_suspended", {
        payer_id: UUID_A,
        postings_affected: 0,
        jobs_affected: 0,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a NEGATIVE affected count (a count is a count)", () => {
    const result = validateEvent(
      lifecycleEvent("payer.inventory_suspended", { ...inventory, postings_affected: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects smuggled posting ids or titles — .strict() keeps the spine faceless", () => {
    // The per-row truth lives on job_postings.status/previous_status (the system of
    // record). An id list here would grow unbounded with the payer's inventory, and a
    // role title is free text — the way an org name reaches the spine.
    for (const extra of [
      { posting_ids: [UUID_B] },
      { role_titles: ["CNC Operator at Acme Industries"] },
    ]) {
      const result = validateEvent(
        lifecycleEvent("payer.inventory_suspended", { ...inventory, ...extra }),
      );
      expect(result.success).toBe(false);
    }
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
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["method", "payer_id", "role"].sort(),
      );
    }
  });

  it("rejects a payer.created role outside the {employer,agent} enum (no free text)", () => {
    const bad = validateEvent(
      payerAuthEvent("payer.created", {
        payer_id: UUID_A,
        role: "Acme Pvt Ltd",
        method: "email_otp",
      }),
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

    // ADR-0024 final addendum: the four worker-visible content KEYS are ADDITIVE
    // enum members (no version bump) — the screened free text itself never enters.
    const okNew = validateEvent(
      jobEvent("job.updated", {
        job_id: UUID_A,
        payer_id: UUID_B,
        status: "open",
        changed_fields: ["description", "shift", "benefits", "requirements"],
      }),
    );
    expect(okNew.success).toBe(true);

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

describe("worker.otp_send_failed (F4 #168 — AGGREGATE, PII-free, provider literal + reason enum)", () => {
  function sendFailedEvent(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "worker.otp_send_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: null },
      payload,
    };
  }

  it("validates each failure reason with the two-field aggregate shape (no PII fields exist)", () => {
    for (const reason of ["transport", "http_error", "provider_rejected"]) {
      const result = validateEvent(sendFailedEvent({ provider: "fast2sms", reason }));
      expect(result.success).toBe(true);
      if (result.success && result.event.event_name === "worker.otp_send_failed") {
        // The payload schema has NO field that could hold a phone/hash/code/status —
        // only the provider literal + the reason enum.
        expect(Object.keys(result.event.payload).sort()).toEqual(["provider", "reason"]);
      }
    }
  });

  it("rejects an out-of-enum reason (no status-code free text → no PII)", () => {
    const bad = validateEvent(sendFailedEvent({ provider: "fast2sms", reason: "HTTP 401" }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects a provider other than the 'fast2sms' literal", () => {
    const bad = validateEvent(sendFailedEvent({ provider: "twilio", reason: "transport" }));
    expect(bad.success).toBe(false);
  });

  it("rejects smuggled extra fields — .strict() (a phone/hash/status can never ride along)", () => {
    const bad = validateEvent(
      sendFailedEvent({ provider: "fast2sms", reason: "transport", phone_hash: "abcd1234" }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
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

  // ── admin.worker_journey_viewed (Phase 6) — the audit of a READ ────────────────────────
  // Behind `read_entities`, so it is the compensating control for a surface four roles can
  // reach: a per-worker journey is a BEHAVIOURAL profile, and looking at one must name who
  // looked and at whom. The payload is opaque ids + one enum, and these tests are what stop a
  // "just add the question key, it's only a key" change from landing on the spine.

  it("validates admin.worker_journey_viewed with ids + a view enum ONLY (Phase 6)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: { admin_id: UUID_A, subject_id: UUID_B, view: "journey_summary" },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.worker_journey_viewed") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["admin_id", "chat_session_id", "subject_id", "view"].sort(),
      );
      // The summary read opens no session, and that reads as NULL rather than as absent.
      expect(result.event.payload.chat_session_id).toBeNull();
    }
  });

  it("carries the chat_session_id when ONE session was opened (which session is the audit fact)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: {
        admin_id: UUID_A,
        subject_id: UUID_B,
        view: "chat_session",
        chat_session_id: UUID_C,
      },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.worker_journey_viewed") {
      expect(result.event.payload.chat_session_id).toBe(UUID_C);
    }
  });

  it("rejects a QUESTION KEY on the payload (.strict — the stall point is not spine data)", () => {
    // WHICH question a worker stalled on is a fact about that worker. It belongs in the
    // response to the authenticated admin, never in the append-only audit spine.
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: {
        admin_id: UUID_A,
        subject_id: UUID_B,
        view: "chat_session",
        stuck_question: "salary_expected",
      },
    };
    const bad = validateEvent(evt);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects an unknown view (a closed enum — never a free-text label)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: { admin_id: UUID_A, subject_id: UUID_B, view: "transcript" },
    };
    expect(validateEvent(evt).success).toBe(false);
  });

  it("rejects a non-uuid subject_id (opaque ids only — never a name or a phone)", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: { admin_id: UUID_A, subject_id: "Ramesh Kumar", view: "journey_summary" },
    };
    expect(validateEvent(evt).success).toBe(false);
  });

  // ── admin.feedback_viewed (ADR-0025 Amendment 1) — the audit of reading a worker's WORDS ─
  // The journey read's sibling, for the one admin surface that projects worker-authored free
  // text. Same capability floor, higher stake: `message` may hold the worker's own name and
  // phone number, which is why the row is sanctioned and the SPINE is not. These tests are what
  // stop a "just include an excerpt so the audit is useful" change from landing.

  it("validates admin.feedback_viewed with an admin, the filters and a count", () => {
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.feedback_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, worker_id: UUID_B, category: "problem", result_count: 3 },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.feedback_viewed") {
      expect(Object.keys(result.event.payload).sort()).toEqual([
        "admin_id",
        "category",
        "result_count",
        "worker_id",
      ]);
    }
  });

  it("defaults both filters to null — an UNFILTERED read is a fact, not a gap", () => {
    // "This admin read everyone's feedback" is a stronger fact than "this admin read one
    // worker's", so it has to be legible on the row rather than inferred from a missing key.
    const evt = {
      ...workerCreatedEvent(),
      event_name: "admin.feedback_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, result_count: 50 },
    };
    const result = validateEvent(evt);
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "admin.feedback_viewed") {
      expect(result.event.payload.worker_id).toBeNull();
      expect(result.event.payload.category).toBeNull();
    }
  });

  it("REJECTS message text under any name, and a LENGTH too (.strict)", () => {
    // The length is the interesting refusal. `feedback.submitted` carries one, because that is
    // the shape of a submission the WORKER chose to make. Here it would be a fact about what an
    // admin was SHOWN — it adds nothing to `result_count` and starts the audit spine down the
    // road of describing the content it exists not to hold.
    for (const extra of [
      { message: "mera naam Ramesh hai, 9876543210" },
      { message_text: "the app keeps logging me out" },
      { message_excerpt: "the app keeps" },
      { message_length: 142 },
      { messages: ["a", "b"] },
    ]) {
      const evt = {
        ...workerCreatedEvent(),
        event_name: "admin.feedback_viewed",
        actor: { actor_type: "admin", actor_id: UUID_A },
        subject: { subject_type: "admin_session", subject_id: UUID_A },
        payload: { admin_id: UUID_A, result_count: 1, ...extra },
      };
      const bad = validateEvent(evt);
      expect(bad.success, JSON.stringify(extra)).toBe(false);
      if (!bad.success) expect(bad.error.stage).toBe("payload");
    }
  });

  it("rejects an unknown category and a non-uuid worker filter", () => {
    const evt = (payload: object) => ({
      ...workerCreatedEvent(),
      event_name: "admin.feedback_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload,
    });
    expect(
      validateEvent(evt({ admin_id: UUID_A, category: "spam", result_count: 1 })).success,
    ).toBe(false);
    // A name where an opaque id belongs is the shape this whole surface exists to prevent.
    expect(
      validateEvent(evt({ admin_id: UUID_A, worker_id: "Ramesh Kumar", result_count: 1 })).success,
    ).toBe(false);
  });

  it("rejects a negative or fractional result_count", () => {
    const evt = (result_count: unknown) => ({
      ...workerCreatedEvent(),
      event_name: "admin.feedback_viewed",
      actor: { actor_type: "admin", actor_id: UUID_A },
      subject: { subject_type: "admin_session", subject_id: UUID_A },
      payload: { admin_id: UUID_A, result_count },
    });
    expect(validateEvent(evt(-1)).success).toBe(false);
    expect(validateEvent(evt(1.5)).success).toBe(false);
    // Zero is legitimate: a read that found nothing is still a read, and the trail must say so.
    expect(validateEvent(evt(0)).success).toBe(true);
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
      payload: {
        admin_id: UUID_A,
        switch_key: "enable_everything",
        reason_code: "incident_response",
      },
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
  function workerAuthEvent(
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
    for (const smuggle of [
      { phone: "+919876512345" },
      { phone_e164: "+919876512345" },
      { full_name: "Ramesh Kumar" },
      { otp: "482915" },
    ]) {
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

  // D-3 — the gated test-login mint (staging smoke / e2e only, prod-boot-blocked).
  it("validates worker.test_login with ONLY worker_id + phone_hash + is_new_worker (mirrors otp_verified)", () => {
    const result = validateEvent(
      workerAuthEvent("worker.test_login", {
        worker_id: UUID_B,
        phone_hash: "hmac-of-phone",
        is_new_worker: true,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.test_login") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["is_new_worker", "phone_hash", "worker_id"].sort(),
      );
    }
  });

  it("rejects worker.test_login smuggling a raw phone / the gate token / any extra field (strict, §2)", () => {
    for (const smuggle of [
      { phone: "+919876543210" },
      { token: "t".repeat(32) },
      { channel: "test" },
    ]) {
      const bad = validateEvent(
        workerAuthEvent("worker.test_login", {
          worker_id: UUID_B,
          phone_hash: "hmac-of-phone",
          is_new_worker: false,
          ...smuggle,
        }),
      );
      expect(bad.success, `must reject ${JSON.stringify(smuggle)}`).toBe(false);
      if (!bad.success) expect(bad.error.stage).toBe("payload");
    }
  });

  it("rejects worker.test_login missing phone_hash / worker_id (the opaque identity is required)", () => {
    expect(
      validateEvent(
        workerAuthEvent("worker.test_login", { worker_id: UUID_B, is_new_worker: true }),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        workerAuthEvent("worker.test_login", { phone_hash: "hmac-of-phone", is_new_worker: true }),
      ).success,
    ).toBe(false);
  });

  // ADR-0031 — the grace-window pair around the erasure above.
  it("validates worker.deletion_scheduled with ONLY worker_id + scheduled_for (ISO)", () => {
    const result = validateEvent(
      workerAuthEvent("worker.deletion_scheduled", {
        worker_id: UUID_B,
        scheduled_for: "2026-07-21T10:00:00.000Z",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.deletion_scheduled") {
      expect(Object.keys(result.event.payload).sort()).toEqual(["scheduled_for", "worker_id"]);
    }
  });

  it("rejects worker.deletion_scheduled with a non-ISO scheduled_for", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.deletion_scheduled", {
        worker_id: UUID_B,
        scheduled_for: "next tuesday",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects worker.deletion_scheduled/cancelled smuggling PII (strict — §2)", () => {
    for (const smuggle of [
      { phone: "+919876512345" },
      { phone_e164: "+919876512345" },
      { full_name: "Ramesh Kumar" },
      { phone_hash: "leaked" },
      { otp: "482915" },
    ]) {
      const badScheduled = validateEvent(
        workerAuthEvent("worker.deletion_scheduled", {
          worker_id: UUID_B,
          scheduled_for: "2026-07-21T10:00:00.000Z",
          ...smuggle,
        }),
      );
      expect(badScheduled.success, `scheduled must reject ${JSON.stringify(smuggle)}`).toBe(false);
      if (!badScheduled.success) expect(badScheduled.error.stage).toBe("payload");

      const badCancelled = validateEvent(
        workerAuthEvent("worker.deletion_cancelled", { worker_id: UUID_B, ...smuggle }),
      );
      expect(badCancelled.success, `cancelled must reject ${JSON.stringify(smuggle)}`).toBe(false);
      if (!badCancelled.success) expect(badCancelled.error.stage).toBe("payload");
    }
  });

  it("validates worker.deletion_cancelled with ONLY worker_id (nothing else to know)", () => {
    const result = validateEvent(
      workerAuthEvent("worker.deletion_cancelled", { worker_id: UUID_B }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.deletion_cancelled") {
      expect(Object.keys(result.event.payload)).toEqual(["worker_id"]);
    }
  });

  it("validates worker.resume_prefs_updated with ONLY worker_id + the two boolean flags", () => {
    const result = validateEvent(
      workerAuthEvent("worker.resume_prefs_updated", {
        worker_id: UUID_B,
        show_photo: false,
        night_shift_ready: true,
      }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "worker.resume_prefs_updated") {
      expect(Object.keys(result.event.payload).sort()).toEqual(
        ["night_shift_ready", "show_photo", "worker_id"].sort(),
      );
    }
  });

  it("rejects worker.resume_prefs_updated with a non-boolean flag", () => {
    const bad = validateEvent(
      workerAuthEvent("worker.resume_prefs_updated", {
        worker_id: UUID_B,
        show_photo: "yes",
        night_shift_ready: false,
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates worker.photo_uploaded / worker.photo_removed with worker_id ONLY (ADR-0032)", () => {
    for (const name of ["worker.photo_uploaded", "worker.photo_removed"] as const) {
      const ok = validateEvent(workerAuthEvent(name, { worker_id: UUID_B }));
      expect(ok.success, `${name} must accept worker_id-only`).toBe(true);
      if (ok.success) {
        expect(Object.keys(ok.event.payload)).toEqual(["worker_id"]);
      }
    }
  });

  it("rejects worker.photo_* smuggling the object key / a URL / any extra field (strict, §2)", () => {
    for (const name of ["worker.photo_uploaded", "worker.photo_removed"] as const) {
      for (const smuggle of [
        { storage_path: "photos/w-1/x.jpg" },
        { url: "https://storage.example/signed?token=abc" },
        { full_name: "Ramesh Kumar" },
      ]) {
        const bad = validateEvent(workerAuthEvent(name, { worker_id: UUID_B, ...smuggle }));
        expect(bad.success, `${name} must reject ${JSON.stringify(smuggle)}`).toBe(false);
        if (!bad.success) expect(bad.error.stage).toBe("payload");
      }
    }
  });

  it("rejects worker.resume_prefs_updated carrying a smuggled PII field (strict payload)", () => {
    for (const smuggle of [{ full_name: "Ramesh Kumar" }, { phone: "+919876512345" }]) {
      const bad = validateEvent(
        workerAuthEvent("worker.resume_prefs_updated", {
          worker_id: UUID_B,
          show_photo: true,
          night_shift_ready: false,
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

describe("messaging.suppressed reason enum (ADR-0020; pending_deletion added by ADR-0031)", () => {
  function suppressedEvent(reason: string): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "messaging.suppressed",
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload: { worker_id: UUID_B, template: "reengage_v1", reason },
    };
  }

  it("accepts the two ADR-0020 reasons AND pending_deletion (ADDITIVE extension, still v1)", () => {
    for (const reason of ["no_consent", "unknown_worker", "pending_deletion"]) {
      const result = validateEvent(suppressedEvent(reason));
      expect(result.success, `reason "${reason}" must be a valid suppress reason`).toBe(true);
    }
    // Enum EXTENSION, not mutation (§2.8): same event, same version — every
    // previously-valid payload stays valid.
    expect(EVENT_REGISTRY["messaging.suppressed"].version).toBe(1);
  });

  it("rejects an unknown suppress reason (closed enum — no free text on the audit spine)", () => {
    const bad = validateEvent(suppressedEvent("worker_left_the_city"));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });
});

// ADR-0034 — push events. The push TOKEN is the delivery address and a secret; the
// rendered copy is static and reconstructible. Neither may ever enter the spine, and
// `.strict()` is what makes that structural rather than a convention.
describe("worker.push_sent / worker.push_send_failed (ADR-0034)", () => {
  function pushEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: UUID_A },
      payload,
    };
  }
  const base = { worker_id: UUID_A, source_event_id: UUID_B };

  it("accepts the PII-free shape", () => {
    const ok = validateEvent(
      pushEvent("worker.push_sent", { ...base, type: "security", device_count: 2 }),
    );
    expect(ok.success).toBe(true);
  });

  it("REJECTS a smuggled push_token (the delivery address is a secret)", () => {
    const bad = validateEvent(
      pushEvent("worker.push_sent", {
        ...base,
        type: "security",
        device_count: 1,
        push_token: "fcm-secret-token",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("REJECTS smuggled copy / device ids (reconstructible or identifying)", () => {
    for (const extra of [{ title: "Naye device se login" }, { device_ids: [UUID_C] }]) {
      const bad = validateEvent(
        pushEvent("worker.push_sent", {
          ...base,
          type: "security",
          device_count: 1,
          ...extra,
        }),
      );
      expect(bad.success).toBe(false);
    }
  });

  it("failure reason is a CLOSED enum — never a provider response body", () => {
    const ok = validateEvent(
      pushEvent("worker.push_send_failed", { ...base, reason: "unregistered" }),
    );
    expect(ok.success).toBe(true);

    const bad = validateEvent(
      pushEvent("worker.push_send_failed", {
        ...base,
        reason: '{"error":{"details":[{"token":"fcm-secret"}]}}',
      }),
    );
    expect(bad.success).toBe(false);
  });
});

describe("worker.push_token_claimed (TD92)", () => {
  function claimedEvent(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "worker.push_token_claimed",
      actor: { actor_type: "worker", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  it("accepts the PII-free shape (winning actor, losing subject, count only)", () => {
    const ok = validateEvent(claimedEvent({ worker_id: UUID_B, device_count: 2 }));
    expect(ok.success).toBe(true);
  });

  it("REJECTS a smuggled push_token or device id (.strict)", () => {
    for (const extra of [{ push_token: "fcm-secret" }, { device_ids: [UUID_C] }]) {
      const bad = validateEvent(claimedEvent({ worker_id: UUID_B, device_count: 1, ...extra }));
      expect(bad.success).toBe(false);
    }
  });

  it("REJECTS a non-uuid worker_id and negative count", () => {
    const badId = validateEvent(claimedEvent({ worker_id: "not-a-uuid", device_count: 1 }));
    expect(badId.success).toBe(false);
    const badCount = validateEvent(claimedEvent({ worker_id: UUID_B, device_count: -1 }));
    expect(badCount.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// job_posting_chat.* (ADR-0035) — the AI job-posting chat domain.
//
// The privacy contract is the point of these tests: the payer's typed message,
// any draft field VALUE, and the payer's organisation name must be structurally
// unable to reach the spine. `.strict()` is what makes that true, so each schema
// is probed with the exact keys a careless caller would add.
// ---------------------------------------------------------------------------
describe("job_posting_chat.* (ADR-0035)", () => {
  const chatEvent = (
    name:
      | "job_posting_chat.session_started"
      | "job_posting_chat.message_sent"
      | "job_posting_chat.draft_ready",
    payload: Record<string, unknown>,
    subjectType = "payer_job_posting_chat_session",
  ): Record<string, unknown> => ({
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-07-28T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: UUID_B },
    subject: { subject_type: subjectType, subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_C,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  });

  it("accepts the PII-free session_started / draft_ready shape (two opaque ids)", () => {
    for (const name of [
      "job_posting_chat.session_started",
      "job_posting_chat.draft_ready",
    ] as const) {
      const ok = validateEvent(chatEvent(name, { session_id: UUID_C, payer_id: UUID_B }));
      expect(ok.success).toBe(true);
    }
  });

  it("accepts message_sent with ids + the message-type enum", () => {
    const ok = validateEvent(
      chatEvent(
        "job_posting_chat.message_sent",
        { session_id: UUID_C, payer_id: UUID_B, message_id: UUID_A, message_type: "text" },
        "payer_job_posting_chat_message",
      ),
    );
    expect(ok.success).toBe(true);
  });

  it("REJECTS smuggled chat free text, draft VALUES, or the payer's org name (.strict)", () => {
    const smuggled = [
      { body_text: "we need 5 welders, call me on 9876543210" },
      { text: "night shift, 25000 rupees" },
      { org_label: "Sharma Engineering Works" },
      { company: "Sharma Engineering Works" },
      { role_title: "CNC Operator" },
      { location_label: "Pune" },
      { description: "day shift, PF + ESI" },
      { pay_min: 20000 },
      { draft: { role_title: "CNC Operator" } },
    ];
    for (const extra of smuggled) {
      const bad = validateEvent(
        chatEvent("job_posting_chat.session_started", {
          session_id: UUID_C,
          payer_id: UUID_B,
          ...extra,
        }),
      );
      expect(bad.success).toBe(false);
    }
  });

  it("REJECTS a non-uuid payer/session id and an unknown message_type", () => {
    expect(
      validateEvent(
        chatEvent("job_posting_chat.session_started", { session_id: UUID_C, payer_id: "acme-ltd" }),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        chatEvent(
          "job_posting_chat.message_sent",
          {
            session_id: UUID_C,
            payer_id: UUID_B,
            message_id: UUID_A,
            message_type: "draft",
          },
          "payer_job_posting_chat_message",
        ),
      ).success,
    ).toBe(false);
  });

  it("has NO publish event — publish reuses the shipped job_posting.created", () => {
    // ADR-0035 §Decision 6: this slice adds no second writer of job_posting.created.
    expect(isEventName("job_posting_chat.published")).toBe(false);
    expect(EVENT_NAMES.filter((n) => n.startsWith("job_posting_chat."))).toHaveLength(3);
  });
});

describe("chat.session_abandoned (idle sweep — COUNTS ONLY, no transcript)", () => {
  const abandoned = (payload: Record<string, unknown>) => ({
    event_id: UUID_A,
    event_name: "chat.session_abandoned",
    event_version: 1,
    occurred_at: "2026-08-14T10:00:00.000Z",
    // The SWEEP closed this session, not the worker — the actor is the system.
    actor: { actor_type: "system" },
    subject: { subject_type: "chat_session", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_C,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  });

  const valid = {
    session_id: UUID_C,
    worker_id: UUID_A,
    transcript_recovered: true,
    messages_preserved: 12,
    answers_preserved: 4,
    idle_minutes: 380,
  };

  it("accepts ids, counts and the recovery flag", () => {
    expect(validateEvent(abandoned(valid)).success).toBe(true);
  });

  it("carries NO message text — a stray free-text field is rejected, not passed through", () => {
    // The transcript is raw PII and lives in `chat_messages`. If this ever starts accepting
    // prose, an abandoned interview's words would land in the events table (§2).
    const withText = { ...valid, last_message: "mera naam Ramesh hai, 9876543210" };
    const result = validateEvent(abandoned(withText));
    if (result.success) {
      expect(result.event.payload).not.toHaveProperty("last_message");
    }
  });

  it("rejects negative counts (a count is evidence; a negative one is a bug)", () => {
    expect(validateEvent(abandoned({ ...valid, messages_preserved: -1 })).success).toBe(false);
    expect(validateEvent(abandoned({ ...valid, idle_minutes: -5 })).success).toBe(false);
  });

  it("requires the recovery flag — 'transcript lost' must never be silently omitted", () => {
    const { transcript_recovered: _omitted, ...withoutFlag } = valid;
    expect(validateEvent(abandoned(withoutFlag)).success).toBe(false);
  });
});

describe("registry", () => {
  it("exposes all 163 event names (146 prior + notification prefs + the five OIE cutover events + two Phase 9 telemetry + the review-screen correction + payer.test_login + the LLM-interview fallback + job.search_performed + chat.session_abandoned + the duplicate submission + skill.phrase_unresolved_v2 + the admin worker-journey read audit + worker feedback)", () => {
    expect(EVENT_NAMES).toHaveLength(164);
    // #997 — the worker addressing the platform in their own words. The only worker-authored
    // free text on the spine whose system-of-record row is deliberately allowed to hold the
    // worker's own PII; the EVENT carries the category, the length and the build, never the
    // words. Its own `describe` block below is what keeps that true.
    expect(isEventName("feedback.submitted")).toBe(true);
    // S3-C / D-6 — the canonical-scope generation of the skill-miss event. A SECOND
    // registry entry rather than a v1 mutation; see the payload's own note.
    expect(isEventName("skill.phrase_unresolved_v2")).toBe(true);
    // Phase 6 — the ONE audited READ outside the PII reveal. A worker's journey is a
    // behavioural profile, so who looked at it is spine data even though the response is not.
    expect(isEventName("admin.worker_journey_viewed")).toBe(true);
    // ADR-0025 Amendment 1 — the sibling of the journey read, for the surface that returns the
    // worker's actual WORDS. Reading a worker's step counts already left a trail; reading their
    // prose left none, which made FeedbackService's own "behind an audited surface" claim false.
    expect(isEventName("admin.feedback_viewed")).toBe(true);
    // #931 — one physical submission arriving twice. Invisible on the spine otherwise: a
    // duplicate returns before the engine is consulted, so it writes no `chat_messages` row and
    // emits no `chat.message_received`, and everything downstream looks like a healthy session
    // precisely because the damage was absorbed. Also the rollout gate for retiring the four
    // reply-cache clocks.
    expect(isEventName("profile.submission_duplicated")).toBe(true);
    // The LLM-led opening handed back to the deterministic engine. Designed to be invisible to
    // the worker, so this event is the only place a degraded ai-service becomes visible at all.
    expect(isEventName("profile.llm_interview_fallback")).toBe(true);
    // The pack pin — which QUESTIONS the worker got, as distinct from which trade they are in.
    // Separate from `occupation_identified` because a trade can resolve while its family has no
    // authored pack, which is the normal state during Phase 6 authoring.
    expect(isEventName("profile.pack_pinned")).toBe(true);
    // #700 — the review screen's correction. The one interview write with no `chat_messages` row
    // behind it, so without this event a stored value would change with nothing recording it.
    expect(isEventName("profile.answer_corrected")).toBe(true);
    // OIE Phase 9 — the interview's own record. Separate from `profile.extraction_ready`,
    // which is a downstream trigger: one says "there is work to do", the other "here is how
    // the engine performed". The only source for p95 turn latency and the completion rate.
    expect(isEventName("profile.interview_completed")).toBe(true);
    // ...and how much the six-gate wall discarded. The gates always worked; the RATE is what
    // says the model started inventing spans or reading our own questions back to us.
    expect(isEventName("profile.parse_gates_rejected")).toBe(true);
    // #643 — the worker's push toggle. Emitted because the flag GATES the ADR-0034
    // fan-out; the Alerts read watermark shipped with it emits nothing (a read
    // position is not a business action, §1) and deliberately has no name here.
    expect(isEventName("worker.notification_prefs_updated")).toBe(true);
    expect(isEventName("worker.notifications_read")).toBe(false);
    // ADR-0037 — the payer lifecycle transitions.
    expect(isEventName("payer.activated")).toBe(true);
    expect(isEventName("payer.suspended")).toBe(true);
    expect(isEventName("payer.reinstated")).toBe(true);
    // ADR-0037 Decision 1 — the INVENTORY cascade, recorded separately from the session
    // freeze because the two are different state changes and either can move zero rows.
    expect(isEventName("payer.inventory_suspended")).toBe(true);
    expect(isEventName("payer.inventory_reinstated")).toBe(true);
    // ADR-0037 Decision 5 — the ONLY record of a login attempt on a suspended account
    // (the HTTP response is deliberately neutral).
    expect(isEventName("payer.otp_suppressed")).toBe(true);
    // ADR-0037 Decision 6 — the Finance/Admin alert for money captured on a banned account.
    expect(isEventName("payer.suspended_payment_captured")).toBe(true);
    // B4 RESOLVER (migration 0060): the referral_links primitive's three events.
    expect(isEventName("referral.link_created")).toBe(true);
    expect(isEventName("referral.link_clicked")).toBe(true);
    expect(isEventName("referral.install_claimed")).toBe(true);
    // B4 attribution chain + §X.6 (blocker: invite.install / worker.active were NOT FOUND).
    expect(isEventName("invite.install")).toBe(true);
    expect(isEventName("worker.active")).toBe(true);
    expect(isEventName("agency_invite.clicked")).toBe(true);
    expect(isEventName("referral.bonus_accrued")).toBe(true);
    // ADR-0036 — Matching V1. Six new v1 events + the versioned feed.shown_v2.
    expect(isEventName("worker.match_skills_rebuilt")).toBe(true);
    expect(isEventName("job_posting.reach_materialized")).toBe(true);
    expect(isEventName("job_posting.reach_alert")).toBe(true);
    expect(isEventName("job_posting.reach_widened")).toBe(true);
    expect(isEventName("job_posting.boost_refused")).toBe(true);
    expect(isEventName("payer.credits_exhausted")).toBe(true);
    expect(isEventName("feed.shown_v2")).toBe(true);
    // …and the shipped v1 `feed.shown` is STILL registered, unmodified (invariant #8).
    expect(isEventName("feed.shown")).toBe(true);
    expect(isEventName("job_posting_chat.session_started")).toBe(true);
    expect(isEventName("job_posting_chat.message_sent")).toBe(true);
    expect(isEventName("job_posting_chat.draft_ready")).toBe(true);
    expect(isEventName("consent.revoked")).toBe(true);
    expect(isEventName("interview_kit.ready_for_worker")).toBe(true);
    expect(isEventName("job_posting.verification_updated")).toBe(true);
    expect(isEventName("job.available")).toBe(true);
    expect(isEventName("profile.viewed")).toBe(true);
    expect(isEventName("skill.phrase_unresolved")).toBe(true);
    expect(isEventName("worker.otp_send_failed")).toBe(true);
    expect(isEventName("worker.deletion_scheduled")).toBe(true);
    expect(isEventName("worker.deletion_cancelled")).toBe(true);
    expect(isEventName("worker.push_sent")).toBe(true);
    expect(isEventName("worker.push_send_failed")).toBe(true);
    expect(isEventName("worker.resume_prefs_updated")).toBe(true);
    expect(isEventName("worker.test_login")).toBe(true);
    expect(isEventName("worker.photo_uploaded")).toBe(true);
    expect(isEventName("worker.photo_removed")).toBe(true);
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
    expect(isEventName("agency_kyc.submitted")).toBe(true);
    expect(isEventName("agency_kyc.verified")).toBe(true);
    expect(isEventName("agency_kyc.rejected")).toBe(true);
    expect(isEventName("agency_payout.accrued")).toBe(true);
    expect(isEventName("agency_payout.requested")).toBe(true);
    expect(isEventName("agency_payout.blocked")).toBe(true);
    expect(isEventName("agency_payout.paid")).toBe(true);
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
    // The Occupation Intelligence Engine's four (Phase 8 cutover).
    expect(isEventName("occupation.phrase_unresolved")).toBe(true);
    expect(isEventName("profile.occupation_identified")).toBe(true);
    expect(isEventName("profile.occupation_unresolved")).toBe(true);
    expect(isEventName("profile.parse_disagreement")).toBe(true);
    expect(isEventName("nope")).toBe(false);
  });

  /**
   * The versioning lock. Every payload is v1 EXCEPT the ones deliberately versioned by
   * an ADR, which are enumerated here by name. That keeps the original guarantee — an
   * accidental version bump fails this test — while recording each intentional bump as
   * a reviewable line in the diff rather than deleting the lock outright.
   *
   * `feed.shown_v2` (ADR-0036): a SECOND registry entry, not a mutation of `feed.shown`.
   * `validateEvent` allows exactly one version per name, so the shipped v1 payload stays
   * live and unmodified as history (invariant #8) while V1 emits the new generation.
   */
  const VERSIONED_PAYLOADS: Readonly<Record<string, number>> = {
    "feed.shown_v2": 2,
    // S3-C / D-6: the canonical-scope generation of `skill.phrase_unresolved`. Same
    // reason as `feed.shown_v2` — v1's `domain_id` is REQUIRED and a Path A miss has no
    // legacy slug, so the alternative was relaxing a shipped required field.
    "skill.phrase_unresolved_v2": 2,
  };

  it("every registry entry is version 1 except the ADR-versioned payloads", () => {
    for (const name of EVENT_NAMES) {
      expect(EVENT_REGISTRY[name].version).toBe(VERSIONED_PAYLOADS[name] ?? 1);
    }
  });

  it("keeps the shipped feed.shown v1 payload EXACTLY as it was (invariant #8)", () => {
    const v1 = EVENT_REGISTRY["feed.shown"];
    expect(v1.version).toBe(1);
    // score/hot are the v1 fields ADR-0036 retires. They must still parse here, or the
    // legacy `/feed` + ops `/reach/*` emitters break on a MATCH_V1_ENABLED=false deploy.
    expect(
      v1.payload.safeParse({ worker_id: UUID_A, job_id: UUID_B, rank: 1, score: 0, hot: false })
        .success,
    ).toBe(true);
    // …and v2's fields are NOT accepted by v1 (the two shapes are genuinely distinct).
    const v2Shape = v1.payload.safeParse({
      worker_id: UUID_A,
      job_posting_id: UUID_B,
      rank: 1,
      match_tier: 1,
      boosted: false,
      matched_skill_id: "mskill_vmc_operator",
    });
    expect(v2Shape.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B4 attribution chain + §X.6 — invite.install / worker.active /
// agency_invite.clicked / referral.bonus_accrued.
//
// Every one is `.strict()`, so the "no raw PII" rule is STRUCTURAL, not a convention:
// a phone, a name, a phone_hash, or the shareable invite CODE cannot ride onto the
// spine even if a future caller tries to pass it.
// ---------------------------------------------------------------------------
describe("invite.install payload (B4) — opaque row id + closed enums, strict", () => {
  const base = { invite_id: UUID_A, invite_kind: "worker", source: "install_referrer" };
  const make = (payload: object, subject: "invite" | "agency_invite" = "invite") =>
    createEvent({
      event_name: "invite.install",
      actor: { actor_type: "system" },
      subject: { subject_type: subject, subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts every install SOURCE of the post-Dynamic-Links chain", () => {
    for (const source of ["app_link", "install_referrer", "custom_scheme", "unknown"]) {
      expect(validateEvent(make({ ...base, source })).success).toBe(true);
    }
  });

  it("carries BOTH funnels via invite_kind + the matching subject_type", () => {
    expect(validateEvent(make({ ...base, invite_kind: "worker" }, "invite")).success).toBe(true);
    expect(validateEvent(make({ ...base, invite_kind: "agency" }, "agency_invite")).success).toBe(
      true,
    );
  });

  it("REJECTS the shareable code, a phone, or any extra key (.strict — a code is a bearer token)", () => {
    expect(() => make({ ...base, code: "abcdef012345" })).toThrow(EventValidationException);
    expect(() => make({ ...base, phone_e164: "+919876543210" })).toThrow(EventValidationException);
    expect(() => make({ ...base, invited_worker_id: UUID_B })).toThrow(EventValidationException);
  });

  it("REJECTS an unknown/free-text source (closed enum — no client string reaches the spine)", () => {
    expect(() => make({ ...base, source: "whatsapp_forward" })).toThrow(EventValidationException);
    expect(() => make({ ...base, source: "" })).toThrow(EventValidationException);
  });

  it("REQUIRES source (the API defaults it to 'unknown' BEFORE emitting, never omits it)", () => {
    expect(() => make({ invite_id: UUID_A, invite_kind: "worker" })).toThrow(
      EventValidationException,
    );
  });
});

describe("worker.active payload (X.6) — coarse day bucket, never a trace, strict", () => {
  const base = { worker_id: UUID_A, day: "2026-07-30" };
  const make = (payload: object) =>
    createEvent({
      event_name: "worker.active",
      actor: { actor_type: "worker", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts the worker_id + UTC day bucket", () => {
    expect(validateEvent(make(base)).success).toBe(true);
  });

  it("REJECTS a finer-grained timestamp in `day` (a per-request trace, not a daily fact)", () => {
    expect(() => make({ ...base, day: "2026-07-30T11:22:33.000Z" })).toThrow(
      EventValidationException,
    );
    expect(() => make({ ...base, day: "20260730" })).toThrow(EventValidationException);
  });

  it("REJECTS route/session/ip/user-agent keys (.strict — this must never become a request log)", () => {
    expect(() => make({ ...base, route: "/chat/message" })).toThrow(EventValidationException);
    expect(() => make({ ...base, session_id: UUID_B })).toThrow(EventValidationException);
    expect(() => make({ ...base, ip_hash: "deadbeef" })).toThrow(EventValidationException);
    expect(() => make({ ...base, phone_hash: "deadbeef" })).toThrow(EventValidationException);
  });
});

describe("agency_invite.clicked payload (TD113) — no worker handle before consent, strict", () => {
  const base = { agency_invite_id: UUID_A, inviter_payer_id: UUID_B, channel: "whatsapp" };
  const make = (payload: object) =>
    createEvent({
      event_name: "agency_invite.clicked",
      actor: { actor_type: "system" },
      subject: { subject_type: "agency_invite", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts the opaque row + owning agency + channel", () => {
    expect(validateEvent(make(base)).success).toBe(true);
  });

  it("REJECTS a worker handle — a click precedes the DPDP consent gate (invariant #6)", () => {
    expect(() => make({ ...base, invited_worker_id: UUID_C })).toThrow(EventValidationException);
  });

  it("REJECTS the shareable code and any extra key (.strict)", () => {
    expect(() => make({ ...base, code: "abcdef012345" })).toThrow(EventValidationException);
    expect(() => make({ ...base, ip: "203.0.113.7" })).toThrow(EventValidationException);
  });
});

describe("referral.bonus_accrued payload (X.6) — ₹ + opaque ids only, strict", () => {
  const base = {
    accrual_id: UUID_A,
    inviter_worker_id: UUID_B,
    invited_worker_id: UUID_C,
    amount_inr: 20,
  };
  const make = (payload: object) =>
    createEvent({
      event_name: "referral.bonus_accrued",
      actor: { actor_type: "system" },
      subject: { subject_type: "referral_bonus", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts the ₹20 accrual shape", () => {
    expect(validateEvent(make(base)).success).toBe(true);
  });

  it("REJECTS a phone_hash — two worker ids + a shared hash would be a re-identification join", () => {
    expect(() => make({ ...base, phone_hash: "a".repeat(64) })).toThrow(EventValidationException);
  });

  it("REJECTS a disqualify reason / free text riding along (.strict)", () => {
    expect(() => make({ ...base, reason: "duplicate_phone" })).toThrow(EventValidationException);
    expect(() => make({ ...base, note: "paid via UPI to 9876543210" })).toThrow(
      EventValidationException,
    );
  });

  it("REJECTS paise / fractional or non-positive rupees (whole rupees, like agency_payout.*)", () => {
    expect(() => make({ ...base, amount_inr: 20.5 })).toThrow(EventValidationException);
    expect(() => make({ ...base, amount_inr: 0 })).toThrow(EventValidationException);
    expect(() => make({ ...base, amount_inr: -20 })).toThrow(EventValidationException);
  });

  it("has NO paid sibling — no payout rail exists, and an event name is a promise", () => {
    expect(isEventName("referral.bonus_paid")).toBe(false);
    // THE ACTUAL RULE, stated directly rather than as a side effect of an exact-list match:
    // nothing in the referral domain may NAME a disbursement. Real outbound money is a §7
    // human gate, and shipping the name before the rail is how a mock gets mistaken for one.
    // Expressed as a predicate so it keeps holding as the domain legitimately grows.
    for (const name of EVENT_NAMES.filter((n) => n.startsWith("referral."))) {
      expect(name, name).not.toMatch(/paid|payout|disburse|settle|transfer/i);
    }
    // The exact allowlist, so a NEW referral event is a deliberate review decision.
    // B4 added the three resolver events; none of them moves money — they record that a link
    // was minted, that it was clicked, and which click won a worker's first-touch claim.
    expect(EVENT_NAMES.filter((n) => n.startsWith("referral.")).sort()).toEqual([
      "referral.bonus_accrued",
      "referral.install_claimed",
      "referral.link_clicked",
      "referral.link_created",
    ]);
  });
});

describe("skill.phrase_unresolved_v2 (S3-C / D-6) — the canonical-scope generation", () => {
  const HASH = "b".repeat(64);
  const make = (payload: object) =>
    createEvent({
      event_name: "skill.phrase_unresolved_v2",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "skill_phrase", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts a CANONICAL-scoped miss (job_domain_id set, domain_id null)", () => {
    const event = make({
      phrase_hash: HASH,
      domain_id: null,
      job_domain_id: "jd_nco_7223_0100",
      lang: "hi",
      count: 1,
    });
    expect(validateEvent(event).success).toBe(true);
  });

  it("accepts a LEGACY-scoped miss too — v2 is a superset, not a replacement", () => {
    // The service only emits v2 for canonical misses today, but the payload must be able
    // to express both or a future consolidation would need a v3.
    const event = make({
      phrase_hash: HASH,
      domain_id: "cnc-machining",
      job_domain_id: null,
      lang: "en",
      count: 7,
    });
    expect(validateEvent(event).success).toBe(true);
  });

  it("REJECTS both scopes at once — an event must say which vocabulary failed", () => {
    expect(() =>
      make({
        phrase_hash: HASH,
        domain_id: "cnc-machining",
        job_domain_id: "jd_nco_7223_0100",
        lang: "en",
        count: 1,
      }),
    ).toThrow(EventValidationException);
  });

  it("REJECTS neither scope — mirrors unresolved_phrase_one_domain_chk's intent", () => {
    // Both-null is legal in the TABLE (that is the occupation scope, which has its own
    // event) but meaningless on THIS event, which exists to attribute a skill miss.
    expect(() =>
      make({ phrase_hash: HASH, domain_id: null, job_domain_id: null, lang: "en", count: 1 }),
    ).toThrow(EventValidationException);
  });

  it("stays hash-only — .strict() blocks the phrase riding the spine", () => {
    expect(() =>
      make({
        phrase_hash: HASH,
        domain_id: null,
        job_domain_id: "jd_nco_7223_0100",
        lang: "en",
        count: 1,
        phrase: "[EMPLOYER_1] drawing padhna",
      }),
    ).toThrow(EventValidationException);
  });

  /**
   * THE WHOLE POINT OF A SECOND ENTRY. If a later edit "simplifies" things by relaxing
   * v1's `domain_id` to nullable, this fails — and it should, because every shipped
   * consumer reading `payload.domain_id` without a null check breaks on the first such
   * event. v1 is history and history does not change (invariant #8).
   */
  it("leaves v1 EXACTLY as shipped — domain_id still REQUIRED there", () => {
    const v1 = EVENT_REGISTRY["skill.phrase_unresolved"];
    expect(v1.version).toBe(1);
    expect(
      v1.payload.safeParse({ phrase_hash: HASH, domain_id: "cnc-machining", lang: "en", count: 1 })
        .success,
    ).toBe(true);
    // A null domain_id is still refused by v1 — that refusal is what forced v2 to exist.
    expect(
      v1.payload.safeParse({ phrase_hash: HASH, domain_id: null, lang: "en", count: 1 }).success,
    ).toBe(false);
    // v1 has never heard of job_domain_id, and .strict() keeps it that way.
    expect(
      v1.payload.safeParse({
        phrase_hash: HASH,
        domain_id: "cnc-machining",
        job_domain_id: "jd_nco_7223_0100",
        lang: "en",
        count: 1,
      }).success,
    ).toBe(false);
  });

  it("is registered as a distinct name, so both generations can coexist", () => {
    expect(isEventName("skill.phrase_unresolved")).toBe(true);
    expect(isEventName("skill.phrase_unresolved_v2")).toBe(true);
    expect(EVENT_REGISTRY["skill.phrase_unresolved_v2"].domain).toBe("skill");
  });
});

describe("skill.phrase_unresolved payload (ADR-0030 / FORK-B-1) — hash-only, strict", () => {
  const HASH = "a".repeat(64);
  const base = { phrase_hash: HASH, domain_id: "cnc-machining", lang: "hi", count: 3 };
  const make = (payload: object) =>
    createEvent({
      event_name: "skill.phrase_unresolved",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "skill_phrase", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts the hash-only shape (and the produced event validates)", () => {
    const event = make(base);
    expect(event.event_name).toBe("skill.phrase_unresolved");
    expect(validateEvent(event).success).toBe(true);
  });

  it("rejects a smuggled phrase field (.strict() blocks text riding the spine)", () => {
    expect(() => make({ ...base, phrase: "[EMPLOYER_1] polish work" })).toThrow(
      EventValidationException,
    );
  });

  it("rejects a non-sha256 phrase_hash and a non-positive count", () => {
    expect(() => make({ ...base, phrase_hash: "not-a-hash" })).toThrow(EventValidationException);
    expect(() => make({ ...base, phrase_hash: HASH.slice(0, 63) })).toThrow(
      EventValidationException,
    );
    expect(() => make({ ...base, count: 0 })).toThrow(EventValidationException);
  });
});

describe("job_posting.updated changed_fields — TAX-6 additive enum member", () => {
  it("accepts the new 'skills' field NAME (names only — phrases/ids never ride the spine)", () => {
    const event = createEvent({
      event_name: "job_posting.updated",
      actor: { actor_type: "ops", actor_id: UUID_A },
      subject: { subject_type: "job_posting", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: {
        job_posting_id: UUID_A,
        changed_fields: ["skills"],
        status: "open",
        vacancy_band: null,
      },
    });
    expect(validateEvent(event).success).toBe(true);
  });

  it("still rejects an unknown changed-field name (closed enum, additively extended)", () => {
    expect(() =>
      createEvent({
        event_name: "job_posting.updated",
        actor: { actor_type: "ops", actor_id: UUID_A },
        subject: { subject_type: "job_posting", subject_id: UUID_A },
        source: "api",
        metadata: { environment: "test", service: "api" },
        payload: {
          job_posting_id: UUID_A,
          changed_fields: ["salary_text"] as never,
          status: "open",
          vacancy_band: null,
        },
      }),
    ).toThrow(EventValidationException);
  });
});

/**
 * The Occupation Intelligence Engine's cutover events (Phase 8).
 *
 * Every one of them describes something that happened to a SPECIFIC worker's OWN WORDS,
 * which makes them the highest-risk payloads in the registry for PII leakage: the
 * interesting thing about a retrieval miss or a parse disagreement is precisely the text,
 * and the text is exactly what may never be written. Each `.strict()` is therefore asserted
 * with the field a well-meaning future change would most plausibly add.
 */
describe("OIE cutover payloads (Phase 8) — ids, codes and counts, never worker text", () => {
  function oieEvent(name: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: name,
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: UUID_B },
      payload,
    };
  }

  const IDENTIFIED = {
    worker_id: UUID_B,
    job_domain_id: "jd_nco_7212_0100",
    match_status: "matched_lexical",
    catalog_version: "cat_2026_08_01",
  };

  it("validates profile.occupation_identified and defaults every optional field", () => {
    const result = validateEvent(oieEvent("profile.occupation_identified", IDENTIFIED));
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "profile.occupation_identified") {
      expect(result.event.payload.session_id).toBeNull();
      expect(result.event.payload.family_id).toBeNull();
      expect(result.event.payload.match_layer).toBeNull();
      expect(result.event.payload.candidate_count).toBe(0);
    }
  });

  it("rejects profile.occupation_identified carrying the worker's utterance (.strict)", () => {
    // THE tempting field. "Which words produced this match" is the single most useful thing
    // for tuning retrieval and the single most forbidden thing to put in the event spine —
    // `occupation.phrase_unresolved.phrase_hash` is the only sanctioned shape for it.
    const bad = validateEvent(
      oieEvent("profile.occupation_identified", { ...IDENTIFIED, utterance: "silai ka kaam" }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects an UNMATCHED status on profile.occupation_identified", () => {
    // The name is a claim. An `unmatched_*` status here would make "how many workers did we
    // place" a query nobody can write correctly, because the identified event would silently
    // be counting the failures too.
    const bad = validateEvent(
      oieEvent("profile.occupation_identified", {
        ...IDENTIFIED,
        match_status: "unmatched_below_floor",
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects a match_score outside [0,1] — the CALIBRATED confidence, not a raw layer score", () => {
    const bad = validateEvent(
      oieEvent("profile.occupation_identified", { ...IDENTIFIED, match_score: 1.4 }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates profile.occupation_unresolved across all four reasons", () => {
    for (const reason of ["below_floor", "ambiguous", "declined", "degraded"]) {
      const result = validateEvent(
        oieEvent("profile.occupation_unresolved", {
          worker_id: UUID_B,
          reason,
          catalog_version: "cat_2026_08_01",
        }),
      );
      expect(result.success).toBe(true);
    }
  });

  it("rejects profile.occupation_unresolved with an unlisted reason", () => {
    const bad = validateEvent(
      oieEvent("profile.occupation_unresolved", {
        worker_id: UUID_B,
        reason: "gave_up",
        catalog_version: "cat_2026_08_01",
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("validates profile.parse_disagreement with field ids and counts", () => {
    const result = validateEvent(
      oieEvent("profile.parse_disagreement", {
        worker_id: UUID_B,
        field_ids: ["salary_expected", "experience_years"],
        disagreement_count: 2,
        agreement_count: 9,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects profile.parse_disagreement carrying either side's VALUE (.strict)", () => {
    // Both values are worker data: one is what they said, the other is what the model
    // claimed they said. Recording the disagreement is the point; recording the dispute's
    // contents would put the answer itself in the spine.
    for (const smuggled of [{ llm_values: ["18000"] }, { deterministic_values: ["15000"] }]) {
      const bad = validateEvent(
        oieEvent("profile.parse_disagreement", {
          worker_id: UUID_B,
          field_ids: ["salary_expected"],
          disagreement_count: 1,
          agreement_count: 0,
          ...smuggled,
        }),
      );
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error.stage).toBe("payload");
    }
  });

  it("rejects a field id outside the ^[a-z_]+$ RFS vocabulary", () => {
    // The same filter `slugFieldIds` applies before the flush transaction. Without it, a
    // "field id" that is really a snippet of worker prose sails straight into the payload.
    const bad = validateEvent(
      oieEvent("profile.parse_disagreement", {
        worker_id: UUID_B,
        field_ids: ["mera naam Ramesh hai"],
        disagreement_count: 1,
        agreement_count: 0,
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects occupation.phrase_unresolved carrying the phrase itself (.strict)", () => {
    const bad = validateEvent(
      oieEvent("occupation.phrase_unresolved", {
        phrase_hash: "a".repeat(64),
        lang: "hi",
        count: 3,
        phrase: "kharad ka kaam",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("accepts profile.interview_completed with a full latency histogram", () => {
    const ok = validateEvent(
      oieEvent("profile.interview_completed", {
        worker_id: UUID_B,
        session_id: UUID_A,
        turn_count: 14,
        ask_count: 12,
        completion_reason: "drained",
        occupation_pinned: true,
        match_layer: "l1_skeleton",
        pack_id: "qp_tailoring",
        pack_version: 2,
        answered_count: 9,
        declined_count: 2,
        unanswered_count: 1,
        turn_latency_ms: { le_100: 8, le_200: 3, le_400: 2, le_800: 1, gt_800: 0, max_ms: 612 },
      }),
    );
    expect(ok.success).toBe(true);
  });

  it("rejects profile.interview_completed carrying the worker's words (.strict)", () => {
    // THE FIELD A WELL-MEANING CHANGE WOULD MOST PLAUSIBLY ADD. "Which utterance did the
    // slowest turn come from" is a genuinely useful debugging question, and answering it here
    // would put raw worker text on the audit spine forever. The hash on
    // `occupation.phrase_unresolved` is where an utterance is allowed to go.
    const bad = validateEvent(
      oieEvent("profile.interview_completed", {
        worker_id: UUID_B,
        turn_count: 3,
        ask_count: 3,
        turn_latency_ms: { le_100: 3, le_200: 0, le_400: 0, le_800: 0, gt_800: 0, max_ms: 40 },
        slowest_turn_text: "silai ka kaam karta hoon",
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects a free-text completion_reason (no PII through the observability field)", () => {
    const bad = validateEvent(
      oieEvent("profile.interview_completed", {
        worker_id: UUID_B,
        turn_count: 3,
        ask_count: 3,
        completion_reason: "worker Ramesh gave up",
        turn_latency_ms: { le_100: 3, le_200: 0, le_400: 0, le_800: 0, gt_800: 0, max_ms: 40 },
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects profile.parse_gates_rejected carrying the field ids it threw away (.strict)", () => {
    // THE MOST TEMPTING ADDITION HERE, and the reason the payload is counts-only: "which field
    // failed provenance" is the first thing anyone debugging wants. But a value that failed
    // `provenance` or `pii` is unverified model output, and so is the field id attached to it.
    const bad = validateEvent(
      oieEvent("profile.parse_gates_rejected", {
        worker_id: UUID_B,
        rejected_count: 1,
        accepted_count: 4,
        by_gate: {
          provenance: 1,
          role: 0,
          type_range: 0,
          agreement: 0,
          vocabulary: 0,
          pii: 0,
        },
        rejected_field_ids: ["current_city"],
      }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects an unknown gate id — the six are a CLOSED set", () => {
    // A seventh gate arriving without a schema change would report into a key nothing reads,
    // and the wall would look narrower than it is.
    const bad = validateEvent(
      oieEvent("profile.parse_gates_rejected", {
        worker_id: UUID_B,
        rejected_count: 1,
        accepted_count: 0,
        by_gate: {
          provenance: 0,
          role: 0,
          type_range: 0,
          agreement: 0,
          vocabulary: 0,
          pii: 0,
          plausibility: 1,
        },
      }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects a negative latency bucket — a count cannot be negative", () => {
    const bad = validateEvent(
      oieEvent("profile.interview_completed", {
        worker_id: UUID_B,
        turn_count: 1,
        ask_count: 1,
        turn_latency_ms: { le_100: -1, le_200: 0, le_400: 0, le_800: 0, gt_800: 0, max_ms: 0 },
      }),
    );
    expect(bad.success).toBe(false);
  });
});

describe("profile.submission_duplicated (#931) — the countable half of a duplicate submit", () => {
  const UUID_A = "11111111-1111-4111-8111-111111111111";

  function dupEvent(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ...workerCreatedEvent(),
      event_name: "profile.submission_duplicated",
      actor: { actor_type: "worker", actor_id: UUID_A },
      subject: { subject_type: "chat_session", subject_id: UUID_B },
      payload,
    };
  }

  const DUPLICATE = {
    worker_id: UUID_A,
    session_id: UUID_B,
    question_key: "q_drawing",
    absorbed_as: "client_id",
    inbound_had_id: true,
    replays: 0,
    elapsed_ms: 1_200,
  };

  it("validates the id-matched duplicate", () => {
    const result = validateEvent(dupEvent(DUPLICATE));
    expect(result.success).toBe(true);
  });

  it("validates all four branches that can absorb a duplicate", () => {
    // The three clock branches are what #931 step 4 is gated on: the four reply-cache constants
    // may only be retired once they go to zero in the field.
    for (const absorbed_as of ["client_id", "budget", "storm", "stale"]) {
      const result = validateEvent(dupEvent({ ...DUPLICATE, absorbed_as, inbound_had_id: false }));
      expect(result.success).toBe(true);
    }
  });

  it("rejects a branch outside the closed set", () => {
    // A fifth reading arriving without a schema change would report into a value no dashboard
    // counts, and the rollout gate would read as met while a whole branch went unseen.
    expect(validateEvent(dupEvent({ ...DUPLICATE, absorbed_as: "probably" })).success).toBe(false);
  });

  it("accepts a null question_key — a close has none on screen", () => {
    const result = validateEvent(dupEvent({ ...DUPLICATE, question_key: null }));
    expect(result.success).toBe(true);
  });

  it("rejects a question_key that is not a pack slug", () => {
    // The `^[a-z_]+$` shape is what makes this field structurally incapable of carrying a
    // worker's words. A free-form key would make it the one place they could arrive.
    expect(validateEvent(dupEvent({ ...DUPLICATE, question_key: "Kya aap?" })).success).toBe(false);
  });

  it("rejects the worker's utterance riding along (.strict)", () => {
    // THE TEMPTING FIELD. "Which words were duplicated" is the first thing anyone debugging a
    // retry storm wants, and it is the one thing that must never reach the audit spine — the
    // words are in the transcript, which is where they belong.
    const bad = validateEvent(dupEvent({ ...DUPLICATE, text: "haan" }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.stage).toBe("payload");
  });

  it("rejects the raw submission id as a payload field", () => {
    // It is client-supplied and it is already persisted verbatim in `events.idempotency_key`.
    // A payload copy would be an unvalidated client string in the audit spine for no new fact.
    const bad = validateEvent(
      dupEvent({ ...DUPLICATE, submission_id: "3f8b2c1a-7d64-4e2f-9a51-0c9d5b7e4a12" }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects a negative elapsed_ms or replay count", () => {
    expect(validateEvent(dupEvent({ ...DUPLICATE, elapsed_ms: -1 })).success).toBe(false);
    expect(validateEvent(dupEvent({ ...DUPLICATE, replays: -1 })).success).toBe(false);
  });
});

describe("feedback.submitted (#997) — the SHAPE of a worker's feedback, never the words", () => {
  const base = {
    worker_id: UUID_A,
    feedback_id: UUID_B,
    category: "problem",
    message_length: 142,
    app_build: "abc1234",
  };
  const make = (payload: object) =>
    createEvent({
      event_name: "feedback.submitted",
      // The worker addressed us deliberately — this is not a sweep and not telemetry, so the
      // actor is the worker, and the subject is the same worker (the feedback is about us).
      actor: { actor_type: "worker", actor_id: UUID_A },
      subject: { subject_type: "worker", subject_id: UUID_A },
      source: "api",
      metadata: { environment: "test", service: "api" },
      payload: payload as never,
    });

  it("accepts the submitted shape — two ids, a tag, a length and a build", () => {
    expect(validateEvent(make(base)).success).toBe(true);
  });

  it("REJECTS the message text riding along (.strict)", () => {
    // THE ONE FIELD THIS EVENT EXISTS NOT TO CARRY. `message` is unbounded worker free text
    // and the worker is explicitly invited to say anything, so their own name and phone
    // number are a likely rather than an unlucky occurrence — and the events table is exactly
    // where §2 forbids raw PII from landing. The words live in `worker_feedback`, which is
    // the one table sanctioned to hold them.
    expect(() => make({ ...base, message: "mera naam Ramesh hai, 9876543210" })).toThrow(
      EventValidationException,
    );
    // ...and under any other name a well-meaning future field might use.
    expect(() => make({ ...base, message_text: "the app keeps logging me out" })).toThrow(
      EventValidationException,
    );
    expect(() => make({ ...base, message_excerpt: "the app keeps" })).toThrow(
      EventValidationException,
    );
  });

  it("carries NO field that could hold free text at all", () => {
    // The structural version of the test above, so it keeps holding for a field nobody has
    // thought of yet: every key in this payload is an id, a closed enum, a bounded count, a
    // charset-restricted build stamp, or a charset-restricted ROUTE PATTERN. If a plain
    // unbounded string ever appears here, the smuggling tests above stop being the last line of
    // defence and this one says so.
    const shape = FeedbackSubmittedPayload.shape;
    expect(Object.keys(shape).sort()).toEqual([
      "app_build",
      "category",
      "feedback_id",
      "message_length",
      "screen_context",
      "worker_id",
    ]);
    // `message_length` is the only field named after the message, and it is a number.
    expect(() => make({ ...base, message_length: "one hundred and forty-two" })).toThrow(
      EventValidationException,
    );
  });

  it("REJECTS any unknown key, not just the tempting ones (.strict)", () => {
    expect(() => make({ ...base, device_model: "Redmi 9A" })).toThrow(EventValidationException);
  });

  it("accepts a null category — 'did not tag' is not 'said other'", () => {
    // The shipped client omits the key entirely when the worker does not tag their feedback.
    // Coercing that to "other" here would put a lie in the histogram ops reads.
    expect(validateEvent(make({ ...base, category: null })).success).toBe(true);
  });

  it("accepts every tag the shipped app can send, and nothing else", () => {
    // The three tokens are frozen in the worker app; a fourth arriving without a schema change
    // would report into a value no dashboard counts.
    for (const category of WORKER_FEEDBACK_CATEGORIES) {
      expect(validateEvent(make({ ...base, category })).success).toBe(true);
    }
    expect(() => make({ ...base, category: "spam" })).toThrow(EventValidationException);
  });

  it("rejects a negative message length (a length is evidence; a negative one is a bug)", () => {
    expect(() => make({ ...base, message_length: -1 })).toThrow(EventValidationException);
    expect(() => make({ ...base, message_length: 1.5 })).toThrow(EventValidationException);
  });

  it("accepts the ROUTE PATTERN, and defaults an absent one to null", () => {
    // ADDITIVE WIDENING, STILL v1 (the `AgencyInviteCreatedPayload` precedent). The default is
    // what makes an event written before this field re-validate as `screen_context: null`
    // rather than as a missing key — so a consumer never has to tell "we did not know the
    // screen" from "this event predates the field".
    const withScreen = validateEvent(make({ ...base, screen_context: "/jobs/:id/apply" }));
    expect(withScreen.success).toBe(true);
    const without = validateEvent(make(base));
    expect(without.success).toBe(true);
    if (without.success && without.event.event_name === "feedback.submitted") {
      expect(without.event.payload.screen_context).toBeNull();
    }
    expect(validateEvent(make({ ...base, screen_context: null })).success).toBe(true);
  });

  it("REJECTS anything that is not a route pattern — a raw path cannot ride the spine", () => {
    // THE PROPERTY THAT MAKES THIS FIELD PERMISSIBLE AT ALL. A pattern says WHICH SCREEN; a
    // concrete path says which JOB, which SESSION, which application — an identifier linking
    // this row to one thing the worker was looking at, which is exactly what §2 keeps off the
    // events table. `sanitizeScreenContext` substitutes ids at the edge; this regex is what
    // makes the guarantee structural rather than a matter of the emitter behaving, and it is
    // the assertion that would catch a SECOND emitter added later without a normalizer.
    for (const bad of [
      "/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply", // a uuid
      "/orders/91723", // a numeric id
      "/search?q=welder mumbai", // a query string carrying worker input
      "jobs/apply", // unrooted
      "https://badabhai.ai/jobs", // a URL
      "/jobs/<script>", // markup
      "/jobs/my job", // whitespace
      "/नौकरी", // non-ASCII
      "", // empty
      `/${"a".repeat(WORKER_FEEDBACK_SCREEN_MAX)}`, // past the bound
      // ⚠ THE SHAPES THIS BACKSTOP USED TO WAVE THROUGH. It anchored both id arms to a whole
      // segment, so an id sharing its segment with one other character satisfied it — which
      // is exactly the second-emitter case the regex exists for, and it was measured passing.
      "/jobs/id-6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply", // a uuid behind a prefix
      "/jobs/6f2c04e04f8941d39a0c0305e82c3301/apply", // the dash-less uuid form
      "/w/9876543210-ravi", // a phone number and a name
      "/AADHAAR/1234-5678-9012", // a grouped 12-digit number
    ]) {
      expect(() => make({ ...base, screen_context: bad }), bad).toThrow(EventValidationException);
    }
  });

  it("still ACCEPTS the route patterns the normalizer actually produces", () => {
    // The other half of the arm above: a backstop tightened until it refuses real output would
    // turn every deep screen into "unknown screen" on the admin list, silently.
    for (const good of [
      "/jobs/:id/apply",
      "/jobs/id-:id/apply",
      "/workers/:id/sessions/:id",
      "/v2/jobs",
      "/worker_profile",
      "/settings/notifications",
      "/a.b/c",
      "/",
    ]) {
      expect(validateEvent(make({ ...base, screen_context: good })).success, good).toBe(true);
    }
  });

  it("accepts a null app_build, and rejects one past the header's bound", () => {
    // Absent or malformed build stamps are sanitized to null at the edge rather than rejecting
    // the submission — but an over-long one reaching here means that sanitizer was bypassed.
    expect(validateEvent(make({ ...base, app_build: null })).success).toBe(true);
    expect(() =>
      make({ ...base, app_build: "a".repeat(WORKER_FEEDBACK_APP_BUILD_MAX + 1) }),
    ).toThrow(EventValidationException);
  });
});
