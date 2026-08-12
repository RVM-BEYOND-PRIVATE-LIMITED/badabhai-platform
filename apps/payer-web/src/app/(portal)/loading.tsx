/**
 * Neutral route-level loading skeleton for the authed portal shell (ADR-0019 Phase 1).
 *
 * Shown while a (portal) page's server work is in flight. It renders NO data and NO
 * PII — just shape placeholders — so a slow or unavailable backend never blanks the
 * screen or leaks anything. A Server Component (no client state needed).
 *
 * UI-1: the placeholders now sit in the REAL portal frame — `.page-head` → `.stat-row` →
 * `.panel` — which is the shape every (portal) screen resolves into (see dashboard/page.tsx).
 * A skeleton laid out differently from its content is worse than no skeleton at all: the page
 * visibly re-flows the moment the read lands. Sizes come from `.skeleton--title/--row/--tile`,
 * so nothing here hardcodes a dimension.
 */
export default function PortalLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="page-head">
        <div className="page-head__text">
          <div className="skeleton skeleton--title" />
        </div>
      </div>

      {/* The KPI row every portal screen opens with. */}
      <div className="stat-row">
        <div className="skeleton skeleton--tile" />
        <div className="skeleton skeleton--tile" />
        <div className="skeleton skeleton--tile" />
        <div className="skeleton skeleton--tile" />
      </div>

      {/* …then the first list/table panel. */}
      <section className="panel">
        <div className="panel__head">
          <div className="skeleton skeleton--title" />
        </div>
        <div className="panel__body">
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </div>
      </section>
    </div>
  );
}
