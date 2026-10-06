"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { focusableIn, type Focusable, type FocusRoot } from "./drawer-focus";

/**
 * A list page's filter panel, folded behind one toggle on a phone (final sweep AW-08).
 *
 * At 375px the filter panels stood 163-418px tall between a list's header and its first row
 * (owner requirement 21: the first datum within reach). Above the phone line nothing changes —
 * the toggle is not drawn and the fields always show (globals.css). On a phone the panel is a
 * "Filters (n)" disclosure: CLOSED when no filter is set, OPEN when one is, so a filter that is
 * narrowing the list is never hidden behind a closed toggle.
 *
 * A NEW FILTER SET IS A NEW PANEL (review M1). Next keeps a client component's state across a
 * navigation that changes only the search params, so an open state decided once at mount went
 * stale: a row's correlation-id link on /events landed on a filtered list with the phone's panel
 * still closed — and the filter bar inside kept its own stale state too (an empty Correlation id,
 * which Apply then dropped). The panel's body is keyed on the filter values the page read from the
 * URL: different filters remount it, open when any is set, and the bar inside re-reads the URL.
 * Paging is not a filter, so it remounts nothing. Toggling between two such navigations is the
 * operator's own state and is kept.
 *
 * The filter bar itself is passed in as `children` and is untouched — it still owns its fields,
 * its Apply and its URL.
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
  /**
   * The filters the page read from the URL, by name. A value that is empty, `false` or absent is
   * not set. The set ones are the "(n)", and the whole set is the panel's identity.
   */
  filters: Readonly<Record<string, string | boolean | undefined>>;
  children: ReactNode;
}) {
  const set = Object.entries(filters).filter(([, value]) => Boolean(value));
  return (
    <FilterPanelBody
      key={set.map(([name, value]) => `${name}=${String(value)}`).join("&")}
      headingId={headingId}
      heading={heading}
      activeCount={set.length}
    >
      {children}
    </FilterPanelBody>
  );
}

function FilterPanelBody({
  headingId,
  heading,
  activeCount,
  children,
}: {
  headingId: string;
  heading: string;
  activeCount: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(activeCount > 0);
  const bodyId = useId();
  const sectionRef = useRef<HTMLElement>(null);

  // A panel mounted for new filters after its OWN form was submitted puts focus back where the
  // operator left it (see `rememberFocus`).
  useEffect(() => {
    const memory = focusAfterSubmit.get(headingId) ?? null;
    focusAfterSubmit.delete(headingId);
    const section = sectionRef.current;
    if (!section) return;
    resumeFocus(memory, section, {
      active: document.activeElement,
      body: document.body,
      now: Date.now(),
    });
  }, [headingId]);

  return (
    <section
      ref={sectionRef}
      className="panel filter-panel"
      aria-labelledby={headingId}
      data-open={open ? "true" : "false"}
      onSubmitCapture={(event) => {
        const memory = rememberFocus(event.currentTarget, document.activeElement, Date.now());
        if (memory) focusAfterSubmit.set(headingId, memory);
        else focusAfterSubmit.delete(headingId);
      }}
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

// ---------------------------------------------------------------------------------------------
// Focus across the remount
// ---------------------------------------------------------------------------------------------

/** Where focus was in a panel when its form was submitted, and when. */
export interface FocusMemory {
  index: number;
  at: number;
}

/**
 * How long a remembered position stays good. A submit's own navigation lands well inside it; a
 * remount after it is somebody else's navigation (a link elsewhere on the page) and must not pull
 * focus into the panel.
 */
const FOCUS_MEMORY_MS = 10_000;

/** The remembered position per panel (its heading id) — module state, so it outlives the remount. */
const focusAfterSubmit = new Map<string, FocusMemory>();

/**
 * Apply submits the bar's form; the URL's filters change, so the panel remounts — and the control
 * that held focus is gone, which drops a keyboard user to <body> (before the remount, focus stayed
 * on Apply). So on submit the panel records the position of the focused control among its own
 * stops, or null when focus is not in it (Safari does not focus a clicked button).
 */
export function rememberFocus<T extends Focusable>(
  panel: FocusRoot<T>,
  active: unknown,
  now: number,
): FocusMemory | null {
  const index = focusableIn(panel).indexOf(active as T);
  return index < 0 ? null : { index, at: now };
}

/**
 * …and the panel mounted for the new filters puts focus back on the control at that position —
 * only if the memory is fresh and focus is nowhere (on <body>), so it never takes focus from
 * somewhere the operator put it.
 */
export function resumeFocus<T extends Focusable>(
  memory: FocusMemory | null,
  panel: FocusRoot<T>,
  { active, body, now }: { active: unknown; body: unknown; now: number },
): void {
  if (!memory || now - memory.at > FOCUS_MEMORY_MS) return;
  if (active !== null && active !== body) return;
  focusableIn(panel)[memory.index]?.focus();
}
