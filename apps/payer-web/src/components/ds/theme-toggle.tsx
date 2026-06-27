"use client";

/**
 * BadaBhai Design System — ThemeToggle (THEME-1).
 *
 * The light⇄dark (paper/ink) control for the payer + agency portal. Role-agnostic: the
 * theme is a per-user display preference, never tied to employer/agent.
 *
 * A11Y: a real `<button role="switch">` whose `aria-checked` reflects the EFFECTIVE theme
 * (dark = on), with a direction-correct `aria-label` ("Switch to dark/light theme"). A small
 * "System" button makes the OS-follow preference reachable + obvious; it is `aria-pressed`
 * when active. Both are keyboard-operable with a visible focus ring in BOTH themes (tokens).
 * Changes are announced via a polite live region.
 *
 * Behaviour on toggle: (a) set `document.documentElement.dataset.theme` immediately
 * (optimistic — no reload/flash); (b) persist the `bb_theme` cookie (so SSR renders the same
 * theme next load); (c) sync `<meta name="theme-color">`. A tasteful color cross-fade + an
 * optional, feature-detected View Transition radial sweep run only when motion is allowed —
 * all motion is disabled under `prefers-reduced-motion`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyResolvedTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  syncThemeColorMeta,
  writeThemeCookie,
  type ResolvedTheme,
  type ThemePreference,
} from "../../lib/theme";

const RESOLVED_LABEL: Record<ResolvedTheme, string> = { paper: "Light", ink: "Dark" };

/** Does the environment allow motion right now? (false → instant switch, no sweep.) */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function ThemeToggle() {
  // `pref` is the persisted CHOICE (paper/ink/system); `resolved` is what's actually applied.
  // Seed from a stable default so SSR and the first client render agree (no hydration mismatch);
  // the real values are read from the cookie/OS in an effect, after hydration.
  const [pref, setPref] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("paper");
  const [announce, setAnnounce] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  // After mount, sync state to the real persisted preference + the live DOM theme. This runs
  // only on the client (post-hydration), so it never causes an SSR/client markup divergence.
  useEffect(() => {
    const stored = readThemeCookieClient() ?? "system";
    const nextResolved = resolvePreferenceClient(stored);
    setPref(stored);
    setResolved(nextResolved);
    syncThemeColorMeta();
    hydrated.current = true;
  }, []);

  // When the choice is "system", follow live OS changes while mounted.
  useEffect(() => {
    if (pref !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = mq.matches ? "ink" : "paper";
      setResolved(next);
      applyResolvedTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  /** Commit a new preference: apply optimistically, persist, sync meta, announce. */
  const commit = useCallback((next: ThemePreference) => {
    const nextResolved = resolvePreferenceClient(next);
    const animate = motionAllowed();

    const run = () => {
      // Enable the token-driven color cross-fade ONLY for an explicit switch (never first
      // paint) and only when motion is allowed — the CSS itself is reduced-motion-gated too.
      if (animate) document.documentElement.classList.add("theme-anim");
      applyResolvedTheme(nextResolved);
      setPref(next);
      setResolved(nextResolved);
      writeThemeCookie(next);
      setAnnounce(
        next === "system"
          ? `Theme set to follow your system (${RESOLVED_LABEL[nextResolved].toLowerCase()})`
          : `${RESOLVED_LABEL[nextResolved]} theme on`,
      );
    };

    // Progressive enhancement: a feature-detected radial View Transition sweep, only when
    // motion is allowed. Falls back to the token-driven CSS cross-fade everywhere else.
    const vt = (
      document as Document & {
        startViewTransition?: (cb: () => void) => unknown;
      }
    ).startViewTransition;
    if (typeof vt === "function" && motionAllowed()) {
      vt.call(document, run);
    } else {
      run();
    }
  }, []);

  // The primary switch flips between the two EFFECTIVE themes. Flipping it always lands on an
  // explicit paper/ink choice (leaving "system" the moment the user picks a side).
  const isDark = resolved === "ink";
  const toggleLabel = isDark ? "Switch to light theme" : "Switch to dark theme";

  const onToggle = useCallback(() => {
    commit(isDark ? "paper" : "ink");
  }, [commit, isDark]);

  const onSystem = useCallback(() => {
    commit("system");
  }, [commit]);

  return (
    <div className="theme-toggle" ref={rootRef}>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={toggleLabel}
        className="theme-toggle__switch"
        onClick={onToggle}
      >
        <span className="theme-toggle__track" aria-hidden="true">
          <span className="theme-toggle__thumb">
            <i className={`ph-fill ph-${isDark ? "moon" : "sun"}`} aria-hidden="true" />
          </span>
        </span>
      </button>

      <button
        type="button"
        className="theme-toggle__system"
        aria-pressed={pref === "system"}
        aria-label="Follow system theme"
        title="Follow system theme"
        onClick={onSystem}
      >
        <i className="ph ph-monitor" aria-hidden="true" />
        <span className="theme-toggle__system-label">System</span>
      </button>

      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
