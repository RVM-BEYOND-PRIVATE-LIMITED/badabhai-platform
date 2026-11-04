"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

export interface SegmentedOption {
  label: string;
  href: string;
}

/**
 * A row of mutually exclusive choices with one sliding thumb (A2, #2572) — the dashboard's
 * 7 / 30 / 90-day window.
 *
 * Each segment is a LINK, so the choice lives in the URL: it survives a reload, it can be
 * shared, and it works before hydration. The thumb is one element positioned by
 * `--seg-index`, so when the page re-renders with a new selection it GLIDES there over
 * --duration-base on --ease-glide (`.seg__thumb`) instead of jumping. Equal-width segments
 * keep that a pure translate — transform only, zeroed by tokens.css under reduced motion.
 *
 * `aria-current` marks the chosen segment for assistive tech; the visual state hangs off it.
 */
export function SegmentedControl({
  label,
  options,
  selectedIndex,
}: {
  label: string;
  options: readonly SegmentedOption[];
  selectedIndex: number;
}) {
  const style = {
    "--seg-count": options.length,
    "--seg-index": selectedIndex,
  } as CSSProperties;
  return (
    <nav className="seg" aria-label={label} style={style}>
      <span className="seg__thumb" aria-hidden="true" />
      {options.map((o, i) => (
        <Link
          key={o.href}
          href={o.href}
          className="seg__option"
          aria-current={i === selectedIndex ? "page" : undefined}
          scroll={false}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
