import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PAYER_DEMO_ID_PREFIX,
  WORKFORCE_ID_PREFIX,
  isSampleWorkerId,
  payerDemoIdLikePattern,
  payerDemoUuid,
  workforceIdLikePattern,
  workforceUuid,
} from "./sample-workers";

/**
 * R74 — the API badges and refuses to unlock a worker because of WHICH id he has, so the test that
 * matters is that the predicate agrees with the ids the seed actually mints, and with nothing else.
 */
describe("sample-workers — the synthetic-workforce id namespace", () => {
  it("every worker id the seed can mint is a sample", () => {
    for (const i of [0, 1, 7, 249, 250, 999, 0xffff]) {
      expect(isSampleWorkerId(workforceUuid("worker", i)), String(i)).toBe(true);
    }
    expect(isSampleWorkerId(workforceUuid("worker", 3).toUpperCase())).toBe(true);
  });

  it("the seed's other kinds (payer, profile, consent, posting) are not sample WORKERS", () => {
    for (const kind of ["payer", "profile", "consent", "posting"] as const) {
      expect(isSampleWorkerId(workforceUuid(kind, 1)), kind).toBe(false);
    }
  });

  it("a real (random v4) worker id is never a sample", () => {
    for (let i = 0; i < 2000; i += 1) expect(isSampleWorkerId(randomUUID())).toBe(false);
  });

  it("rejects near-misses: a longer id, a prefix only, other seeds' namespaces", () => {
    const id = workforceUuid("worker", 5);
    expect(isSampleWorkerId(`${id}0`)).toBe(false);
    expect(isSampleWorkerId(`x${id}`)).toBe(false);
    expect(isSampleWorkerId("face2000-0000-4000-8000-")).toBe(false);
    expect(isSampleWorkerId("de302000-0000-4000-8000-000000000001")).toBe(false);
    expect(isSampleWorkerId("")).toBe(false);
  });

  it("keeps the namespace production holds, and the SQL pattern matches the same ids", () => {
    expect(workforceUuid("worker", 0)).toBe("face2000-0000-4000-8000-000000000000");
    expect(workforceIdLikePattern("worker")).toBe("face2000-0000-4000-8000-%");
  });
});

describe("sample-workers — the payer-demo id namespace (#2651)", () => {
  it("every worker id the payer-demo seed can mint is a sample", () => {
    for (const i of [0, 1, 29, 479, 480, 0xffff]) {
      expect(isSampleWorkerId(payerDemoUuid("worker", i)), String(i)).toBe(true);
    }
    expect(isSampleWorkerId(payerDemoUuid("worker", 3).toUpperCase())).toBe(true);
  });

  it("its profile and consent ids are not sample WORKERS", () => {
    for (const kind of ["profile", "consent"] as const) {
      expect(isSampleWorkerId(payerDemoUuid(kind, 1)), kind).toBe(false);
    }
  });

  it("keeps the namespace production holds, and the SQL pattern matches the same ids", () => {
    expect(payerDemoUuid("worker", 0)).toBe("be162000-0000-4000-8000-000000000000");
    expect(payerDemoIdLikePattern("worker")).toBe("be162000-0000-4000-8000-%");
  });

  it("the two cohorts never share an id", () => {
    expect(PAYER_DEMO_ID_PREFIX).not.toBe(WORKFORCE_ID_PREFIX);
    expect(payerDemoUuid("worker", 7)).not.toBe(workforceUuid("worker", 7));
  });
});
