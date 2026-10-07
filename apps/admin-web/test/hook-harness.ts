/**
 * A one-component stand-in for React's renderer, for the node test env (no DOM, no reconciler).
 *
 * Enough of React's contract to drive a component that keeps its state in `useState` (and asks
 * for a `useId`) across RE-RENDERS OF THE SAME INSTANCE — which is what a client navigation that
 * changes only the URL's search params is: Next re-renders the page with new props and keeps
 * every client component's state.
 *
 *  - State lives in slots, by hook call order, exactly as React keys it; a slot is created once.
 *  - A setState call DURING render always marks the render dirty — even when the value is unchanged
 *    — and the component runs again before `render` returns: React's "adjust state when a prop
 *    changes" (it re-runs the component before committing, so a stale frame never reaches the
 *    screen). React 19 has no same-value bailout for a render-phase update, so a component that
 *    sets state on every render loops; this throws "too many re-renders" there, as React does.
 *  - A setState call from a handler between renders updates the slot (a same value is a no-op, as
 *    React's bailout makes it); the next `render` sees it.
 *
 * Wire it in with `vi.mock("react", …)` delegating `useState` / `useId` to a harness instance.
 */
export interface HookHarness {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void];
  useId(): string;
  /** Render (call) `component`, re-running it while a render-phase update is pending. */
  render<R>(component: () => R): R;
  /** The state slots, in hook order — for tests that pin hook positions. */
  readonly slots: readonly unknown[];
}

const MAX_RENDER_PASSES = 25;

export function createHookHarness(): HookHarness {
  const slots: unknown[] = [];
  let cursor = 0;
  let pending = false;
  let rendering = false;

  function useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
    const at = cursor++;
    if (!(at in slots))
      slots[at] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (next: T | ((current: T) => T)) => {
      const value = typeof next === "function" ? (next as (current: T) => T)(slots[at] as T) : next;
      // Outside render, React bails out of a same-value update; DURING render it never does.
      if (!rendering && Object.is(value, slots[at])) return;
      slots[at] = value;
      pending = true;
    };
    return [slots[at] as T, set];
  }

  function render<R>(component: () => R): R {
    for (let pass = 0; pass < MAX_RENDER_PASSES; pass++) {
      pending = false;
      cursor = 0;
      rendering = true;
      let out: R;
      try {
        out = component();
      } finally {
        rendering = false;
      }
      if (!pending) return out;
    }
    throw new Error("too many re-renders — a render-phase update that never settles");
  }

  return { useState, useId: () => ":r0:", render, slots };
}
