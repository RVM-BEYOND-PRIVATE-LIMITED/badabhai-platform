/**
 * THE RAIL'S SCROLL REGION — discoverable and keyboard-reachable when it has to scroll.
 *
 * On a short laptop (1280×720, 1366×768) the worker card and the pinned actions take the rail's
 * height, and "Also in your posting" sits below the region's fold. A fade alone was the only cue,
 * and a scroll box with no focusable child cannot be scrolled from the keyboard in every browser
 * (Safari). So while — and only while — the region overflows:
 *   - it joins the Tab order (`tabindex=0`; it already carries `role=region` + a label), and
 *   - `data-more="true"` shows a "More below" cue for as long as there is content below.
 * When it fits, it is not a Tab stop and the cue is hidden. A ref callback (no hook), like the
 * card's fold observer; React does not manage either attribute, so it never resets them.
 */

/** Whether a scroll box overflows, and whether content remains below its visible part. */
export function railScrollState(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): { overflows: boolean; more: boolean } {
  const overflows = scrollHeight > clientHeight + 1;
  return { overflows, more: overflows && scrollTop + clientHeight < scrollHeight - 1 };
}

/** Ref callback for `.posting-preview__scroll`. Returns the cleanup React 19 calls on unmount. */
export function observeRailScroll(region: HTMLElement | null): (() => void) | undefined {
  if (region === null || typeof ResizeObserver === "undefined") return undefined;
  const update = () => {
    const { overflows, more } = railScrollState(
      region.scrollTop,
      region.clientHeight,
      region.scrollHeight,
    );
    region.dataset.more = more ? "true" : "false";
    if (overflows) region.tabIndex = 0;
    else region.removeAttribute("tabindex");
  };
  const resize = new ResizeObserver(update);
  resize.observe(region);
  for (const child of Array.from(region.children)) resize.observe(child);
  const mutation = new MutationObserver(update);
  mutation.observe(region, { childList: true, subtree: true, characterData: true });
  region.addEventListener("scroll", update, { passive: true });
  update();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    region.removeEventListener("scroll", update);
  };
}
