import { useEffect, useState } from "react";

/**
 * Mount → open → closing → unmounted, so an overlay can play its EXIT motion before it leaves
 * the DOM (A5, #2575). Dialog, Drawer and Toast share it.
 *
 * The exit lasts the `--duration-fast` motion token, read from the live stylesheet: the CSS that
 * animates the exit and the timer that unmounts after it name one token, and under
 * prefers-reduced-motion the token is 0ms, so the overlay leaves at once.
 */
export type Presence = "open" | "closing" | "closed";

/** The CSS custom property an overlay's exit animation runs for. */
export const EXIT_DURATION_TOKEN = "--duration-fast";

/** The state an overlay is in after `open` changes (a render-phase adjustment). */
export function nextPresence(open: boolean, current: Presence): Presence {
  if (open) return "open";
  return current === "open" ? "closing" : current;
}

/** A CSS time (`140ms`, `0.2s`, `0ms`, ``) in milliseconds; anything unreadable is 0. */
export function parseCssDurationMs(value: string): number {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (v.endsWith("ms")) return n;
  if (v.endsWith("s")) return n * 1000;
  return 0;
}

/** The exit duration in force right now (0 outside a browser). */
export function exitDurationMs(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  return parseCssDurationMs(
    window.getComputedStyle(document.documentElement).getPropertyValue(EXIT_DURATION_TOKEN),
  );
}

export function usePresence(open: boolean): Presence {
  const [state, setState] = useState<Presence>(open ? "open" : "closed");
  const next = nextPresence(open, state);
  if (next !== state) setState(next);

  useEffect(() => {
    if (state !== "closing") return;
    const timer = setTimeout(() => setState("closed"), exitDurationMs());
    return () => clearTimeout(timer);
  }, [state]);

  return next;
}
