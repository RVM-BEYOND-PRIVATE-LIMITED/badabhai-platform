"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useLinkStatus } from "next/link";
import {
  announceNavigation,
  pendingNavigation,
  subscribeNavigation,
  withdrawNavigation,
} from "./nav-pending-store";

/**
 * THE NAVIGATION PENDING CUE (review of #2095).
 *
 * The console has no loading boundary anywhere (app/no-loading-boundary-anywhere.test.ts): a
 * boundary held query-only navigations in a transition that never committed. So a navigation
 * keeps the current page on screen until the next one has rendered — and without a cue, a click
 * on a slow day looked like nothing happened. The cue is Next's own link status
 * (`useLinkStatus`, an optimistic state of the navigation transition): no boundary, no timer, and
 * it ends exactly when the navigation commits.
 *
 *  - `NavPendingCue` sits INSIDE a nav `<Link>` (it must: `useLinkStatus` reads the nearest
 *    link): a dot after the label while that link's navigation is pending. Hidden from assistive
 *    tech, so the link's accessible name never changes.
 *  - `NavPendingStatus` is rendered ONCE by the shell: a bar along the top of the viewport — the
 *    cue a phone sees, since the drawer closes as its link is followed — and one polite status
 *    line naming where the navigation is going. Outside the page, which is `inert` behind an
 *    open drawer.
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
  const label = useSyncExternalStore(subscribeNavigation, pendingNavigation, pendingNavigation);
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
