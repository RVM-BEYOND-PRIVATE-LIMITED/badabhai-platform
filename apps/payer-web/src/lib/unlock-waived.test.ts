import { describe, expect, it } from "vitest";
import { openButtonLabel, quotedWaived, retryOpenButtonLabel } from "./unlock-quotes";

describe("#2750 part C — a waived open", () => {
  it("names the placement-team waiver, never a price", () => {
    expect(openButtonLabel(0, true)).toBe("Free: RVM placement team");
    expect(retryOpenButtonLabel(0, true)).toBe("Free: RVM placement team — retry");
  });

  it("reads the waived marker only from the quote", () => {
    expect(quotedWaived({ quotes: { w: 0 }, creditsAvailable: 3, waived: { w: true } }, "w")).toBe(true);
    expect(quotedWaived({ quotes: { w: 0 }, creditsAvailable: 3 }, "w")).toBe(false);
  });
});
