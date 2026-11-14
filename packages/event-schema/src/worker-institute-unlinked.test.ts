import { describe, expect, it } from "vitest";
import { getEventDefinition } from "./registry";

/**
 * #2752 part C — `worker.institute_unlinked` v1. Ids only, like `worker.institute_linked`: a
 * student's name, phone, phone hash, student reference, course and branch never ride an event.
 */
const def = getEventDefinition("worker.institute_unlinked");
const VALID = {
  worker_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  institute_code: "rvm",
  reason: "campus_request",
  worker_deleted: false,
};

describe("worker.institute_unlinked v1", () => {
  it("is registered at version 1 in the worker domain", () => {
    expect(def.version).toBe(1);
    expect(def.domain).toBe("worker");
  });

  it.each([["campus_request"], ["consent_not_confirmed"]])("accepts reason %s", (reason) => {
    expect(def.payload.safeParse({ ...VALID, reason }).success).toBe(true);
  });

  it("refuses a reason it does not know", () => {
    expect(def.payload.safeParse({ ...VALID, reason: "other" }).success).toBe(false);
  });

  it.each([["phone_hash"], ["student_ref"], ["course"], ["name"]])(
    "refuses an extra %s key (strict)",
    (key) => {
      expect(def.payload.safeParse({ ...VALID, [key]: "x" }).success).toBe(false);
    },
  );
});
