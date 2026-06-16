import type { ScoreComponent } from "@/lib/api";

/**
 * Shared faceless presenters for the Reach views (ADR-0011). These render ONLY the
 * fields the API returns on this surface: numeric `score`, booleans, opaque ids, and
 * the engine's explainable `components[]`. No PII is fetched, joined, or rendered.
 */

/** Format a 0..1 score as a 0–100% value plus the raw 3-decimal score, for ops clarity. */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  const pct = Math.round(score * 1000) / 10;
  return `${pct.toFixed(1)}% (${score.toFixed(3)})`;
}

/** Render a single signed-ish number compactly (raw / weight contributions). */
function num(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : "—";
}

/**
 * The explainable "why" — an expandable per-row list of score components
 * (signal · raw · weight · reason). Uses native <details> so it stays a server
 * component and adds no client state/JS library.
 */
export function WhyDetails({ components }: { components: ScoreComponent[] }) {
  if (!components || components.length === 0) {
    return <span className="page-sub">—</span>;
  }
  return (
    <details className="why">
      <summary>Why ({components.length})</summary>
      <div className="why-list">
        <div className="why-row">
          <span className="why-signal">Signal</span>
          <span className="why-num">raw</span>
          <span className="why-num">weight</span>
          <span className="why-reason">reason</span>
        </div>
        {components.map((c, i) => (
          <div className="why-row" key={`${c.signal}-${i}`}>
            <span className="why-signal">{c.signal}</span>
            <span className="why-num">{num(c.raw)}</span>
            <span className="why-num">{num(c.weight)}</span>
            <span className="why-reason">{c.reason}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
