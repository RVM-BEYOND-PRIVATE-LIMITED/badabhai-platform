import { describe, expect, it } from "vitest";

import { APPLICANT_POSTING_KINDS, HIRE_RECORD_SOURCES, HIRE_STATUSES } from "@badabhai/types";

import { EVENT_DOMAINS } from "./enums";
import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const HIRE = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const POSTING = "33333333-3333-4333-8333-333333333333";
const PAYER = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `hire.recorded` (#2753 item 9). The contract under test: the record, the worker, the posting,
 * the status and the source, `.strict()`, every value from a closed set, and a status that is the
 * one its source leaves the record in.
 */
function recordedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: HIRE,
    event_name: "hire.recorded",
    event_version: 1,
    occurred_at: "2026-11-16T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: PAYER },
    subject: { subject_type: "worker", subject_id: WORKER },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      hire_id: HIRE,
      worker_id: WORKER,
      posting_kind: "company_posting",
      posting_id: POSTING,
      status: "confirmed",
      source: "company_mark",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

/** The one status each source may leave the record in (the worker's answer: two). */
const ALLOWED: Record<string, readonly string[]> = {
  company_mark: ["confirmed"],
  company_unmark: ["rejected"],
  company_answer: ["confirmed"],
  worker_answer: ["reported", "confirmed"],
  desk_confirm: ["confirmed"],
  desk_reject: ["rejected"],
};

describe("hire.recorded", () => {
  it("is registered as a version-1 event in its own hire domain", () => {
    expect(isEventName("hire.recorded")).toBe(true);
    expect(EVENT_DOMAINS).toContain("hire");
    expect(EVENT_REGISTRY["hire.recorded"]).toMatchObject({ version: 1, domain: "hire" });
  });

  it("validates every source with the status it leaves, for both posting kinds", () => {
    let validated = 0;
    for (const posting_kind of APPLICANT_POSTING_KINDS) {
      for (const source of HIRE_RECORD_SOURCES) {
        for (const status of ALLOWED[source]!) {
          const parsed = recordedEvent({ posting_kind, source, status });
          expect(validateEvent(parsed).success, `${source}/${status}`).toBe(true);
          expect(createEvent(parsed as never).payload).toEqual({
            hire_id: HIRE,
            worker_id: WORKER,
            posting_kind,
            posting_id: POSTING,
            status,
            source,
          });
          validated += 1;
        }
      }
    }
    // 7 (source, status) pairs per posting kind.
    expect(validated).toBe(14);
  });

  it("refuses a status its source cannot leave", () => {
    let refused = 0;
    for (const source of HIRE_RECORD_SOURCES) {
      for (const status of HIRE_STATUSES) {
        if (ALLOWED[source]!.includes(status)) continue;
        const result = validateEvent(recordedEvent({ source, status }));
        expect(result.success, `${source}/${status}`).toBe(false);
        if (!result.success) expect(result.error.stage).toBe("payload");
        refused += 1;
      }
    }
    // 18 pairs, 7 allowed.
    expect(refused).toBe(11);
  });

  it("pins the payload SHAPE: ids and two closed values, nothing else", () => {
    const shape = (
      EVENT_REGISTRY["hire.recorded"].payload as unknown as {
        shape: Record<string, { options?: readonly unknown[] }>;
      }
    ).shape;
    expect(Object.keys(shape).sort()).toEqual([
      "hire_id",
      "posting_id",
      "posting_kind",
      "source",
      "status",
      "worker_id",
    ]);
    expect(shape.status!.options).toEqual([...HIRE_STATUSES]);
    expect(shape.source!.options).toEqual([...HIRE_RECORD_SOURCES]);
    expect(shape.posting_kind!.options).toEqual([...APPLICANT_POSTING_KINDS]);
    expect([...HIRE_STATUSES]).toEqual(["reported", "confirmed", "rejected"]);
  });

  it("is STRICT: a name, a phone, a tenant, a date or a note cannot ride along", () => {
    for (const smuggled of [
      "full_name",
      "phone",
      "payer_id",
      "tenant_payer_id",
      "hired_on",
      "note",
      "org_name",
    ]) {
      const result = validateEvent(recordedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a value outside the closed sets, and a non-uuid id", () => {
    for (const over of [
      { status: "hired" },
      { status: "Confirmed" },
      { source: "company" },
      { source: "desk" },
      { posting_kind: "job" },
      { hire_id: "not-a-uuid" },
      { worker_id: null },
    ]) {
      expect(validateEvent(recordedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });

  it("rejects the event under any version but 1", () => {
    const result = validateEvent({ ...recordedEvent(), event_version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});
