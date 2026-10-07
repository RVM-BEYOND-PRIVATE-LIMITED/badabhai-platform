import Link from "next/link";
import { filterChipClass } from "./filter-chip";

/**
 * A FILTER CHIP that navigates — one value of a filter in the address (a status scope, a tier, a
 * reporting window, a role). Every link chip in the console renders this (a fence in
 * filter-chip.test.ts keeps it that way).
 *
 * THE SELECTED CHIP IS NOT A LINK (final re-sweep O-2). It used to be one, to the page it is on:
 * beside a Retry (/credits '30d', a journey's 'All') or another selected chip (/skills/discovery
 * 'Awaiting decision' and 'Biggest batch first') that was two links to one address, and a click
 * on it only reloaded the screen. It renders as text in the selected state, and `aria-current`
 * still tells assistive tech which value is the current one. The unselected chips are the way to
 * the other values.
 *
 * Toggle chips that select before a confirm (the decision panel) are `<button aria-pressed>`, not
 * this. Server-safe: no hooks.
 */
export function FilterChip({
  selected,
  href,
  size = "sm",
  children,
}: {
  selected: boolean;
  /** Where the chip goes when it is not the current value. */
  href: string;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  const className = filterChipClass(selected, size);
  if (selected) {
    return (
      <span aria-current="true" className={className}>
        {children}
      </span>
    );
  }
  return (
    <Link className={className} href={href}>
      {children}
    </Link>
  );
}
