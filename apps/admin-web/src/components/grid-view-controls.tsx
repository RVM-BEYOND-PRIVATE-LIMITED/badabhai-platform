"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@badabhai/icons";
import { filterChipClass } from "./filter-chip";
import { visibleColumns, type ColumnChoices, type GridColumnMeta } from "./data-grid-model";
import { writeColumnChoices, writeDensity, type GridDensity } from "./grid-preferences";

/**
 * A grid's view controls (A4, #2574), in its footer bar: the column chooser and the density
 * toggle. Both are the VIEWER's preferences (`grid-preferences.ts`), so they change what this
 * browser shows and nothing else — no navigation, no server round-trip, no URL.
 *
 * THE CHOOSER IS A DISCLOSURE, not a dialog or a menu: a button with `aria-expanded` and the panel
 * of checkboxes it controls. Escape closes it and puts focus back on its button; a click or focus
 * outside closes it. Closed, the panel is `visibility: hidden` (globals.css) — out of the tab
 * order and the accessibility tree — and it opens with a 140ms fade (--duration-fast).
 *
 * A locked column (the row link's) is listed checked and disabled, so the chooser still says it
 * is there; the last visible column cannot be unchecked, so a grid is never emptied by a click.
 */
export function GridViewControls({
  gridId,
  columns,
  choices,
  density,
}: {
  gridId: string;
  columns: readonly GridColumnMeta[];
  choices: ColumnChoices;
  density: GridDensity;
}) {
  const compact = density === "compact";
  return (
    <div className="grid__controls">
      {columns.length > 1 ? (
        <ColumnChooser gridId={gridId} columns={columns} choices={choices} />
      ) : null}
      {/* A toggle button: its name never changes, `aria-pressed` carries the state. On a touch
          screen rows stay 44px whatever it says, so it is not drawn there (globals.css). */}
      <button
        type="button"
        className={`${filterChipClass(compact)} grid__density`}
        aria-pressed={compact}
        onClick={() => writeDensity(compact ? "comfortable" : "compact")}
      >
        <Icon name="rows" />
        Compact rows
      </button>
    </div>
  );
}

function ColumnChooser({
  gridId,
  columns,
  choices,
}: {
  gridId: string;
  columns: readonly GridColumnMeta[];
  choices: ColumnChoices;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();

  const shown = new Set(visibleColumns(columns, choices).map((c) => c.id));
  const hiddenCount = columns.filter((c) => !shown.has(c.id)).length;

  // While open: Escape closes and returns focus to the toggle; a pointer press or focus outside
  // the chooser closes it. Listened for only while open.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onOutside = (e: Event) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open]);

  function setShown(id: string, visible: boolean) {
    const column = columns.find((c) => c.id === id);
    if (!column || column.locked) return;
    // A choice equal to the default is not stored: a column added to the grid later still starts
    // at its own default for a viewer who only ever toggled this one back.
    const next: Record<string, boolean> = { ...choices };
    if (visible === !column.defaultHidden) delete next[id];
    else next[id] = visible;
    writeColumnChoices(gridId, next);
  }

  const groups = groupColumns(columns);

  return (
    <div className="grid-menu" ref={rootRef}>
      <button
        type="button"
        ref={toggleRef}
        className={filterChipClass(open)}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="squares-four" />
        {hiddenCount > 0 ? `Columns (${hiddenCount} hidden)` : "Columns"}
      </button>
      <div
        className="grid-menu__panel"
        id={panelId}
        data-open={open ? "true" : "false"}
        role="group"
        aria-labelledby={headingId}
      >
        <p className="grid-menu__title" id={headingId}>
          Show columns
        </p>
        {groups.map(([group, members]) => (
          <fieldset className="grid-menu__group" key={group ?? ""}>
            {group ? <legend className="grid-menu__legend">{group}</legend> : null}
            {members.map((c) => {
              const visible = shown.has(c.id);
              const lastShown = visible && shown.size === 1;
              return (
                <label className="grid-menu__option" key={c.id}>
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={c.locked || lastShown}
                    onChange={(e) => setShown(c.id, e.target.checked)}
                  />
                  <span>{c.header}</span>
                  {c.locked ? <span className="grid-menu__note">always shown</span> : null}
                </label>
              );
            })}
          </fieldset>
        ))}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => writeColumnChoices(gridId, null)}
        >
          Reset columns
        </button>
      </div>
    </div>
  );
}

/** The columns in their own order, under their chooser group (ungrouped columns form one list). */
function groupColumns(
  columns: readonly GridColumnMeta[],
): Array<[string | undefined, GridColumnMeta[]]> {
  const groups: Array<[string | undefined, GridColumnMeta[]]> = [];
  for (const column of columns) {
    const existing = groups.find(([g]) => g === column.group);
    if (existing) existing[1].push(column);
    else groups.push([column.group, [column]]);
  }
  return groups;
}
