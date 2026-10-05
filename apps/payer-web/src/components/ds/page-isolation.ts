/**
 * PAGE ISOLATION for a modal — what the DS `Dialog` does to the page behind it while it is open.
 *
 *   - INERT: every element OUTSIDE the dialog — each sibling along its ancestor path, up to
 *     `<body>` — gets `inert`. Nothing behind the dialog can be clicked, focused, found with
 *     find-in-page or reached by a screen reader's virtual cursor (`aria-modal` alone is a hint
 *     some readers ignore; the dialog's Tab trap stays as the second line).
 *   - STILL: the page's own scroller (the root) stops scrolling, so a wheel, a swipe or a scroll
 *     key over the scrim no longer moves the page under a sheet (measured: y=900 → 1300).
 *
 * Both are undone EXACTLY on close, and they nest for a dialog opened from INSIDE another (a
 * descendant of the outer `.bb-dialog`): it isolates the outer one too, and its close hands back
 * only what it took.
 *
 * THE LIMIT: a second dialog rendered anywhere ELSE in the page sits in a subtree the first one
 * already made inert — and an inert dialog cannot be used. No call site does that today (each
 * Dialog opens from the page, one at a time). Rendering every dialog through a portal on <body>
 * would lift the limit; until then, open a second dialog only from inside the first.
 *
 * Structural types, so the rules are testable without a browser (`page-isolation.test.ts`); a
 * real `HTMLElement` fits them.
 */

/** A node of the tree being walked — a real element fits. */
export interface IsolationNode {
  readonly parentElement: IsolationNode | null;
  readonly children: ArrayLike<object>;
}

interface InertCapable {
  inert: boolean;
}

/** `inert` is an HTMLElement property; an engine without it (or an SVG sprite) is skipped. */
const canBeInert = (node: object): node is InertCapable => "inert" in node;

/**
 * Makes everything outside `keep` inert, walking up to (not past) `stopAt` — `document.body`.
 * Returns the undo, which lifts ONLY the elements this call made inert: one that was already inert
 * (under an outer dialog, or by its own markup) is left alone both ways.
 */
export function inertOutside(keep: IsolationNode, stopAt: IsolationNode | null): () => void {
  const made: InertCapable[] = [];
  for (
    let node: IsolationNode = keep, parent = keep.parentElement;
    node !== stopAt && parent !== null;
    node = parent, parent = parent.parentElement
  ) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !canBeInert(sibling) || sibling.inert) continue;
      sibling.inert = true;
      made.push(sibling);
    }
  }
  return () => {
    for (const el of made) el.inert = false;
  };
}

/** The page's scroll root — `document.documentElement` fits. */
export interface ScrollRoot {
  readonly style: { overflow: string; scrollbarGutter: string };
  /** Its width WITHOUT a classic scrollbar (`clientWidth`). */
  readonly clientWidth: number;
}

// How many open dialogs hold the page still, and how to put it back when the last one closes.
let holds = 0;
let putBack: (() => void) | null = null;

/**
 * Stops the page scrolling while a dialog is open. `viewportWidth` is `window.innerWidth`: wider
 * than the root's `clientWidth` means a CLASSIC scrollbar (one that takes space — Windows), whose
 * gutter is kept so the page does not shift sideways under the scrim when the bar disappears. An
 * overlay scrollbar (phones, macOS) takes no space, so nothing is reserved for it.
 *
 * Returns the release; releasing twice is a no-op. Nested dialogs share one hold: the page is
 * restored — to exactly the inline styles it had — only when the LAST one closes.
 */
export function lockPageScroll(root: ScrollRoot, viewportWidth: number): () => void {
  if (holds === 0) {
    const { overflow, scrollbarGutter } = root.style;
    if (viewportWidth > root.clientWidth) root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    putBack = () => {
      root.style.overflow = overflow;
      root.style.scrollbarGutter = scrollbarGutter;
    };
  }
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) {
      putBack?.();
      putBack = null;
    }
  };
}
