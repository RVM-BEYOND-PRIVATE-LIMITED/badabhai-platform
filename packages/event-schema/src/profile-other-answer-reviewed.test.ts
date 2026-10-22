import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName } from "./index";

const WORKER = "11111111-1111-4111-8111-111111111111";

/**
 * `profile.other_answer_reviewed` (#2409) — a typed "Koi aur — khud likhein" answer's review
 * settled. Ids, the question key, a closed outcome and a count, `.strict()`: what the worker typed
 * and the names that print never ride along.
 */
const payload = EVENT_REGISTRY["profile.other_answer_reviewed"].payload;

const valid = {
  worker_id: WORKER,
  pack_id: "qp_cnc_turning",
  pack_version: 1,
  question_key: "turning_machine",
  outcome: "accepted",
  item_count: 1,
};

describe("profile.other_answer_reviewed", () => {
  it("is a registered v1 profile event", () => {
    expect(isEventName("profile.other_answer_reviewed")).toBe(true);
    expect(EVENT_REGISTRY["profile.other_answer_reviewed"]).toMatchObject({
      version: 1,
      domain: "profile",
    });
  });

  it("accepts an accepted and a rejected outcome", () => {
    expect(payload.safeParse(valid).success).toBe(true);
    expect(payload.safeParse({ ...valid, outcome: "rejected", item_count: 0 }).success).toBe(true);
  });

  it("refuses the typed text or the printed names riding along", () => {
    expect(payload.safeParse({ ...valid, text: "batliboi lath" }).success).toBe(false);
    expect(payload.safeParse({ ...valid, items: ["Batliboi lathe"] }).success).toBe(false);
  });

  it("refuses an outcome outside the closed set and a count above the cap", () => {
    expect(payload.safeParse({ ...valid, outcome: "unavailable" }).success).toBe(false);
    expect(payload.safeParse({ ...valid, item_count: 6 }).success).toBe(false);
  });
});
