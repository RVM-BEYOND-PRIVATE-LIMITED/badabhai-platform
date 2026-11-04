"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { OverlayFrame, type DialogProps } from "./dialog";

/** The search param a drawer is addressed by unless the caller names another. */
export const DRAWER_PARAM = "drawer";

export type DrawerProps = DialogProps;

/**
 * A right-side modal drawer (A5, #2575): min(960px, 62vw) wide, the full viewport on a phone
 * (globals.css `.overlay--drawer`). Same focus contract as Dialog — trapped while open, Escape and
 * the scrim close it, focus returns to the trigger.
 *
 * Motion: slides in from the right edge (6px of travel, with the fade) over --duration-base while
 * the scrim fades; leaves over --duration-fast. Zero under prefers-reduced-motion.
 *
 * For a drawer that a link can open, drive `open` / `onClose` from `useUrlDrawer`.
 */
export function Drawer(props: DrawerProps) {
  return <OverlayFrame kind="drawer" {...props} />;
}

/**
 * The current URL with `param` set to `value`, or removed when `value` is null. Every other
 * search param keeps its place, so opening a drawer over a filtered list keeps the filters.
 */
export function drawerHref(
  pathname: string,
  search: string,
  param: string,
  value: string | null,
): string {
  const q = new URLSearchParams(search);
  if (value === null || value === "") q.delete(param);
  else q.set(param, value);
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/**
 * The key a drawer leaves on the history entry it PUSHED (its value is the drawer's param). Next
 * copies its own router state in beside it (its patched `pushState` / `replaceState`), so the
 * entry stays a normal Next entry that Back and Forward restore.
 */
export const DRAWER_ENTRY_KEY = "bbDrawer";

/** The narrow history surface the entries below use — `window.history` in the browser. */
export interface DrawerHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
  back(): void;
}

const browserHistory = (): DrawerHistory => window.history;

/** Was the current history entry pushed by opening the `param` drawer? */
function pushedFor(history: DrawerHistory, param: string): boolean {
  const state = history.state;
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[DRAWER_ENTRY_KEY] === param
  );
}

/**
 * OPEN: a new history entry at `href`, marked as the `param` drawer's — so Back closes it.
 *
 * SHALLOW, deliberately: the history API, not the router. Next syncs a `pushState` into
 * `usePathname` / `useSearchParams` (the drawer opens) WITHOUT re-rendering the page under it, so
 * the list a drawer sits on is not fetched again — on Candidates that re-read would spend 50 names
 * of the admin's hourly budget per open. The drawer loads its own content.
 */
export function openDrawerEntry(
  href: string,
  param: string,
  history: DrawerHistory = browserHistory(),
): void {
  history.pushState({ [DRAWER_ENTRY_KEY]: param }, "", href);
}

/** MOVE (another record in the same drawer): the current entry, rewritten — never a new one. */
export function moveDrawerEntry(
  href: string,
  param: string,
  history: DrawerHistory = browserHistory(),
): void {
  history.replaceState(pushedFor(history, param) ? { [DRAWER_ENTRY_KEY]: param } : null, "", href);
}

/**
 * CLOSE. The entry the drawer pushed is popped — exactly what Back does — so closing leaves no
 * duplicate of the list behind it for Back to land on. A drawer that came with the page (a
 * reload, a pasted link) has no entry of its own: its param is replaced away instead.
 */
export function closeDrawerEntry(
  closedHref: string,
  param: string,
  history: DrawerHistory = browserHistory(),
): void {
  if (pushedFor(history, param)) history.back();
  else history.replaceState(null, "", closedHref);
}

/**
 * A drawer ADDRESSABLE BY URL: it is open while `?<param>=<value>` is in the address bar, so the
 * view can be linked, reloaded and closed with Back. `open(value)` pushes the param (a new
 * history entry), `move(value)` rewrites it in place, `close()` takes it away (popping the entry
 * `open` pushed); `href(value)` is the link that opens it. All shallow — see `openDrawerEntry`.
 */
export function useUrlDrawer(param: string = DRAWER_PARAM) {
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  const value = params.get(param);
  const href = (next: string | null) => drawerHref(pathname, search, param, next);
  return {
    value,
    isOpen: value !== null && value !== "",
    href: (next: string) => href(next),
    open: (next: string) => openDrawerEntry(href(next), param),
    move: (next: string) => moveDrawerEntry(href(next), param),
    close: () => closeDrawerEntry(href(null), param),
  };
}
