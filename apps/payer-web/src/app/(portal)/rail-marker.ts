/**
 * THE RAIL'S GLIDING MARKER (W6 #2586) — the active row's Safety Yellow plate as ONE element that
 * glides to the row a press is taking the payer to, instead of jumping there once the next page
 * has rendered.
 *
 * WHY. The portal keeps the current page on screen until the next one has rendered (there is no
 * loading boundary — app/no-suspense-above-a-page.test.ts), and the plate followed the PATH, so it
 * sat on the old row for as long as the next page took (~1.5–3s on a slow backend) and then
 * jumped. sidebar-nav.tsx now moves the active row to the pressed one the moment that link's
 * navigation starts (rail-press.tsx: Next's own link status, the pending cue's signal), and this
 * marker glides there: transform only, over --duration-slow with --ease-glide (globals.css, W6
 * block).
 *
 * FIRST LOAD IS PAINTED IN PLACE (W2 #2582). Until a script has placed the marker it is not drawn
 * (`display: none`) and the active row paints its own static plate (`.pnav__link--active`), so the
 * selected item is readable before scripts load and with them disabled. Placing it sets
 * {@link RAIL_MARKER_ATTR} on the nav, and the row hands its plate over in the same frame.
 *
 * The first placement is never animated: the marker appears from `display: none` with its
 * transition held, so nothing slides in from the top. It also waits until the rail groups' own
 * entrance ({@link RAIL_ENTRANCE_ANIMATIONS}) has played. The marker sits outside the groups and
 * its geometry ignores their transform, so if it were placed during that entrance the plate would
 * pop in at full strength, ahead of the row still fading in under it and up to 6px out of line
 * with it. Until then the row's own plate, fading in with its group, is the one shown.
 *
 * Re-placing the marker on the SAME row (the rail collapses, the viewport crosses a breakpoint) is
 * instant too. Only a move to ANOTHER row glides.
 *
 * THE INK FOLLOWS THE PLATE. Once the marker is placed, a row's label and icon take the active
 * row's navy only while the plate is under that row ({@link ON_PLATE_ATTR}), not as soon as the
 * class moves. The class moves on the press, but the plate takes its 320ms to arrive, and it lands
 * on its long ease-out tail: on a hop of a few rows it is ~130ms before it covers the pressed row.
 * A label inked on the press was navy on the navy rail all that time, and the row being left was
 * navy on the rail again as soon as the plate slid off it. So while the plate travels
 * ({@link GLIDING_ATTR}), each frame reads where it is and inks exactly the rows it covers by half
 * or more (followPlate below).
 *
 * Modelled frame by frame with the real curves, hexes and row geometry: each label now clears 3:1
 * on what is under most of it at every frame of every hop. Before, the pressed label fell below
 * that for 13ms on a hop to the next row, 54–71ms on Dashboard → Postings or Candidates, and
 * ~100–115ms on Dashboard → Credits or Team. The in-place swap before W6 was ~32ms on every
 * navigation. (This is a model, not a browser measurement; the repo has no browser driver.)
 *
 * Hook-free, like the tabs indicator (components/ds/tabs.tsx). {@link railMarkerRef} is the nav's
 * callback ref. It is a fresh function each render, so React calls it after every commit, and it
 * watches the rail's size for the same-row re-placements. Geometry is read from the `offset*`
 * layout box, so the rail groups' own entrance transform never skews it.
 */

import { afterAnimations } from "./after-animations";

/** The rail groups' own first-load entrance (globals.css, sidebar polish); the marker waits it out. */
export const RAIL_ENTRANCE_ANIMATIONS: ReadonlySet<string> = new Set(["mw-nav-in"]);

/** Set on the nav once its marker is placed; the stylesheet hands the static plate over then. */
export const RAIL_MARKER_ATTR = "data-marker";

/**
 * Set on a row while the plate is under it. Once the marker is placed, this, not the active class,
 * is what gives a row the active navy ink (globals.css, W6 block).
 */
export const ON_PLATE_ATTR = "data-on-plate";

/**
 * Set on the nav while its plate travels. The rows' ink then changes at once, frame by frame,
 * instead of fading over 140ms and trailing the plate (globals.css, W6 block).
 */
export const GLIDING_ATTR = "data-gliding";

/**
 * The share of a row's height the plate must cover for the row to count as on it. Half, because
 * the label sits in the middle of the row: from then on, most of the label is on the yellow.
 */
const ON_PLATE_SHARE = 0.5;

/** A row's layout box inside the nav, in px. */
export interface RailBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `row`'s box relative to `nav` — the sum of its offset chain up to the nav (the nav is positioned,
 * so the chain reaches it). Null when the chain never does (the row is not laid out inside it), so
 * the static plate stays rather than a marker drawn in the wrong place.
 */
export function boxWithin(row: HTMLElement, nav: Element): RailBox | null {
  let x = 0;
  let y = 0;
  for (let el: HTMLElement | null = row; el !== nav; el = el.offsetParent as HTMLElement | null) {
    if (el === null) return null;
    x += el.offsetLeft;
    y += el.offsetTop;
  }
  return { x, y, w: row.offsetWidth, h: row.offsetHeight };
}

/** How much of `row`'s height the plate covers while its top is at `top` and it is `h` tall (0–1). */
export function plateCover(top: number, h: number, row: RailBox): number {
  if (row.h <= 0) return 0;
  return Math.max(0, Math.min(top + h, row.y + row.h) - Math.max(top, row.y)) / row.h;
}

/**
 * The plate's top right now, read off its computed `transform`. Mid-glide that is the transition's
 * current value: `matrix(1, 0, 0, 1, x, y)`, or `matrix3d(…)` with y 14th. Null for anything else.
 */
export function plateTopOf(transform: string): number | null {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (m === null) return null;
  const v = m[2]!.split(",").map((n) => Number.parseFloat(n));
  const y =
    m[1] === undefined ? (v.length === 6 ? v[5] : undefined) : v.length === 16 ? v[13] : undefined;
  return y !== undefined && Number.isFinite(y) ? y : null;
}

/** A row of the rail, with its box inside the nav. */
interface RailRow {
  el: HTMLElement;
  box: RailBox;
}

/** Every row laid out in the nav, with its box. */
function rowsOf(nav: HTMLElement): RailRow[] {
  const rows: RailRow[] = [];
  for (const el of nav.querySelectorAll<HTMLElement>(".pnav__link")) {
    const box = boxWithin(el, nav);
    if (box !== null) rows.push({ el, box });
  }
  return rows;
}

/** The plate is on `row` and on no other: the ink of a plate at rest. Null: on none. */
function inkOnly(nav: HTMLElement, row: HTMLElement | null): void {
  for (const el of nav.querySelectorAll<HTMLElement>(`[${ON_PLATE_ATTR}]`)) {
    if (el !== row) el.removeAttribute(ON_PLATE_ATTR);
  }
  row?.setAttribute(ON_PLATE_ATTR, "");
}

/** Ink each row by where the plate is: on it when the plate covers half of it or more. */
function inkByCover(rows: readonly RailRow[], top: number, h: number): void {
  for (const { el, box } of rows) {
    const on = plateCover(top, h, box) >= ON_PLATE_SHARE;
    if (on !== el.hasAttribute(ON_PLATE_ATTR)) el.toggleAttribute(ON_PLATE_ATTR, on);
  }
}

/** Each nav's glide in flight. Calling it stops following the plate. */
const gliding = new WeakMap<Element, () => void>();

/**
 * Carry the ink along with the plate while it glides to `row`. Each frame reads where the plate is,
 * from its own computed transform, so this follows whatever glide the stylesheet runs and reads no
 * duration or curve. It inks the rows the plate covers by half or more. So the pressed row's label
 * turns navy only once the plate has reached it, and the row being left turns light once the plate
 * has left it.
 *
 * It ends when the plate is there, when the nav has left the document, or when the next placement
 * stops it. A plate that is already there when it starts (reduced motion: no transition) ends it at
 * once, before anything is painted. Without frames or computed style (not a browser), the ink goes
 * to `row` at once.
 */
function followPlate(nav: HTMLElement, marker: HTMLElement, row: HTMLElement, to: RailBox): void {
  if (typeof requestAnimationFrame !== "function" || typeof getComputedStyle !== "function") {
    inkOnly(nav, row);
    return;
  }
  const rows = rowsOf(nav);
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    gliding.delete(nav);
    nav.removeAttribute(GLIDING_ATTR);
  };
  const step = () => {
    const top = nav.isConnected ? plateTopOf(getComputedStyle(marker).transform) : null;
    if (top === null || Math.abs(top - to.y) < 0.5) {
      stop();
      inkOnly(nav, row);
      return;
    }
    inkByCover(rows, top, to.h);
    frame = requestAnimationFrame(step);
  };
  nav.setAttribute(GLIDING_ATTR, "");
  gliding.set(nav, stop);
  step();
}

/** Where each nav's marker was last put: on which row, and at which box. */
const placed = new WeakMap<Element, { row: Element; key: string }>();

/**
 * Put the nav's marker on its active row (`.pnav__link--active`, which sidebar-nav.tsx moves to a
 * pressed row at once). A different row than last time GLIDES, and the ink follows the plate
 * there. The same row at a new box (a resize) is re-placed in place, and so is a first placement.
 * The same row at the same box is left alone, so neither a size watch nor a commit that fires
 * mid-glide cuts the glide or its ink short. No active row (or no layout): the attribute is dropped
 * and the static plate is all there is.
 */
export function placeRailMarker(nav: HTMLElement): void {
  const marker = nav.querySelector<HTMLElement>(".pnav__marker");
  const row = nav.querySelector<HTMLElement>(".pnav__link--active");
  const box = marker && row ? boxWithin(row, nav) : null;
  if (!marker || !row || !box) {
    gliding.get(nav)?.();
    inkOnly(nav, null);
    nav.removeAttribute(RAIL_MARKER_ATTR);
    placed.delete(nav);
    return;
  }
  const key = `${box.x},${box.y},${box.w},${box.h}`;
  const last = placed.get(nav);
  if (last && last.row === row && last.key === key && nav.hasAttribute(RAIL_MARKER_ATTR)) return;
  const glide = last !== undefined && last.row !== row && nav.hasAttribute(RAIL_MARKER_ATTR);
  // This placement decides the ink from here, so a glide still in flight hands over.
  gliding.get(nav)?.();

  // A still placement holds the transition for one style flush, so the marker lands where it is
  // put; the stylesheet's glide is back for the next move. Its row is inked before the flush, so
  // the row never reads as "plate on its way" for that flush.
  if (!glide) {
    marker.style.transition = "none";
    inkOnly(nav, row);
  }
  marker.style.setProperty("--pnav-marker-x", `${box.x}px`);
  marker.style.setProperty("--pnav-marker-y", `${box.y}px`);
  marker.style.setProperty("--pnav-marker-w", `${box.w}px`);
  marker.style.setProperty("--pnav-marker-h", `${box.h}px`);
  nav.setAttribute(RAIL_MARKER_ATTR, "");
  placed.set(nav, { row, key });
  if (glide) {
    followPlate(nav, marker, row, box);
    return;
  }
  void marker.offsetWidth;
  marker.style.removeProperty("transition");
}

/** Navs whose groups have entered. From then on, their marker is placed as soon as it is asked. */
const entered = new WeakSet<Element>();

/**
 * The nav's callback ref. It places the marker after every commit (a pressed row, a new path) and
 * re-places it whenever the rail's layout moves (collapse, a breakpoint, a late font).
 *
 * Until the groups have entered, nothing places it: neither a commit nor the size watch, which
 * also reports once as soon as it starts. The first placement happens when that entrance settles.
 * That is at once when nothing is playing (reduced motion, or a late hydration).
 *
 * React calls the returned cleanup before the next call and on unmount. The cleanup drops a wait
 * that is still pending, and the next call starts its own.
 */
export function railMarkerRef(nav: HTMLElement | null): (() => void) | undefined {
  if (nav === null) return undefined;
  let stopWaiting: (() => void) | undefined;
  if (entered.has(nav)) placeRailMarker(nav);
  else
    stopWaiting = afterAnimations(nav, RAIL_ENTRANCE_ANIMATIONS, () => {
      entered.add(nav);
      placeRailMarker(nav);
    });
  const watch =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (entered.has(nav)) placeRailMarker(nav);
        });
  if (watch !== null) {
    watch.observe(nav);
    for (const list of nav.querySelectorAll(".pnav__list")) watch.observe(list);
  }
  return () => {
    stopWaiting?.();
    watch?.disconnect();
  };
}
