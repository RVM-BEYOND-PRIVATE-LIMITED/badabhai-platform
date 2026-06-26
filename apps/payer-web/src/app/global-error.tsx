"use client";

import "./globals.css";

/**
 * GLOBAL error boundary for the payer portal (ADR-0019 Phase 1).
 *
 * `global-error.tsx` catches a failure in the ROOT layout itself, so it REPLACES the whole
 * document — it MUST render its own `<html>`/`<body>` (the root layout is not applied when
 * this fires). It degrades the UNAUTHENTICATED + root surface to the SAME neutral, no-leak
 * copy + a `reset()` retry as `(portal)/error.tsx`, never the framework default screen.
 *
 * CAUSE-FREE / NO-LEAK: NEUTRAL, generic copy ONLY. It NEVER surfaces the error `cause`,
 * `message`, `digest`, or stack — a backend/deny detail could carry a no-oracle hint or
 * PII, so none of it reaches the screen. Nothing is logged client-side.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  // This boundary REPLACES the root layout, so it re-applies the optional ink theme on its
  // own <html> (public mirror only — a client boundary sees no server env). Default = no
  // attribute → paper, unchanged.
  const theme = process.env.NEXT_PUBLIC_PAYER_THEME?.trim().toLowerCase() === "ink" ? "ink" : undefined;
  return (
    <html lang="en" data-theme={theme}>
      <body>
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
      </body>
    </html>
  );
}
