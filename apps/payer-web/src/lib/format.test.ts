import { describe, expect, it } from "vitest";
import { formatInr } from "./format";

// Full behavioral coverage lives in @badabhai/pricing's format.test.ts (BL-10). This just
// confirms the re-export is wired to the same implementation payer-web screens import.
describe("formatInr re-export", () => {
  it("delegates to the shared @badabhai/pricing formatter", () => {
    expect(formatInr(2000)).toBe("₹2,000");
    expect(() => formatInr(-1)).toThrow(RangeError);
  });
});
