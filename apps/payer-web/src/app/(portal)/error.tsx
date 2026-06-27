"use client";

/**
 * Client error boundary for the authed portal (ADR-0019 Phase 1).
 *
 * NO-LEAK: it renders a NEUTRAL, generic message ONLY. It never surfaces the error
 * `cause`, `message`, `digest`, or stack — a backend/deny detail could carry a hint
 * (no-oracle) or PII, so none of it reaches the screen. The `reset()` retry re-renders
 * the segment. Nothing is logged client-side.
 */
export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <h1 className="chrome-title">Something went wrong</h1>
      <p className="chrome-sub">
        We couldn&rsquo;t load this page right now. This is on our side — please try again.
      </p>
      <div className="chrome-actions">
        <button className="bb-btn bb-btn--primary" type="button" onClick={() => reset()}>
          <span>Try again</span>
        </button>
      </div>
    </div>
  );
}
