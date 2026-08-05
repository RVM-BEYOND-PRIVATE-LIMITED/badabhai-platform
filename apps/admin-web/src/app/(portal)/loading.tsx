/**
 * Portal loading state. Shape-matched to the dashboard so the layout does not jump when
 * the real content resolves — a skeleton that is a different size from its content is
 * worse than no skeleton at all.
 */
export default function PortalLoading() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton skeleton--title" />
      <div className="panel">
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
      </div>
    </div>
  );
}
