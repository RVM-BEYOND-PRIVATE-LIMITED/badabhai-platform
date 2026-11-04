"use client";

/**
 * BadaBhai Design System — CountUp: a number that counts from `from` to `to` (#2583).
 *
 * The run lasts --duration-count (600ms), read from the token so it is 0 — the final figure at
 * once — under reduced motion. It eases out. Screen readers get the FINAL figure only: the moving
 * digits are aria-hidden and the settled value sits in an sr-only twin, so a live region that
 * holds a CountUp announces one number, once.
 */
import { useEffect, useState } from "react";

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

export function CountUp({ from, to, format = String }: CountUpProps) {
  const [shown, setShown] = useState(from);

  useEffect(() => {
    const duration = countUpDurationMs();
    if (duration === 0 || from === to || typeof requestAnimationFrame !== "function") {
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
  }, [from, to]);

  return (
    <>
      <span className="bb-countup" aria-hidden="true">
        {format(shown)}
      </span>
      <span className="sr-only">{format(to)}</span>
    </>
  );
}
