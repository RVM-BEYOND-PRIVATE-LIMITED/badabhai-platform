/**
 * Subtle "cached pricing" disclosure (context-drift D-6).
 *
 * Rendered by a pricing page ONLY when the live-catalog fetch failed and the page is
 * showing the compile-time `DEFAULT_CATALOG` fallback (`lib/live-catalog.ts`,
 * live:false) — never a blank page. Failing OPEN to the cached display is safe: the
 * server re-resolves the real price through the pricing engine at every charge (XT5),
 * so the note is honesty copy, not a warning banner. Hookless + presentational
 * (server-component safe); tokens-only styling via `.cached-pricing-note`.
 */
export function CachedPricingNote() {
  return (
    <p className="cached-pricing-note" role="note">
      Showing cached pricing — we couldn&rsquo;t refresh the live price list just now. The exact
      amount is always confirmed at purchase.
    </p>
  );
}
