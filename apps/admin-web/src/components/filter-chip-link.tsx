import Link from "next/link";
import { filterChipClass } from "./filter-chip";

/**
 * A FILTER CHIP that navigates — one value of a filter in the address (a status scope, a tier, a
 * reporting window, a role). Every link chip in the console renders this (a fence in
 * filter-chip.test.ts keeps it that way).
 *
 * THE SELECTED CHIP IS TEXT ONLY WHERE ITS TARGET IS THE ADDRESS ON SCREEN (final re-sweep O-2,
 * review of #2095). Every chip keeps the other filters and drops the page cursor, so:
 *   - on the first page the selected chip's target IS this address: as a link it sat beside a
 *     Retry or another selected chip with the same address, and a click only reloaded the screen
 *     — so it is text, and `aria-current` still tells assistive tech which value is current;
 *   - on a later page (`cursor` set) its target is the first page of the same selection, and the
 *     Pager only goes forward — so it stays a link there, still marked current.
 *
 * `cursor` is the page cursor in the current address. It is required (it may be undefined) so a
 * caller cannot forget to pass it; a list that never pages passes `undefined`.
 *
 * Toggle chips that select before a confirm (the decision panel) are `<button aria-pressed>`, not
 * this. Server-safe: no hooks.
 */
export function FilterChip({
  selected,
  href,
  cursor,
  size = "sm",
  children,
}: {
  selected: boolean;
  /** Where the chip goes: its value, with every other filter kept and no page cursor. */
  href: string;
  cursor: string | undefined;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  const className = filterChipClass(selected, size);
  if (selected && !cursor) {
    return (
      <span aria-current="true" className={className}>
        {children}
      </span>
    );
  }
  return (
    <Link aria-current={selected ? "true" : undefined} className={className} href={href}>
      {children}
    </Link>
  );
}
