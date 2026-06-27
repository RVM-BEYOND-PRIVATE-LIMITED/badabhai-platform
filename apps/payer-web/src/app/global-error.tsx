"use client";

import { useEffect, useState } from "react";
import "./globals.css";
import {
  THEME_NO_FOUC_SCRIPT,
  applyResolvedTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  type ResolvedTheme,
} from "../lib/theme";

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
 *
 * THEME-1: this boundary owns its own <html>, so it re-applies the theme itself. The inline
 * no-FOUC script themes it from the cookie/OS before paint (so the error screen never flips to
 * light in dark mode); the effect mirrors that into React state after hydration. The env
 * default is the stable SSR baseline (a client boundary can't read the server cookie at render).
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  const envDark = process.env.NEXT_PUBLIC_PAYER_THEME?.trim().toLowerCase() === "ink";
  const [theme, setTheme] = useState<ResolvedTheme>(envDark ? "ink" : "paper");

  // After hydration, resolve the persisted preference (cookie) / OS and apply it. The inline
  // script already corrected the DOM before paint; this keeps the React-controlled attribute
  // in agreement so there is no flip-back.
  useEffect(() => {
    const resolved = resolvePreferenceClient(readThemeCookieClient() ?? "system");
    setTheme(resolved);
    applyResolvedTheme(resolved);
  }, []);

  return (
    <html lang="en" data-theme={theme === "ink" ? "ink" : undefined}>
      <head>
        <meta name="theme-color" />
        <script dangerouslySetInnerHTML={{ __html: THEME_NO_FOUC_SCRIPT }} />
      </head>
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
