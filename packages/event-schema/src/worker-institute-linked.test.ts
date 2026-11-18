import { describe, expect, it } from "vitest";
import { getEventDefinition } from "./registry";

/**
 * #2752 — `worker.institute_linked` v1. Ids only: a linked student's name, phone, phone hash,
 * student reference, course and branch never ride an event.
 */
const def = getEventDefinition("worker.institute_linked");
const VALID = {
  worker_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  institute_code: "rvm",
  worker_created: true,
};

describe("worker.institute_linked v1", () => {
  it("is registered at version 1 in the worker domain", () => {
    expect(def.version).toBe(1);
    expect(def.domain).toBe("worker");
  });

  it("accepts the ids-only payload", () => {
    expect(def.payload.safeParse(VALID).success).toBe(true);
  });

  it.each([["phone_hash"], ["student_ref"], ["course"], ["name"]])(
    "refuses an extra %s key (strict)",
    (key) => {
      expect(def.payload.safeParse({ ...VALID, [key]: "x" }).success).toBe(false);
    },
  );

  it("refuses an institute it does not know", () => {
    expect(def.payload.safeParse({ ...VALID, institute_code: "other" }).success).toBe(false);
  });
});
