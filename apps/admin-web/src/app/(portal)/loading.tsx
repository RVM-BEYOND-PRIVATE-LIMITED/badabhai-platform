/**
 * Portal loading state. Shape-matched to the dashboard so the layout does not jump when
 * the real content resolves — a skeleton that is a different size from its content is
 * worse than no skeleton at all.
 *
 * The dashboard resolves into `.page__head` → `.stats` → `.cols` of `.panel` → a wide
 * `.panel`, so the placeholders sit in exactly those containers rather than in a generic
 * stack. Sizes come from `.skeleton--title/--row`; nothing here hardcodes a dimension.
 *
 * NOTE: admin-web's globals.css has no `.skeleton--tile`, so a KPI tile is composed as the
 * real `.stat` surface with a `.skeleton--row` inside it. That borrows the tile's own
 * padding/border, which is what makes it the right size.
 */
export default function PortalLoading() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <header className="page__head">
        <div className="skeleton skeleton--title" />
      </header>

      {/* The four headline counters. */}
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

      {/* The two side-by-side panels (funnel + health). */}
      <div className="cols">
        <section className="panel">
          <div className="panel__head">
            <div className="skeleton skeleton--title" />
          </div>
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </section>
        <section className="panel">
          <div className="panel__head">
            <div className="skeleton skeleton--title" />
          </div>
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
          <div className="skeleton skeleton--row" />
        </section>
      </div>

      {/* …then the full-width recent-activity table. */}
      <section className="panel">
        <div className="panel__head">
          <div className="skeleton skeleton--title" />
        </div>
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
        <div className="skeleton skeleton--row" />
      </section>
    </div>
  );
}
