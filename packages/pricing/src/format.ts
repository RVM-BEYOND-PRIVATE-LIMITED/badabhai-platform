/**
 * PURE, dependency-free ₹ (rupee) formatting — the ONE source for rendering whole-rupee
 * amounts so no screen hand-builds a `₹${...}` string. The Design System calls out "₹ in
 * mono tabular" as a cross-app invariant; this is the shared implementation payer-web,
 * admin-web, and apps/web all point at (BL-10 — the same catalog previously rendered as
 * "₹2,000" in one app and "₹50000", ungrouped, in another).
 *
 * CONTRACT: integer rupees only (paise are never carried across these apps). A
 * non-integer or negative input is a programming error and is REJECTED by throwing a
 * `RangeError` — fail loud rather than silently render a misleading amount. Callers that
 * may hold an untrusted/optional number must validate (or use a band/"—" path) before
 * formatting.
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
