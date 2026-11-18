import { describe, expect, it } from "vitest";
import { getEventDefinition } from "./registry";

/**
 * #2752 item 10 — `worker.institute_search_granted` / `worker.institute_search_revoked` v1. Ids
 * only: no student reference, consent ref, Campus grant ref, course, name or phone.
 */
const VALID = {
  grant_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  worker_id: "1f0e0d0c-0b0a-4908-8706-050403020101",
  payer_id: "2f0e0d0c-0b0a-4908-8706-050403020102",
  institute_code: "rvm",
};

describe.each([["worker.institute_search_granted"], ["worker.institute_search_revoked"]] as const)(
  "%s v1",
  (name) => {
    const def = getEventDefinition(name);

    it("is registered at version 1 in the worker domain", () => {
      expect(def.version).toBe(1);
      expect(def.domain).toBe("worker");
    });

    it("accepts the ids-only payload", () => {
      expect(def.payload.safeParse(VALID).success).toBe(true);
    });

    it.each([["student_ref"], ["consent_ref"], ["grant_ref"], ["course"], ["phone_hash"]])(
      "refuses an extra %s key (strict)",
      (key) => {
        expect(def.payload.safeParse({ ...VALID, [key]: "x" }).success).toBe(false);
      },
    );
  },
);
