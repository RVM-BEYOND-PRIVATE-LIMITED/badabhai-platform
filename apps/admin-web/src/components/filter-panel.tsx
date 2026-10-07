"use client";

import { useId, type ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { useUrlState } from "./use-url-state";

/** The filters a page read from the URL, by name. Empty, `false` or absent is not set. */
export type FilterValues = Readonly<Record<string, string | boolean | undefined>>;

/**
 * The identity of the SET filters — what the panel re-syncs its open state on. JSON of the set
 * entries, so a value holding `&` or `=` can never pass for another set (review Nit-1).
 */
export function filterSetKey(filters: FilterValues): string {
  return JSON.stringify(Object.entries(filters).filter(([, value]) => Boolean(value)));
}

/**
 * A list page's filter panel, folded behind one toggle on a phone (final sweep AW-08).
 *
 * At 375px the filter panels stood 163-418px tall between a list's header and its first row
 * (owner requirement 21: the first datum within reach). Above the phone line nothing changes —
 * the toggle is not drawn and the fields always show (globals.css). On a phone the panel is a
 * "Filters (n)" disclosure: CLOSED when no filter is set, OPEN when one is, so a filter that is
 * narrowing the list is never hidden behind a closed toggle.
 *
 * THE OPEN STATE FOLLOWS THE FILTER SET (reviews of #2036 and #2046). Next keeps a client
 * component's state across a navigation that changes only the search params, so a state decided
 * once at mount went stale: a row's correlation-id link on /events landed on a filtered list with
 * a phone's panel still closed. The state now re-syncs during render when the filter set changes
 * (`useUrlState`) — nothing remounts, so focus stays on Apply or the field it was in:
 *  - a new or changed non-empty set OPENS the panel (the correlation-id link, a chip, a back link);
 *  - an emptied set leaves it as it is — clearing every filter with Apply must not hide the Apply
 *    a keyboard user is standing on;
 *  - the same set (a page turn) changes nothing; the toggle stays the operator's.
 * The filter bars passed in as `children` follow their own URL values the same way.
 */
export function FilterPanel({
  headingId,
  heading,
  filters,
  children,
}: {
  /** The panel's (visually hidden) heading id — the `aria-labelledby` of the section. */
  headingId: string;
  /** The heading text, e.g. "Filter workers". */
  heading: string;
  /** The filters the page read from the URL (never the cursor: paging is not a filter). */
  filters: FilterValues;
  children: ReactNode;
}) {
  const activeCount = Object.values(filters).filter(Boolean).length;
  const [open, setOpen] = useUrlState(activeCount > 0, filterSetKey(filters), openOnly);
  const bodyId = useId();

  return (
    <section
      className="panel filter-panel"
      aria-labelledby={headingId}
      data-open={open ? "true" : "false"}
    >
      <h2 className="sr-only" id={headingId}>
        {heading}
      </h2>
      <button
        type="button"
        className="btn btn--ghost btn--sm filter-panel__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={ACTION_ICON.disclosure} className="disclosure__caret" />
        {activeCount > 0 ? `Filters (${activeCount})` : "Filters"}
      </button>
      <div className="filter-panel__body" id={bodyId}>
        {children}
      </div>
    </section>
  );
}

/** A filter-set change opens the panel when the new set has a filter, and never closes it. */
function openOnly(wasOpen: boolean, hasFilters: boolean): boolean {
  return wasOpen || hasFilters;
}
