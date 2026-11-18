import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `job_posting.posting_choice_recorded` (#2751 items 1 to 3). The posting id and two closed codes,
 * `.strict()`: no button label, price, pack or company detail can ride along.
 */
function recorded(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "job_posting.posting_choice_recorded",
    event_version: 1,
    occurred_at: "2026-11-18T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: UUID_B },
    subject: { subject_type: "job_posting", subject_id: UUID_C },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const valid = { job_posting_id: UUID_C, choice: "free_plus_pack", surface: "web" };

describe("job_posting.posting_choice_recorded", () => {
  it("is a registered v1 job_posting event", () => {
    expect(isEventName("job_posting.posting_choice_recorded")).toBe(true);
    expect(EVENT_REGISTRY["job_posting.posting_choice_recorded"]).toMatchObject({
      version: 1,
      domain: "job_posting",
    });
  });

  it("accepts every choice on every surface", () => {
    for (const choice of ["free", "free_plus_pack"]) {
      for (const surface of ["web", "app"]) {
        expect(validateEvent(recorded({ ...valid, choice, surface })).success).toBe(true);
      }
    }
  });

  it("refuses an unknown choice or surface", () => {
    expect(validateEvent(recorded({ ...valid, choice: "paid" })).success).toBe(false);
    expect(validateEvent(recorded({ ...valid, surface: "android" })).success).toBe(false);
  });

  it("refuses a missing field and any extra field (no label, price or pack)", () => {
    expect(validateEvent(recorded({ choice: "free", surface: "web" })).success).toBe(false);
    expect(validateEvent(recorded({ ...valid, label: "Post free" })).success).toBe(false);
    expect(validateEvent(recorded({ ...valid, pack_code: "pack_starter" })).success).toBe(false);
    expect(validateEvent(recorded({ ...valid, price_inr: 999 })).success).toBe(false);
  });
});
