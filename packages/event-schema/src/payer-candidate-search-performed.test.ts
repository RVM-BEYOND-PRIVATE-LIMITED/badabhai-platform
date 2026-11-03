import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PAYER = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `payer.candidate_search_performed` (owner rulings 2026-11-03; ADR-0040, phase E2).
 *
 * The contract under test: the SHAPE of one search page — closed role ids, which filters were
 * engaged (booleans, never values), strict, first page, the page size and the three counts —
 * `.strict()`, so a worker id or a city value can never ride along. Payer actor and subject.
 */
function searchEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_name: "payer.candidate_search_performed",
    event_version: 1,
    occurred_at: "2026-11-03T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: PAYER },
    subject: { subject_type: "payer", subject_id: PAYER },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      skill_ids: ["mskill_cnc_turner"],
      experience_filtered: true,
      industry_filtered: false,
      industry_experience_filtered: false,
      city_filtered: true,
      strict: false,
      first_page: true,
      result_count: 20,
      matched: 14,
      unrecorded: 3,
      total: 62,
      limit: 20,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payer.candidate_search_performed", () => {
  it("is registered at v1 in the payer domain", () => {
    expect(isEventName("payer.candidate_search_performed")).toBe(true);
    expect(EVENT_REGISTRY["payer.candidate_search_performed"].version).toBe(1);
    expect(EVENT_REGISTRY["payer.candidate_search_performed"].domain).toBe("payer");
  });

  it("accepts the shape of a search page", () => {
    expect(validateEvent(searchEvent()).success).toBe(true);
  });

  it("accepts an unfiltered first page with zero rows (an empty pool is a fact, not an error)", () => {
    const empty = searchEvent({
      skill_ids: [],
      experience_filtered: false,
      city_filtered: false,
      result_count: 0,
      matched: 0,
      unrecorded: 0,
      total: 0,
    });
    expect(validateEvent(empty).success).toBe(true);
  });

  it("refuses a worker id or a city value riding along (.strict())", () => {
    expect(validateEvent(searchEvent({ worker_id: WORKER })).success).toBe(false);
    expect(validateEvent(searchEvent({ worker_ids: [WORKER] })).success).toBe(false);
    expect(validateEvent(searchEvent({ city: "Pune" })).success).toBe(false);
  });

  it("refuses free text where a role id belongs", () => {
    expect(validateEvent(searchEvent({ skill_ids: ["CNC Turner"] })).success).toBe(false);
  });

  it("refuses negative counts and a zero page size", () => {
    expect(validateEvent(searchEvent({ total: -1 })).success).toBe(false);
    expect(validateEvent(searchEvent({ result_count: -1 })).success).toBe(false);
    expect(validateEvent(searchEvent({ limit: 0 })).success).toBe(false);
  });
});
