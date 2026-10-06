"use client";

import { useId, useState, type ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * A list page's filter panel, folded behind one toggle on a phone (final sweep AW-08).
 *
 * At 375px the filter panels stood 163-418px tall between a list's header and its first row
 * (owner requirement 21: the first datum within reach). Above the phone line nothing changes —
 * the toggle is not drawn and the fields always show (globals.css). On a phone the panel is a
 * "Filters (n)" disclosure: CLOSED when no filter is set, OPEN when one is, so a filter that is
 * narrowing the list is never hidden behind a closed toggle.
 *
 * The open state is decided from the server's `activeCount` on first render, so the phone layout
 * is right from the first paint with no client measuring, and a fresh navigation that sets a
 * filter (a "View events" link) lands open. Toggling is the operator's from then on.
 *
 * The filter bar itself is passed in as `children` and is untouched — it still owns its fields,
 * its Apply and its URL.
 */
export function FilterPanel({
  headingId,
  heading,
  activeCount,
  children,
}: {
  /** The panel's (visually hidden) heading id — the `aria-labelledby` of the section. */
  headingId: string;
  /** The heading text, e.g. "Filter workers". */
  heading: string;
  /** How many filters the current URL applies. Opens the panel on a phone when above zero. */
  activeCount: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(activeCount > 0);
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
