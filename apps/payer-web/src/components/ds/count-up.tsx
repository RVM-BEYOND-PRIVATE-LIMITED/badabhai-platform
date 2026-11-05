"use client";

/**
 * BadaBhai Design System — CountUp: a number that counts from `from` to `to` (#2583).
 *
 * The run lasts --duration-count (600ms), read from the token so it is 0 — the final figure at
 * once — under reduced motion. It eases out. Screen readers get the FINAL figure only: the moving
 * digits are aria-hidden and the settled value sits in an sr-only twin, so a live region that
 * holds a CountUp announces one number, once.
 *
 * A CountUp that CAME WITH THE PAGE — the server render and its hydration — prints the final
 * figure and does not count (#2585): the server's HTML never shows `from` (a "Reached 0 workers"
 * before the script runs, or for good if it never does), and hydrating does not replay a count
 * the reader never saw start. One that mounts in the browser — a toast, a page reached by a client
 * navigation — counts.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

/** The token the run lasts for. */
export const COUNT_UP_DURATION_TOKEN = "--duration-count";

/** The token's value in ms (0 when absent or unreadable — the final figure is shown at once). */
export function countUpDurationMs(): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(COUNT_UP_DURATION_TOKEN)
    .trim();
  const ms = raw.endsWith("ms") ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** The value at `t` (0…1) of an ease-out run from `from` to `to`, rounded to a whole number. */
export function countUpValue(from: number, to: number, t: number): number {
  const p = Math.min(1, Math.max(0, t));
  const eased = 1 - (1 - p) ** 3;
  return Math.round(from + (to - from) * eased);
}

export interface CountUpProps {
  /** Where the count starts. */
  from: number;
  /** The settled value — the only one announced. */
  to: number;
  /** Formats each figure (e.g. a locale grouping). */
  format?: (n: number) => string;
}

/** No store to watch: the snapshot only tells the server render and hydration from the browser. */
const subscribeToNothing = () => () => {};

export function CountUp({ from, to, format = String }: CountUpProps) {
  // True for the server render and the hydration of its HTML, false for a mount in the browser.
  // The FIRST render's answer is kept: React re-renders with `false` once hydration is done.
  const serverOrHydrating = useSyncExternalStore(
    subscribeToNothing,
    () => false,
    () => true,
  );
  const [cameWithPage] = useState(serverOrHydrating);
  const [shown, setShown] = useState(cameWithPage ? to : from);

  useEffect(() => {
    const duration = countUpDurationMs();
    if (
      cameWithPage ||
      duration === 0 ||
      from === to ||
      typeof requestAnimationFrame !== "function"
    ) {
      setShown(to);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / duration;
      setShown(countUpValue(from, to, t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameWithPage, from, to]);

  return (
    <>
      <span className="bb-countup" aria-hidden="true">
        {format(shown)}
      </span>
      <span className="sr-only">{format(to)}</span>
    </>
  );
}
