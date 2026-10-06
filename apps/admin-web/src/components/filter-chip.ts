/**
 * The class list of a FILTER CHIP — a link or button that selects one value of a filter (a
 * status scope, a tier, a time window, a decision before it is confirmed).
 *
 * A selected chip is a STATE, so it takes `.btn--selected` (the accent tint, Shift Blue text and
 * edge — payer-web's selected chip), never `.btn--primary`: the primary fill marks the one action
 * of a screen, and selected chips reusing it put up to five of them on one page (final sweep
 * AW-11). The selection itself is told to assistive tech by the chip's own `aria-current` (a
 * link) or `aria-pressed` (a toggle button), which each call site keeps.
 *
 * Server-safe (no hooks): pages and client components both call it.
 */
export function filterChipClass(selected: boolean, size: "sm" | "md" = "sm"): string {
  const state = selected ? "btn--selected" : "btn--ghost";
  return size === "sm" ? `btn btn--sm ${state}` : `btn ${state}`;
}
