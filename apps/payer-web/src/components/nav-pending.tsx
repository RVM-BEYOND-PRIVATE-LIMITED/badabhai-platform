"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useLinkStatus } from "next/link";
import {
  announceNavigation,
  shownNavigation,
  subscribeNavigation,
  withdrawNavigation,
} from "./nav-pending-store";

/**
 * THE NAVIGATION PENDING CUE (mirrors admin-web's, plus a delay).
 *
 * The portal has no loading boundary (app/no-suspense-above-a-page.test.ts): one held same-section
 * navigations in a transition that never committed. So a navigation keeps the current page on
 * screen until the next one has rendered — and without a cue, a click on a slow backend looked like
 * nothing happened for ~3s (measured at 1.5s per read). The cue is Next's own link status
 * (`useLinkStatus`, an optimistic state of the navigation transition): no boundary, and it ends
 * exactly when the navigation commits.
 *
 *  - `NavPendingCue` sits INSIDE a `<Link>` (it must: `useLinkStatus` reads the nearest link): a dot
 *    on the link's corner while that link's navigation is pending. It is never placed by hand:
 *    every in-app link is a `PortalLink` (components/portal-link.tsx), which puts it there — the
 *    only module allowed to (app/every-link-shows-the-cue.test.ts). It takes NO space — absolutely
 *    positioned, the link anchored whether or not it is pending (globals.css), so a click never
 *    resizes a button or pushes a badge. Hidden from assistive tech, so the link's accessible name
 *    never changes. A client child, so a server component can place it without becoming a client
 *    component itself.
 *  - `NavPendingStatus` is rendered ONCE by the shell, outside the region that goes `inert` behind
 *    the open drawer: a bar along the top of the viewport — the cue a phone sees, since the drawer
 *    closes as its link is followed — and one polite status line naming where the navigation goes.
 *
 * Nothing shows for the first {@link import("./nav-pending-store").NAV_PENDING_DELAY_MS}ms: a
 * prefetched navigation lands sooner and must not flash (the store delays the bar and the line;
 * the dot waits out `--nav-pending-delay` in CSS).
 */
export function NavPendingCue({ label }: { label: string }) {
  const { pending } = useLinkStatus();

  // Announce while pending; withdraw when the navigation ends (pending flips) or the link
  // unmounts — so the status line and bar can never outlive the navigation.
  useEffect(() => {
    if (!pending) return;
    const token = announceNavigation(label);
    return () => withdrawNavigation(token);
  }, [pending, label]);

  return (
    <span className={pending ? "nav-pending nav-pending--on" : "nav-pending"} aria-hidden="true" />
  );
}

export function NavPendingStatus() {
  // The store is written only from effects, so the server snapshot is the (empty) store itself.
  const label = useSyncExternalStore(subscribeNavigation, shownNavigation, shownNavigation);
  return (
    <>
      <div
        className={label ? "nav-progress nav-progress--on" : "nav-progress"}
        aria-hidden="true"
      />
      {/* Always present, so the first announcement is heard: a live region added WITH its text
          is often not read at all. */}
      <p className="sr-only" role="status" aria-live="polite">
        {label ? `Opening ${label}…` : ""}
      </p>
    </>
  );
}
