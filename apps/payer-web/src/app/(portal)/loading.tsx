/**
 * Neutral route-level loading skeleton for the authed portal shell (ADR-0019 Phase 1).
 *
 * Shown while a (portal) page's server work is in flight. It renders NO data and NO
 * PII — just shape placeholders — so a slow or unavailable backend never blanks the
 * screen or leaks anything. A Server Component (no client state needed).
 */
export default function PortalLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line short" />
      <div className="skeleton-cards">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div style={{ marginTop: 24 }}>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  );
}
