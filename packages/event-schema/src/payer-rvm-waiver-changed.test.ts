import { describe, expect, it } from "vitest";

import {
  createEvent,
  EVENT_REGISTRY,
  isEventName,
  RVM_WAIVER_SCOPES,
  RVM_WAIVER_SOURCES,
  validateEvent,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";

const NAMES = ["payer.rvm_waiver_set", "payer.rvm_waiver_cleared"] as const;

/**
 * `payer.rvm_waiver_set` / `payer.rvm_waiver_cleared` (#2750 item 5). The contract under test:
 * the waiver, the company's tenant key, the closed scope and source, and a posting id exactly for a
 * job waiver, `.strict()` — ids and codes only, so no staff name or reason text can ride along.
 */
function waiverEvent(
  name: (typeof NAMES)[number],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      waiver_id: UUID_C,
      payer_id: UUID_B,
      scope: "company",
      job_posting_id: null,
      source: "campus",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe.each(NAMES.map((n) => [n]))("%s", (name) => {
  it("is registered as a version-1 event in the payer domain", () => {
    expect(isEventName(name)).toBe(true);
    expect(EVENT_REGISTRY[name]).toMatchObject({ version: 1, domain: "payer" });
  });

  it("accepts a company waiver and a job waiver, from either source", () => {
    for (const source of RVM_WAIVER_SOURCES) {
      expect(validateEvent(waiverEvent(name, { source })).success).toBe(true);
      expect(
        validateEvent(waiverEvent(name, { source, scope: "job", job_posting_id: UUID_E })).success,
      ).toBe(true);
    }
  });

  it.each([
    ["a job waiver with no posting", { scope: "job", job_posting_id: null }],
    ["a company waiver naming a posting", { scope: "company", job_posting_id: UUID_E }],
    ["an unknown scope", { scope: "branch" }],
    ["an unknown source", { source: "ops" }],
    ["a non-uuid waiver", { waiver_id: "w-1" }],
    ["a staff name riding along", { set_by_label: "Asha Kumar" }],
    ["a reason riding along", { reason: "drive at Pune campus" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(waiverEvent(name, over)).success).toBe(false);
  });

  it("createEvent keeps the payload whole, and the shape is pinned", () => {
    expect(createEvent(waiverEvent(name) as never).payload).toEqual({
      waiver_id: UUID_C,
      payer_id: UUID_B,
      scope: "company",
      job_posting_id: null,
      source: "campus",
    });
    expect(Object.keys(EVENT_REGISTRY[name].payload.shape).sort()).toEqual([
      "job_posting_id",
      "payer_id",
      "scope",
      "source",
      "waiver_id",
    ]);
  });
});

it("the scopes and sources are the closed sets the table's CHECKs hold", () => {
  expect([...RVM_WAIVER_SCOPES]).toEqual(["company", "job"]);
  expect([...RVM_WAIVER_SOURCES]).toEqual(["campus", "admin"]);
});
