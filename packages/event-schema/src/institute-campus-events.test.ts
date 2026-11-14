import { describe, expect, it } from "vitest";
import { getEventDefinition } from "./registry";

/**
 * #2752 part E — the Campus application pair and the Campus-created company. Ids only: no
 * student reference, Campus application id, staff reference, name or phone.
 */
const APPLICATION = {
  institute_application_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  application_id: "1f0e0d0c-0b0a-4908-8706-050403020101",
  worker_id: "2f0e0d0c-0b0a-4908-8706-050403020102",
  job_posting_id: "3f0e0d0c-0b0a-4908-8706-050403020103",
  institute_code: "rvm",
};

describe.each([["worker.institute_applied"], ["worker.institute_application_withdrawn"]] as const)(
  "%s v1",
  (name) => {
    const def = getEventDefinition(name);

    it("is registered at version 1 in the worker domain", () => {
      expect(def.version).toBe(1);
      expect(def.domain).toBe("worker");
    });

    it("accepts the ids-only payload", () => {
      expect(def.payload.safeParse(APPLICATION).success).toBe(true);
    });

    it.each([["student_ref"], ["external_ref"], ["name"], ["phone_hash"]])(
      "refuses an extra %s key (strict)",
      (key) => {
        expect(def.payload.safeParse({ ...APPLICATION, [key]: "x" }).success).toBe(false);
      },
    );
  },
);

describe("payer.institute_company_created v1", () => {
  const def = getEventDefinition("payer.institute_company_created");
  const VALID = { payer_id: APPLICATION.worker_id, institute_code: "rvm" };

  it("is registered at version 1 in the payer domain, ids only", () => {
    expect(def.version).toBe(1);
    expect(def.domain).toBe("payer");
    expect(def.payload.safeParse(VALID).success).toBe(true);
  });

  it.each([["staff_ref"], ["org_name"], ["phone"]])("refuses an extra %s key", (key) => {
    expect(def.payload.safeParse({ ...VALID, [key]: "x" }).success).toBe(false);
  });
});
