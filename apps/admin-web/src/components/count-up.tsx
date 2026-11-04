"use client";

import { useEffect, useRef, useState } from "react";
import { formatCount, formatDisplayRupeesFromNumber } from "../lib/format";

/** What the in-flight numbers are formatted as. A union, not a function: this crosses the RSC boundary. */
export type CountUpKind = "count" | "rupees";

/** Ease-out cubic — the same arrival curve as `--ease-out`, computed per frame. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * The count-up duration, READ FROM THE TOKEN (`--duration-count`, 600ms). tokens.css zeroes it
 * under `prefers-reduced-motion`, so a reduced-motion reader gets the final figure on the first
 * frame with no separate media query to keep in sync.
 */
function countDurationMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--duration-count");
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A KPI figure that counts up to its value (A2, #2572) — from 0 on first render, and from the
 * PREVIOUS value when the figure changes in place (the 7/30/90 window switch re-renders the
 * page without remounting this).
 *
 * THE FINAL TEXT IS THE SERVER'S, EXACTLY. `text` is the caller's pre-formatted figure and is
 * what the server renders and what the animation lands on; `to` only drives the frames in
 * between. So a ₹ amount never round-trips through a float on its way to the screen, and a
 * reader without JS (or before hydration) sees the true figure, not a 0.
 *
 * Tabular figures (`.countup`) keep the width from jumping while the digits change.
 */
export function CountUp({ to, text, kind }: { to: number; text: string; kind: CountUpKind }) {
  const [shown, setShown] = useState(text);
  const previous = useRef<number>(0);

  useEffect(() => {
    const from = previous.current;
    previous.current = to;
    const duration = countDurationMs();
    if (duration <= 0 || from === to || !Number.isFinite(to)) {
      setShown(text);
      return;
    }
    const format = (n: number) =>
      kind === "rupees" ? formatDisplayRupeesFromNumber(n) : formatCount(Math.round(n));
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        setShown(text);
        return;
      }
      setShown(format(from + (to - from) * easeOut(t)));
      frame = requestAnimationFrame(step);
    };
    setShown(format(from));
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [to, text, kind]);

  return <span className="countup">{shown}</span>;
}
