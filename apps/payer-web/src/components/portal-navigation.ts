"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useNavigationCue } from "./nav-pending";

/**
 * THE PORTAL'S ONLY PROGRAMMATIC NAVIGATION: `router.push` / `router.replace` with the navigation
 * pending cue — the button-side twin of `PortalLink` (components/portal-link.tsx).
 *
 * The portal has no loading boundary (app/no-suspense-above-a-page.test.ts), so a navigation keeps
 * the current page on screen until the next one has rendered. A link says so with its own cue; a
 * BUTTON that navigates — a form's publish/save landing on the posting, the agency form's Cancel,
 * the verified sign-in code — said nothing at all: on a slow backend (1.5s per read) the page sat
 * there after the button's own "Publishing…" had done its job. So every such navigation goes
 * through {@link usePortalNavigation} (app/every-navigating-button-shows-the-cue.test.ts rejects a
 * bare `router.push` / `router.replace`), and shows what a link's does: the bar along the top and
 * the shell's ONE polite status line, "Opening {pendingLabel}…" (components/nav-pending.tsx — the
 * same store, so a link and a button can never both speak).
 *
 * HOW IT KNOWS WHEN THE NAVIGATION ENDS: the router call runs inside this hook's own transition.
 * Next's router updates its state in a transition too, so `pending` stays true until the
 * destination has rendered (or the navigation failed) — it is the navigation's own state, exactly
 * as `useLinkStatus` is a link's. The cue waits out the store's delay, so a prefetched navigation
 * that lands sooner never flashes, under reduced motion too.
 *
 * A BUTTON'S OWN PENDING STATE is the caller's: a form that already shows "Publishing…" keeps it
 * latched once its save succeeded (it is about to leave the page), so the button stays pending
 * through the navigation with no label swap back. `pending` here is for a caller with no latch.
 *
 * A server action that ends in `redirect()` is a navigation too, with no router call to wrap: its
 * caller feeds the same cue from the action's own transition with {@link useNavigationCue}
 * (the sign-out item does) — the fence requires that of every caller of such an action.
 */
export interface PortalNavigateOptions {
  /** The destination the shell's status line names ("Opening {pendingLabel}…"). Never blank. */
  pendingLabel: string;
  /** Replace the current history entry instead of pushing one (sign-in → dashboard). */
  replace?: boolean;
  /**
   * Re-read the server data too (`router.refresh()`), inside the same transition — a save whose
   * destination, or a later Back, must not come from the router cache's pre-save copy.
   */
  refresh?: boolean;
}

export interface PortalNavigation {
  /** True from the call until the destination has rendered. */
  readonly pending: boolean;
  /** Navigate to an in-app `href` ("/…" or "?…"), naming the destination for the cue. */
  readonly navigate: (href: string, options: PortalNavigateOptions) => void;
}

export function usePortalNavigation(): PortalNavigation {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState<string | null>(null);
  useNavigationCue(pending, label);

  return {
    pending,
    navigate(href, { pendingLabel, replace = false, refresh = false }) {
      setLabel(pendingLabel);
      startTransition(() => {
        if (replace) router.replace(href);
        else router.push(href);
        if (refresh) router.refresh();
      });
    },
  };
}
