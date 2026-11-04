import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CREDIT_GRANT_REASONS,
  CREDIT_GRANT_REASON_LABELS,
  WORKER_FLAG_REASON_CODES,
  WORKER_FLAG_REASON_LABELS,
  PII_REVEAL_REASON_CODES,
  PII_REVEAL_REASON_LABELS,
  ADMIN_CREDIT_GRANT_MAX,
  ADMIN_ACTION_CODE_LABELS,
  adminActionLabel,
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

describe("phone reveal reason codes (A7, #2577)", () => {
  it("matches the server's closed enum exactly — read from admin-pii-reveal.dto.ts itself", () => {
    // The API source is in this repo, so the drift test reads it rather than a second literal.
    const dto = readFileSync(
      new URL("../../../api/src/admin/admin-pii-reveal.dto.ts", import.meta.url),
      "utf8",
    );
    const declared = /ADMIN_PII_REVEAL_REASONS = \[([^\]]*)\]/.exec(dto)?.[1] ?? "";
    const codes = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(0);
    expect([...PII_REVEAL_REASON_CODES]).toEqual(codes);
  });

  it("every code has a label", () => {
    for (const code of PII_REVEAL_REASON_CODES) {
      expect(PII_REVEAL_REASON_LABELS[code]).toBeTruthy();
    }
  });
});

describe("admin.action_performed action codes", () => {
  it("names ADR-0060's six new codes", () => {
    for (const code of [
      "admin_created",
      "admin_password_set",
      "admin_password_reset",
      "admin_device_trusted",
      "admin_mfa_enabled",
      "admin_mfa_disabled",
    ]) {
      expect(ADMIN_ACTION_CODE_LABELS[code], code).toBeTruthy();
      expect(adminActionLabel(code)).not.toBe(code);
    }
  });

  it("still names the codes that predate it", () => {
    for (const code of ["admin_invited", "admin_suspended", "admin_mfa_reset", "credits_granted"]) {
      expect(adminActionLabel(code)).not.toBe(code);
    }
  });

  it("falls back to the skill-decision sentences, then to the raw code", () => {
    expect(adminActionLabel("skill_candidate_rejected")).toBe("Rejected");
    expect(adminActionLabel("some_future_code")).toBe("some_future_code");
    // An inherited key is not a label.
    expect(adminActionLabel("toString")).toBe("toString");
  });
});
