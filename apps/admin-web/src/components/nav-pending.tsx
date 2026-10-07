"use client";

import { useEffect, useSyncExternalStore, useTransition } from "react";
import { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
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
 * on a slow day looked like nothing happened. The cue reads the navigation's OWN pending state —
 * Next's `useLinkStatus` for a link, a filter bar's transition for a form — so there is no
 * boundary and no guessing, and it ends exactly when the navigation commits.
 *
 *  - `NavPendingCue` sits INSIDE a `<Link>` (it must: `useLinkStatus` reads the nearest link):
 *    the sidebar, the crumb's section link, every link filter chip and the Pager.
 *  - `SubmitPendingCue` sits inside a form's submit button and is handed the pending flag of the
 *    transition `usePendingPush` navigates in — a filter bar's Apply.
 *  - `NavPendingStatus` is rendered ONCE by the shell: a bar along the top of the viewport (the
 *    cue a phone sees, since the drawer closes as its link is followed) and one polite status
 *    line. Outside the page, which is `inert` behind an open drawer.
 *
 * Nothing shows for the first {@link PENDING_ANNOUNCE_DELAY_MS} (delta review of #2095): the dot
 * waits in CSS (`--nav-pending-delay`), the bar and the status line wait for the announcement —
 * so a prefetched navigation that lands at once never flashes them.
 */

/** How long a navigation is pending before it is announced (and the bar drawn). */
export const PENDING_ANNOUNCE_DELAY_MS = 180;

/**
 * While `pending`, announce `message` on the shell's status line — after the delay — and
 * withdraw it when the navigation ends (`pending` flips) or the cue unmounts, so the status line
 * and the bar can never outlive the navigation.
 */
function usePendingAnnouncement(pending: boolean, message: string) {
  useEffect(() => {
    if (!pending) return;
    let token: number | null = null;
    const timer = setTimeout(() => {
      token = announceNavigation(message);
    }, PENDING_ANNOUNCE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      if (token !== null) withdrawNavigation(token);
    };
  }, [pending, message]);
}

/** The dot itself: hidden from assistive tech, so the control's accessible name never changes. */
function PendingDot({ pending }: { pending: boolean }) {
  return (
    <span className={pending ? "nav-pending nav-pending--on" : "nav-pending"} aria-hidden="true" />
  );
}

/** Inside a `<Link>`: pending while the navigation that link started is under way. */
export function NavPendingCue({ message }: { message: string }) {
  const { pending } = useLinkStatus();
  usePendingAnnouncement(pending, message);
  return <PendingDot pending={pending} />;
}

/** Inside a form's submit button: pending while the navigation the form started is under way. */
export function SubmitPendingCue({ pending, message }: { pending: boolean; message: string }) {
  usePendingAnnouncement(pending, message);
  return <PendingDot pending={pending} />;
}

/**
 * A form's navigation: `router.push` inside a transition, whose pending flag is true until the
 * new page has rendered — what `SubmitPendingCue` shows. No boundary.
 */
export function usePendingPush(): [pending: boolean, push: (href: string) => void] {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return [pending, (href: string) => startTransition(() => router.push(href))];
}

export function NavPendingStatus() {
  const message = useSyncExternalStore(subscribeNavigation, pendingNavigation, pendingNavigation);
  return (
    <>
      <div
        className={message ? "nav-progress nav-progress--on" : "nav-progress"}
        aria-hidden="true"
      />
      {/* Always present, so the first announcement is heard: a live region added WITH its text
          is often not read at all. */}
      <p className="sr-only" role="status" aria-live="polite">
        {message ?? ""}
      </p>
    </>
  );
}
