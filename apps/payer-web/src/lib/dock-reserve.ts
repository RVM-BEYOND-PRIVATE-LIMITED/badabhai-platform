/**
 * THE PHONE DOCK'S RESERVE — the room the page keeps for the dock is the dock's REAL height.
 *
 * Below 1024px the posting editor's dock is pinned to the bottom of the screen, and the page
 * keeps room for it (globals.css: the form's bottom padding and the root's bottom scroll padding,
 * both built on `--posting-dock-h`). A fixed 7rem was too little once the dock carried two status
 * lines after a refused save, or a wrapped summary on a narrow card: 153–168px tall, so a focused
 * field could sit up to 24px under it. The dock's own height is published here, as a unitless
 * pixel count on the root element (`--posting-dock-measured`); the CSS turns it into the reserve,
 * never below its 7rem floor. Unpublished (a server render, no ResizeObserver) → the floor alone.
 *
 * A ref callback (no hook), like the rail's scroll observer; React 19 calls the returned cleanup
 * when the dock unmounts, which also withdraws the measurement.
 */
export const DOCK_MEASURED_PROPERTY = "--posting-dock-measured";

/** The measurement as published: whole CSS pixels, rounded UP so the reserve never falls short. */
export const dockMeasurement = (height: number): string => String(Math.ceil(height));

/** Ref callback for `.posting-dock`. Returns the cleanup React 19 calls on unmount. */
export function observeDockHeight(dock: HTMLElement | null): (() => void) | undefined {
  if (dock === null || typeof ResizeObserver === "undefined") return undefined;
  const root = dock.ownerDocument.documentElement;
  const publish = () =>
    root.style.setProperty(
      DOCK_MEASURED_PROPERTY,
      dockMeasurement(dock.getBoundingClientRect().height),
    );
  const resize = new ResizeObserver(publish);
  resize.observe(dock);
  publish();
  return () => {
    resize.disconnect();
    root.style.removeProperty(DOCK_MEASURED_PROPERTY);
  };
}
