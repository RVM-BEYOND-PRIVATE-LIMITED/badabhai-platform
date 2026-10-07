import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { APPLICANT_POSTING_KINDS, APPLICANT_STAGES } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PAYER = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const POSTING = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `payer.applicant_stage_changed` (owner ruling 2026-10-07 — the payer pipeline board saved
 * server-side, migration 0134).
 *
 * The contract under test: the posting kind + id, the worker id and two closed stages, `.strict()`;
 * a real change only (`stage` ≠ `previous_stage`); `previous_stage` never null (an applicant nobody
 * moved is `new`). Payer actor, worker subject.
 */
function stageChangedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_name: "payer.applicant_stage_changed",
    event_version: 1,
    occurred_at: "2026-10-07T10:00:00.000Z",
    actor: { actor_type: "payer", actor_id: PAYER },
    subject: { subject_type: "worker", subject_id: WORKER },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      posting_kind: "company_posting",
      posting_id: POSTING,
      worker_id: WORKER,
      stage: "shortlist",
      previous_stage: "new",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

/** The object schema under the refine, so its keys and enums can be pinned. */
const SHAPE = (
  EVENT_REGISTRY["payer.applicant_stage_changed"].payload as unknown as z.ZodEffects<z.AnyZodObject>
).innerType().shape as Record<string, z.ZodEnum<[string, ...string[]]>>;

describe("payer.applicant_stage_changed", () => {
  it("is registered as a version-1 payer-domain event", () => {
    expect(isEventName("payer.applicant_stage_changed")).toBe(true);
    expect(EVENT_REGISTRY["payer.applicant_stage_changed"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("validates every real transition, for both posting kinds", () => {
    let validated = 0;
    for (const posting_kind of APPLICANT_POSTING_KINDS) {
      for (const stage of APPLICANT_STAGES) {
        for (const previous_stage of APPLICANT_STAGES) {
          if (stage === previous_stage) continue;
          const payload = { posting_kind, stage, previous_stage };
          const parsed = stageChangedEvent(payload);
          expect(validateEvent(parsed).success, JSON.stringify(payload)).toBe(true);
          expect(createEvent(parsed as never).payload).toEqual({
            posting_id: POSTING,
            worker_id: WORKER,
            ...payload,
          });
          validated += 1;
        }
      }
    }
    expect(validated).toBe(12); // 2 kinds × 6 ordered pairs — not vacuous
  });

  it("refuses a non-change — an unchanged stage is never an event", () => {
    for (const stage of APPLICANT_STAGES) {
      const result = validateEvent(stageChangedEvent({ stage, previous_stage: stage }));
      expect(result.success, stage).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("pins the payload SHAPE — the posting, the worker and the two stages, nothing else", () => {
    expect(Object.keys(SHAPE).sort()).toEqual([
      "posting_id",
      "posting_kind",
      "previous_stage",
      "stage",
      "worker_id",
    ]);
    expect(SHAPE.posting_kind!.options).toEqual([...APPLICANT_POSTING_KINDS]);
    expect(SHAPE.stage!.options).toEqual([...APPLICANT_STAGES]);
    expect(SHAPE.previous_stage!.options).toEqual([...APPLICANT_STAGES]);
    expect(SHAPE.stage!.options).toEqual(["new", "shortlist", "passed"]);
  });

  it("is STRICT — a payer id, a title, a note or any value cannot ride along", () => {
    for (const smuggled of [
      "payer_id",
      "updated_by_payer_id",
      "posting_title",
      "role_title",
      "note",
      "full_name",
      "phone",
      "rank",
    ]) {
      const result = validateEvent(stageChangedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects a stage or posting kind outside the closed vocabularies", () => {
    for (const bad of [
      { stage: "contacted" },
      { stage: "Shortlist" },
      { stage: "" },
      { previous_stage: "hired" },
      { previous_stage: null },
      { posting_kind: "job" },
      { posting_kind: "posting" },
      { posting_kind: null },
    ]) {
      const result = validateEvent(stageChangedEvent(bad));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("requires every field, and uuids for the posting and the worker", () => {
    for (const bad of [
      { stage: undefined },
      { previous_stage: undefined },
      { posting_kind: undefined },
      { posting_id: undefined },
      { worker_id: undefined },
      { posting_id: "not-a-uuid" },
      { worker_id: "not-a-uuid" },
    ]) {
      const result = validateEvent(stageChangedEvent(bad));
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("rejects the event under any version but 1", () => {
    const result = validateEvent({ ...stageChangedEvent(), event_version: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("version");
  });
});
