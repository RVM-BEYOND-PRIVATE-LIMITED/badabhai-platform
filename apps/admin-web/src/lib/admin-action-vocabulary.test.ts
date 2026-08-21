import { describe, it, expect } from "vitest";
import {
  CREDIT_GRANT_REASONS,
  CREDIT_GRANT_REASON_LABELS,
  WORKER_FLAG_REASON_CODES,
  WORKER_FLAG_REASON_LABELS,
  ADMIN_CREDIT_GRANT_MAX,
} from "./admin-action-vocabulary";

/**
 * These lists render form choices, but they also mirror `apps/api`'s closed enums 1:1
 * (`ADMIN_CREDIT_GRANT_REASONS`, `WORKER_FLAG_REASON_CODES` in `admin-actions.dto.ts`). This
 * pins the literal values so a future edit to either side is a visible diff, not a silent
 * drift — see `capabilities.test.ts`'s "the vocabulary matches the server's ten capabilities"
 * for the same pattern.
 */
describe("credit grant reasons", () => {
  it("matches the server's closed enum exactly", () => {
    expect([...CREDIT_GRANT_REASONS].sort()).toEqual(
      ["goodwill", "correction", "promo", "support_resolution"].sort(),
    );
  });

  it("every reason has a label (a missing one renders `undefined` in the select)", () => {
    for (const code of CREDIT_GRANT_REASONS) {
      expect(CREDIT_GRANT_REASON_LABELS[code]).toBeTruthy();
    }
  });

  it("the grant cap matches the server's bound", () => {
    expect(ADMIN_CREDIT_GRANT_MAX).toBe(10_000);
  });
});

describe("worker flag reason codes", () => {
  it("matches the server's closed enum exactly", () => {
    expect([...WORKER_FLAG_REASON_CODES].sort()).toEqual(
      ["quality_review", "abuse_report", "duplicate", "other"].sort(),
    );
  });

  it("every code has a label", () => {
    for (const code of WORKER_FLAG_REASON_CODES) {
      expect(WORKER_FLAG_REASON_LABELS[code]).toBeTruthy();
    }
  });
});
