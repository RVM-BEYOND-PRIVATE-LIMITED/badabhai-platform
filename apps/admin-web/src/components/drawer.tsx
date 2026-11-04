"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
 * A drawer ADDRESSABLE BY URL: it is open while `?<param>=<value>` is in the address bar, so the
 * view can be linked, reloaded and closed with Back. `open(value)` pushes the param (a new
 * history entry); `close()` replaces it away; `href(value)` is the link that opens it.
 */
export function useUrlDrawer(param: string = DRAWER_PARAM) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  const value = params.get(param);
  return {
    value,
    isOpen: value !== null && value !== "",
    href: (next: string) => drawerHref(pathname, search, param, next),
    open: (next: string) =>
      router.push(drawerHref(pathname, search, param, next), { scroll: false }),
    close: () => router.replace(drawerHref(pathname, search, param, null), { scroll: false }),
  };
}
