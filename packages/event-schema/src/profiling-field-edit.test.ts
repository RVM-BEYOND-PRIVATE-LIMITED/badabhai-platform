import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";

/**
 * The Haan/Nahi gate's three events (ADR-0057 §3.4, #2312) — one per row of a proposal.
 *
 * The contract under test: ids, a closed catalogue key, a closed op and (on a cancel) a closed
 * reason — `.strict()`, so the old value, the new one and the worker's words can never ride along.
 */
type EditEventName =
  | "profiling.field_edit_proposed"
  | "profiling.field_edit_confirmed"
  | "profiling.field_edit_cancelled";

function edit(name: EditEventName, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-10-16T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: WORKER },
    subject: { subject_type: "chat_session", subject_id: SESSION },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      worker_id: WORKER,
      session_id: SESSION,
      proposal_id: PROPOSAL,
      field_key: "experience_years",
      op: "edit",
      submission_id: null,
      ...(name === "profiling.field_edit_cancelled" ? { reason: "declined" } : {}),
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

const NAMES: readonly EditEventName[] = [
  "profiling.field_edit_proposed",
  "profiling.field_edit_confirmed",
  "profiling.field_edit_cancelled",
];

describe.each(NAMES)("%s", (name) => {
  it("is registered at v1 in the profile domain", () => {
    expect(isEventName(name)).toBe(true);
    expect(EVENT_REGISTRY[name].version).toBe(1);
    expect(EVENT_REGISTRY[name].domain).toBe("profile");
  });

  it("accepts a well-formed row, for both ops", () => {
    expect(validateEvent(edit(name)).success).toBe(true);
    expect(validateEvent(edit(name, { op: "delete", field_key: "skills" })).success).toBe(true);
  });

  it("refuses any key it does not declare — never a value", () => {
    expect(validateEvent(edit(name, { before: "5 saal" })).success).toBe(false);
    expect(validateEvent(edit(name, { after: "2 saal" })).success).toBe(false);
  });

  it("refuses an op outside the closed set", () => {
    expect(validateEvent(edit(name, { op: "add" })).success).toBe(false);
  });
});

describe("profiling.field_edit_cancelled", () => {
  it("says why, from a closed set", () => {
    for (const reason of ["declined", "lapsed", "stale", "profile_page"]) {
      expect(validateEvent(edit("profiling.field_edit_cancelled", { reason })).success).toBe(true);
    }
    expect(validateEvent(edit("profiling.field_edit_cancelled", { reason: "timeout" })).success).toBe(
      false,
    );
    const { reason: _reason, ...withoutReason } = edit("profiling.field_edit_cancelled")
      .payload as Record<string, unknown>;
    expect(
      validateEvent({ ...edit("profiling.field_edit_cancelled"), payload: withoutReason }).success,
    ).toBe(false);
  });
});
