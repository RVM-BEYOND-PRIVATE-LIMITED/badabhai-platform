import { describe, expect, it } from "vitest";

import {
  DEMO_PHONE_PATTERN,
  DEMO_PHONE_PREFIX,
  RESERVED_TEST_PHONE_PATTERN,
  isDemoWorkerPhone,
  parseAllowPhones,
} from "./demo-phones";

// The exact range the test-login seam accepts (SYNTHETIC_TEST_PHONE_PATTERN, apps/api/src/auth/auth.dto.ts).
const SYNTHETIC_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;

describe("demo phones — the shared demo-worker definition", () => {
  it("the reserved range matches the test-login seam's, and the demo block sits inside it", () => {
    expect(RESERVED_TEST_PHONE_PATTERN.source).toBe(SYNTHETIC_TEST_PHONE_PATTERN.source);
    for (const p of ["+910000026001", "+910000026999"]) {
      expect(p).toMatch(DEMO_PHONE_PATTERN);
      expect(p).toMatch(RESERVED_TEST_PHONE_PATTERN);
    }
    // E4 fixture and the smoke worker are reserved but NOT demo.
    for (const p of ["+910000019844", "+910000000000", "+9100000260011"]) {
      expect(p).not.toMatch(DEMO_PHONE_PATTERN);
    }
  });

  it("the prefix and the pattern agree (prefix + exactly 3 digits)", () => {
    expect(`${DEMO_PHONE_PREFIX}000`).toMatch(DEMO_PHONE_PATTERN);
    expect(`${DEMO_PHONE_PREFIX}0000`).not.toMatch(DEMO_PHONE_PATTERN);
  });

  it("parses the allow-list format: one E.164 per line, blanks and # comments ignored", () => {
    const set = parseAllowPhones(
      "# owner handsets\n+919876543210\n\n  +910000026101   # live welder\r\n",
    );
    expect([...set].sort()).toEqual(["+910000026101", "+919876543210"]);
  });

  it("a malformed allow-list fails closed, naming the line but not echoing it", () => {
    expect(() => parseAllowPhones("+919876543210\n98765 43210\n")).toThrow(/line 2/);
    expect(() => parseAllowPhones("98765 43210")).not.toThrow(/98765/);
  });

  it("isDemoWorkerPhone: demo block always, others only when allow-listed", () => {
    const allowed = parseAllowPhones("+919876543210");
    expect(isDemoWorkerPhone("+910000026005")).toBe(true);
    expect(isDemoWorkerPhone("+919876543210", allowed)).toBe(true);
    expect(isDemoWorkerPhone("+919876543210")).toBe(false);
    expect(isDemoWorkerPhone("+910000019844", allowed)).toBe(false);
  });
});
