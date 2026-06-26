/**
 * PURE, dependency-free money formatting for the payer/agency portal.
 *
 * NO React, no render, no I/O, no Date.now / Math.random. This is the ONE source for
 * rendering whole-rupee amounts so no screen hand-builds a `₹${...}` string. The value
 * is meant to render inside a mono-tabular (`bb-mono`) element — this helper returns the
 * STRING only; callers keep the `bb-mono` class.
 *
 * CONTRACT: integer rupees only (we never carry paise in the portal). A non-integer or
 * negative input is a programming error and is REJECTED by throwing a `RangeError` —
 * fail loud rather than silently render a misleading amount. Callers that may hold an
 * untrusted/optional number must validate (or use a band/"—" path) before formatting.
 *
 *   formatInr(40)       === "₹40"
 *   formatInr(2000)     === "₹2,000"
 *   formatInr(0)        === "₹0"
 *   formatInr(1000000)  === "₹10,00,000"   // en-IN lakh grouping
 *   formatInr(40.5)     // throws RangeError
 *   formatInr(-1)       // throws RangeError
 */
export function formatInr(rupees: number): string {
  if (!Number.isInteger(rupees) || rupees < 0) {
    throw new RangeError(
      `formatInr expects a non-negative integer (whole rupees), got: ${rupees}`,
    );
  }
  // en-IN groups by lakh/crore (e.g. 10,00,000). No space after the ₹ symbol.
  return `₹${rupees.toLocaleString("en-IN")}`;
}
