/**
 * WAITING OUT AN ENTRANCE (W6 #2586): how the portal's motion code learns that a named CSS
 * entrance has played without reading a duration in JS. It uses the Web Animations API's own
 * `finished` promises, found by keyframes name in an element's subtree.
 *
 * Two callers use it:
 *  - the content column (route-content.tsx), so the list stagger runs on a page's first render only;
 *  - the rail marker (rail-marker.ts), which takes the active row's plate over only once the rail
 *    groups have entered, so it never pops in ahead of them.
 */

/** What is read off the element: its animations, subtree included (absent: no Web Animations API). */
export type Animated = { getAnimations?: (options?: { subtree?: boolean }) => Animation[] };

/**
 * Calls `done` once every animation in `root` (its own and its subtree's) whose keyframes are named
 * in `names` has settled, whether it finished or was cancelled.
 *
 * When none of them is running (reduced motion, an entrance that already played, or no Web
 * Animations API), `done` runs at once: on the next microtask, before the browser paints. Any other
 * animation there is never waited for (a spinner turns forever). The returned cleanup stops a late
 * `done`.
 */
export function afterAnimations(
  root: Animated,
  names: ReadonlySet<string>,
  done: () => void,
): () => void {
  let live = true;
  const running =
    typeof root.getAnimations === "function"
      ? root
          .getAnimations({ subtree: true })
          .filter((a) => names.has((a as CSSAnimation).animationName))
      : [];
  void Promise.allSettled(running.map((a) => a.finished)).then(() => {
    if (live) done();
  });
  return () => {
    live = false;
  };
}
