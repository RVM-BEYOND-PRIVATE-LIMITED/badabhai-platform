"use client";

import type { MouseEvent, ReactNode } from "react";
import { PortalLink, type PortalLinkProps } from "./portal-link";
import { requestListFocus, takeListFocus } from "../lib/list-focus";

/**
 * Paging a list moves focus to the heading of the list it opens (#2588) — the two halves:
 *  - {@link PagerLink}: a `PortalLink` (pending cue and all) that, on a click that navigates this
 *    tab, asks for the move on the address it opens (lib/list-focus.ts);
 *  - {@link PagedListHeading}: the list's `<h2>`, focusable by script only (`tabIndex={-1}`: never a
 *    tab stop), which takes the move when it is attached on that address.
 *
 * Hook-free on purpose: the heading's work is a callback ref, which runs on attach. By then the
 * router has pushed the new address (Next updates history in an insertion effect, ahead of every
 * ref), and the node-env suites can still call these as plain functions.
 */

/** A main-button click with no modifier — the one that navigates in this tab (Enter is a click). */
function navigatesHere(e: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
  );
}

/** A pager's link ("Next page", "First page"): the next list's heading takes focus. */
export function PagerLink({ onClick, ...link }: PortalLinkProps) {
  return (
    <PortalLink
      {...link}
      onClick={(e) => {
        onClick?.(e);
        if (navigatesHere(e)) requestListFocus(link.href);
      }}
    />
  );
}

/**
 * The heading's ref. On the address a pager link asked for, it takes focus one frame later — after
 * the router's own scroll to the top of the new page — so the focus scroll brings the heading into
 * view (clear of the sticky header, by its scroll margin) and the payer starts at the first new card.
 */
export function focusIfPagedHere(el: HTMLHeadingElement | null): void {
  if (el === null || !takeListFocus(window.location.pathname + window.location.search)) return;
  requestAnimationFrame(() => {
    if (el.isConnected) el.focus();
  });
}

export function PagedListHeading({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      ref={focusIfPagedHere}
      tabIndex={-1}
      className={className ? `paged-list-heading ${className}` : "paged-list-heading"}
    >
      {children}
    </h2>
  );
}
