import { describe, expect, it } from "vitest";
import { AcceptConsentSchema } from "./consent.dto";

/**
 * `POST /consent/accept` wire contract — the #2541 age answer is ADDITIVE.
 *
 * An app build that predates the question sends no `age_18_plus`, and must still parse (the
 * service, not the schema, decides whether a missing answer is allowed — that is the flag's job).
 * The answer itself is a real boolean: a string "true" is a malformed client, not a yes.
 */
const BASE = { consent_version: "2026-11-04", purposes: ["profiling", "resume_generation"] };

describe("AcceptConsentSchema — age_18_plus (#2541)", () => {
  it("parses a body with no answer (older app builds keep working)", () => {
    const res = AcceptConsentSchema.safeParse(BASE);
    expect(res.success).toBe(true);
    expect(res.success && res.data.age_18_plus).toBeUndefined();
  });

  it.each([true, false])("parses an explicit answer: %s", (answer) => {
    const res = AcceptConsentSchema.safeParse({ ...BASE, age_18_plus: answer });
    expect(res.success).toBe(true);
    expect(res.success && res.data.age_18_plus).toBe(answer);
  });

  it.each(["true", "yes", 1, 0, null])("refuses a non-boolean answer: %j", (answer) => {
    expect(AcceptConsentSchema.safeParse({ ...BASE, age_18_plus: answer }).success).toBe(false);
  });

  it("still strips a body worker_id (the XB-A rule is unchanged)", () => {
    const res = AcceptConsentSchema.safeParse({ ...BASE, age_18_plus: true, worker_id: "victim" });
    expect(res.success).toBe(true);
    expect(res.success && "worker_id" in res.data).toBe(false);
  });
});
