/**
 * Skill Discovery loading skeleton — shape-matched to the real page (`page__head` → `.stats`
 * tiles → a second compact `.stats` row → the queue `.panel`), the same discipline the
 * portal-level `(portal)/loading.tsx` uses. Its own file rather than relying on the shared
 * shell skeleton because this route's tile count (4 + 5) and the queue panel's filter rows
 * are a materially different shape — a skeleton the wrong size jumps the layout the moment
 * real content resolves, which is worse than no skeleton.
 */
export default function SkillDiscoveryLoading() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <header className="page__head">
        <div>
          <div className="skeleton skeleton--title" />
        </div>
      </header>

      {/* The four headline tiles. */}
      <div className="stats">
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
      </div>

      {/* The five outcome tiles. */}
      <div className="stats stats--compact">
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
        <div className="stat">
          <div className="skeleton skeleton--row" />
        </div>
      </div>

      {/* The queue panel: filters, then rows. */}
      <section className="panel">
        <div className="panel__head">
          <div className="skeleton skeleton--title" />
        </div>
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
      </section>
    </div>
  );
}
