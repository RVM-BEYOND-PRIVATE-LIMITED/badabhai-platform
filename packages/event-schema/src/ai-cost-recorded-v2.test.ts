import { describe, expect, it } from "vitest";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

const BASE_PAYLOAD = {
  ai_call_id: UUID_A,
  ai_job_id: UUID_B,
  worker_id: UUID_C,
  session_id: UUID_D,
  task_type: "profiling_chat_turn",
  model: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  tokens_in: 897,
  tokens_out: 112,
  estimated_cost_inr: 0.157,
  latency_ms: 2863,
};

/**
 * B2 (#2555) — `ai.cost_recorded_v2`: v1's shape plus the spend-time test-account flag.
 *
 * The contract under test: every v1 row still validates as v2 (flag defaults to null,
 * which readers coalesce to the live join), and the flag position carries exactly one
 * boolean — never identity, never content, never a second meaning.
 */
function costV2Event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "ai.cost_recorded_v2",
    event_version: 2,
    occurred_at: "2026-08-18T05:04:02.270Z",
    actor: { actor_type: "ai_service", actor_id: null },
    subject: { subject_type: "ai_job", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: { ...BASE_PAYLOAD, ...over },
    metadata: { environment: "test", service: "api" },
  };
}

describe("ai.cost_recorded_v2", () => {
  it("is registered as a version-2 ai-domain event", () => {
    expect(isEventName("ai.cost_recorded_v2")).toBe(true);
    expect(EVENT_REGISTRY["ai.cost_recorded_v2"]).toMatchObject({ version: 2, domain: "ai" });
  });

  it("stamps true and false", () => {
    for (const is_test_account of [true, false]) {
      expect(validateEvent(costV2Event({ is_test_account })).success).toBe(true);
    }
  });

  it("defaults a missing flag to null — a v1-shape row stays valid", () => {
    const result = validateEvent(costV2Event());
    expect(result.success).toBe(true);
    if (result.success && result.event.event_name === "ai.cost_recorded_v2") {
      expect(result.event.payload.is_test_account).toBeNull();
    }
  });

  it("rejects the event under v1's version number — one version per name", () => {
    const result = validateEvent({ ...costV2Event(), event_version: 1 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });

  it("carries no identity and no content — one boolean beyond v1's keys", () => {
    const event = createEvent(costV2Event({ is_test_account: true }) as never);
    const payload = event.payload as Record<string, unknown>;
    const v1Keys = [
      "ai_call_id",
      "request_id",
      "ai_job_id",
      "worker_id",
      "session_id",
      "task_type",
      "model",
      "provider",
      "real_call",
      "tokens_in",
      "tokens_out",
      "estimated_cost_inr",
      "latency_ms",
      "cost_alert",
      "above_target",
      "success",
      "error_code",
      "failure_reason",
      "cache_write_tokens",
      "cache_read_tokens",
      "attempt_count",
      "candidates_tried",
    ];
    expect(Object.keys(payload).sort()).toEqual([...v1Keys, "is_test_account"].sort());
    expect(payload.is_test_account).toBe(true);
  });
});

describe("ai.cost_recorded v1 — left EXACTLY as it shipped (invariant #8)", () => {
  it("is still version 1 and strips a flag it was never taught — never rejects history", () => {
    const v1 = EVENT_REGISTRY["ai.cost_recorded"];
    expect(v1).toMatchObject({ version: 1, domain: "ai" });
    const parsed = v1.payload.safeParse({ ...BASE_PAYLOAD, is_test_account: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("is_test_account" in parsed.data).toBe(false);
    }
  });
});
