"use client";

/**
 * ROOT client error boundary for the payer portal (ADR-0019 Phase 1).
 *
 * The `(portal)` segment already has its own boundary; this ROOT one catches a render
 * failure on the UNAUTHENTICATED surface (the `/login` page + the root segment) so it
 * degrades to the SAME neutral, no-leak copy + a `reset()` retry — not the framework's
 * default error screen.
 *
 * CAUSE-FREE / NO-LEAK: it renders a NEUTRAL, generic message ONLY. It NEVER surfaces the
 * error `cause`, `message`, `digest`, or stack — a backend/deny detail could carry a hint
 * (no-oracle) or PII, so none of it reaches the screen. Nothing is logged client-side.
 * Mirrors `(portal)/error.tsx`.
 *
 * UI-1: composed from the shared `.state state--error` block, identical to `(portal)/error.tsx`,
 * so the authed and unauthed failure screens are the same surface. Markup only — the copy and
 * the `reset()` wiring are unchanged.
 */
export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <span className="state__icon">
        <i className="ph ph-warning-circle" aria-hidden="true" />
      </span>
      <h1 className="state__title">Something went wrong</h1>
      <p className="state__body">
        We couldn&rsquo;t load this page right now. This is on our side — please try again.
      </p>
      <div className="state__actions">
        <button className="bb-btn bb-btn--primary" type="button" onClick={() => reset()}>
          <span>Try again</span>
        </button>
      </div>
    </div>
  );
}
