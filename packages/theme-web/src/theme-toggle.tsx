"use client";

/**
 * BadaBhai Design System — ThemeToggle (shared).
 *
 * The light⇄dark (paper/ink) control for every BadaBhai portal. Role-agnostic: the theme is a
 * per-user display preference, never tied to employer/agent.
 *
 * A11Y: a real `<button role="switch">` whose `aria-checked` reflects the EFFECTIVE theme
 * (dark = on), with a direction-correct `aria-label` that the shared tooltip (`.bb-icon-tip`)
 * also shows. A small "System" button makes the OS-follow preference reachable + obvious; it is
 * `aria-pressed` when active. Both are keyboard-operable with a visible focus ring in BOTH
 * themes (tokens). Changes are announced via a polite live region.
 *
 * Behaviour on toggle: (a) set `document.documentElement.dataset.theme` immediately
 * (optimistic — no reload/flash); (b) persist the cookie (so SSR renders the same theme next
 * load); (c) sync `<meta name="theme-color">`; (d) call the optional `onPersist` so a portal
 * with the server-saved choice can PATCH it. A tasteful color cross-fade + an optional,
 * feature-detected View Transition radial sweep run only when motion is allowed — all motion
 * is disabled under `prefers-reduced-motion`.
 *
 * The component is created with {@link createThemeToggle} so each portal can bind its own cookie
 * name (`bb_theme`, `bb_admin_theme`) and its own helper module without duplicating this code.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@badabhai/icons";
import { useIconTipHandlers } from "@badabhai/icons/button";
import {
  THEME_COOKIE_NAME,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-constants";
import { resolveStartPreference, themeRuntimeFor, type ThemeRuntime } from "./theme";

const RESOLVED_LABEL: Record<ResolvedTheme, string> = { paper: "Light", ink: "Dark" };

/** The class an explicit switch puts on `<html>` for the cross-fade (globals.css `html.theme-anim`). */
export const THEME_ANIM_CLASS = "theme-anim";
/**
 * How long after the fade's own duration the class stays: a little slack, so it is never taken off
 * while the last frame of the fade is still running.
 */
export const THEME_ANIM_SETTLE_MS = 50;

/** A CSS time (`220ms`, `0.22s`) in milliseconds; 0 when empty or unreadable. */
export function cssTimeMs(value: string): number {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  if (v.endsWith("ms")) return n;
  return v.endsWith("s") ? n * 1000 : 0;
}

/** Does the environment allow motion right now? (false → instant switch, no sweep.) */
function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Props a rendered toggle accepts. `initialPreference` is the server's authoritative value. */
export interface ThemeToggleProps {
  /**
   * The server's saved preference, passed only when the server-saved choice is open. It wins
   * over the cookie and rewrites it after sign-in.
   */
  initialPreference?: ThemePreference;
  /** Called after an explicit switch. Omit it when the server-saved choice is closed. */
  onPersist?: (pref: ThemePreference) => void | Promise<void>;
}

export interface ThemeToggleConfig {
  /** The client helpers to use (allows an app to inject its own tested module). */
  helpers?: ThemeRuntime;
  /** A default persistence callback; a prop of the same name wins. */
  onPersist?: (pref: ThemePreference) => void | Promise<void>;
}

/** Build a ThemeToggle bound to one cookie name and helper module. */
export function createThemeToggle(config: ThemeToggleConfig = {}) {
  const runtime = config.helpers ?? themeRuntimeFor(THEME_COOKIE_NAME);
  const defaultPersist = config.onPersist;

  return function ThemeToggle({
    initialPreference,
    onPersist,
  }: ThemeToggleProps = {}) {
    const persist = onPersist ?? defaultPersist;
    // `pref` is the persisted CHOICE (paper/ink/system); `resolved` is what's actually applied.
    // Seed from a stable default so SSR and the first client render agree (no hydration mismatch);
    // the real values are read from the cookie/OS in an effect, after hydration.
    const [pref, setPref] = useState<ThemePreference>("system");
    const [resolved, setResolved] = useState<ResolvedTheme>("paper");
    const [announce, setAnnounce] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);
    // The pending end of the current cross-fade (a second switch inside it restarts the clock).
    const fadeEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tip = useIconTipHandlers();

    // After mount, sync state to the real persisted preference + the live DOM theme. When the
    // server sent an authoritative value (the choice is open), it wins over the cookie and
    // rewrites it; otherwise today's cookie/OS behaviour is untouched.
    useEffect(() => {
      const stored = resolveStartPreference(
        initialPreference,
        runtime.readThemeCookieClient(),
      );
      if (initialPreference) runtime.writeThemeCookie(initialPreference);
      const nextResolved = runtime.resolvePreferenceClient(stored);
      setPref(stored);
      setResolved(nextResolved);
      runtime.syncThemeColorMeta();
    }, [initialPreference, runtime]);

    // When the choice is "system", follow live OS changes while mounted.
    useEffect(() => {
      if (pref !== "system" || typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        const next = mq.matches ? "ink" : "paper";
        setResolved(next);
        runtime.applyResolvedTheme(next);
      };
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, [pref, runtime]);

    /** Commit a new preference: apply optimistically, persist, sync meta, announce, save. */
    const commit = useCallback(
      (next: ThemePreference) => {
        const nextResolved = runtime.resolvePreferenceClient(next);
        const animate = motionAllowed();

        const run = () => {
          // Enable the token-driven color cross-fade ONLY for an explicit switch (never first
          // paint) and only when motion is allowed — the CSS itself is reduced-motion-gated too —
          // and END it once it has run: `html.theme-anim` re-points the transitions of everything
          // it lists (globals.css), the nav drawer's slide among them, so left on after one switch
          // the drawer never slid again. Its length is the `--duration-base` token the fade spends,
          // read live, so the stylesheet stays the one source of it.
          if (animate) {
            const root = document.documentElement;
            root.classList.add(THEME_ANIM_CLASS);
            if (fadeEnd.current !== null) clearTimeout(fadeEnd.current);
            const fadeMs = cssTimeMs(getComputedStyle(root).getPropertyValue("--duration-base"));
            fadeEnd.current = setTimeout(() => {
              root.classList.remove(THEME_ANIM_CLASS);
              fadeEnd.current = null;
            }, fadeMs + THEME_ANIM_SETTLE_MS);
          }
          runtime.applyResolvedTheme(nextResolved);
          setPref(next);
          setResolved(nextResolved);
          runtime.writeThemeCookie(next);
          setAnnounce(
            next === "system"
              ? `Theme set to follow your system (${RESOLVED_LABEL[nextResolved].toLowerCase()})`
              : `${RESOLVED_LABEL[nextResolved]} theme on`,
          );
          if (persist) {
            try {
              void Promise.resolve(persist(next)).catch(() => {});
            } catch {
              // A closed switch (or a lost network) must never break the local switch.
            }
          }
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
      },
      [persist, runtime],
    );

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
          {...tip}
        >
          <span className="theme-toggle__track" aria-hidden="true">
            <span className="theme-toggle__thumb">
              <Icon name={isDark ? "moon" : "sun"} />
            </span>
          </span>
          <span className="bb-icon-tip bb-icon-tip--bottom" aria-hidden="true">
            {toggleLabel}
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
          <Icon name="monitor" />
          <span className="theme-toggle__system-label">System</span>
        </button>

        <span className="sr-only" role="status" aria-live="polite">
          {announce}
        </span>
      </div>
    );
  };
}

/** The default toggle (payer-web's `bb_theme` cookie). */
export const ThemeToggle = createThemeToggle();
