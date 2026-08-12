import { describe, expect, it } from "vitest";
import { distributeOtpDigits } from "./otp-input";

/**
 * OTP entry — the paste / autofill contract.
 *
 * The regression this locks: the cell handler used to keep `v[v.length - 1]`, a SINGLE
 * character. Pasting the six-digit code out of the login email put one digit in one cell
 * and dropped the rest, so the most common interaction on the screen — copy the code,
 * paste it — silently failed and the code had to be retyped by hand.
 *
 * `maxLength={1}` means the browser truncates a paste before onChange ever sees it, so the
 * component intercepts onPaste; both that path and the browser's one-time-code autofill
 * funnel through the function under test here.
 */
describe("distributeOtpDigits — a whole code lands across the cells", () => {
  it("spreads a pasted 6-digit code from the first cell (the regression)", () => {
    const out = distributeOtpDigits("", 6, 0, "123456");
    expect(out.value).toBe("123456");
    // Caret parks on the last cell once the code is complete.
    expect(out.caret).toBe(5);
  });

  it("a single keystroke still writes one cell and advances", () => {
    const out = distributeOtpDigits("", 6, 0, "7");
    expect(out.value).toBe("7");
    expect(out.caret).toBe(1);
  });

  it("strips separators, so a code copied as '123 456' still fills", () => {
    expect(distributeOtpDigits("", 6, 0, "123 456").value).toBe("123456");
    expect(distributeOtpDigits("", 6, 0, "123-456").value).toBe("123456");
  });

  it("pasting into a later cell fills from THAT cell, not from the start", () => {
    const out = distributeOtpDigits("12", 6, 2, "3456");
    expect(out.value).toBe("123456");
    expect(out.caret).toBe(5);
  });

  it("overwrites the digits it covers and leaves the rest alone", () => {
    const out = distributeOtpDigits("999999", 6, 0, "12");
    expect(out.value).toBe("129999");
    expect(out.caret).toBe(2);
  });

  it("truncates an over-long paste instead of wrapping it", () => {
    // A code longer than the field is a paste of something that is not this code; filling
    // from the end would hide that rather than surface it.
    const out = distributeOtpDigits("", 4, 0, "123456");
    expect(out.value).toBe("1234");
    expect(out.caret).toBe(3);
  });

  it("a paste with no digits in it is a no-op", () => {
    const out = distributeOtpDigits("12", 6, 2, "hello");
    expect(out.value).toBe("12");
    expect(out.caret).toBe(2);
  });

  it("never returns more cells than the field has", () => {
    for (const from of [0, 3, 5]) {
      expect(distributeOtpDigits("", 6, from, "123456").value.length).toBeLessThanOrEqual(6);
    }
  });
});
