import { describe, expect, it } from "vitest";

import { formatWorkerPhone } from "./resume-phone";

/**
 * R10 §2.4. The gap this closes was invisible to every existing test because every FIXTURE in the
 * repo carried the grouped form by hand — so the sheets nine packets were reviewed against showed
 * a formatting production could not produce.
 */
describe("formatWorkerPhone", () => {
  it("groups the stored E.164 the way the ratified sheet prints it", () => {
    expect(formatWorkerPhone("+919876543210")).toBe("+91 98765 43210");
  });

  it("accepts a bare ten-digit mobile, which is how a worker types it", () => {
    expect(formatWorkerPhone("9876543210")).toBe("+91 98765 43210");
  });

  it("normalises separators rather than preserving whatever was stored", () => {
    for (const stored of ["+91-98765-43210", "+91 9876543210", " +91 98765 43210 "]) {
      expect(formatWorkerPhone(stored), stored).toBe("+91 98765 43210");
    }
  });

  it("PASSES THROUGH anything it does not recognise, never dropping the digits", () => {
    // A résumé without a reachable number is useless, so the failure mode is "unformatted",
    // never "absent" — the same degrade the decrypt path takes one layer up.
    expect(formatWorkerPhone("+971 50 123 4567")).toBe("+971 50 123 4567");
    expect(formatWorkerPhone("0129 2234567")).toBe("0129 2234567");
  });

  it("does not group a number that only LOOKS like an Indian mobile", () => {
    // An Indian mobile never starts below 6. A 12-digit landline or a double-prefix must not be
    // re-grouped into a shape that reads as a mobile.
    expect(formatWorkerPhone("915412345678")).toBe("915412345678");
    expect(formatWorkerPhone("1234567890")).toBe("1234567890");
  });

  it("keeps null and empty as absence", () => {
    expect(formatWorkerPhone(null)).toBeNull();
    expect(formatWorkerPhone(undefined)).toBeNull();
    expect(formatWorkerPhone("   ")).toBeNull();
  });
});
