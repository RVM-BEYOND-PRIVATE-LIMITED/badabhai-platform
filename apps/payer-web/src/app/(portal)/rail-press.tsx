"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

/**
 * THE RAIL'S PRESS (W6 #2586): the rail destination a press is taking the payer to, while that
 * navigation is under way.
 *
 * The portal keeps the current page on screen until the next one has rendered, so a rail row that
 * followed only the path lit up seconds after the click. The rail now marks the PRESSED
 * destination at once: its row turns active and the marker glides there (sidebar-nav.tsx,
 * rail-marker.ts). `aria-current` stays on the page that is actually open.
 *
 * Every link in the rail that goes to a rail destination reports its press here: each row, and
 * the brand lockup (→ Dashboard, layout.tsx). One scope holds them all (AppShell wraps the rail's
 * brand and nav in it), so a press on the logo moves the marker as a press on the Dashboard row
 * does, and a press that takes over from another moves it once, straight to the new row.
 *
 * A press starts when its link's navigation does, read from the link's own pending status (the
 * pending cue's signal, components/nav-pending.tsx). It ends when either of these happens:
 *  - the path moves on (it landed, or another navigation did);
 *  - its link stops pending, because another navigation took over (even one to the same path).
 * Then the rail marks the page that is open again.
 *
 * A release ends only its OWN press, which is told apart by the link that made it, not by where
 * it goes. The logo and the Dashboard row both go to /dashboard, and Next idles the one as the
 * other starts, in the same commit.
 */
export function RailPressScope({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [press, setPress] = useState<PendingPress | null>(null);
  // A press belongs to the page it was made on. Once the path moves on (this navigation landed, or
  // another one did), it is spent, and it is dropped during this render, before anything is drawn
  // from it.
  const live = press !== null && press.from === pathname ? press : null;
  if (press !== null && live === null) setPress(null);
  const onPress = useCallback(
    (by: string, href: string) =>
      setPress((p) => (p?.by === by && p.from === pathname ? p : { href, from: pathname, by })),
    [pathname],
  );
  const onRelease = useCallback((by: string) => setPress((p) => (p?.by === by ? null : p)), []);
  const markedPath = live?.href ?? pathname;
  const rail = useMemo(
    () => ({ markedPath, onPress, onRelease }),
    [markedPath, onPress, onRelease],
  );
  return <RailPressContext.Provider value={rail}>{children}</RailPressContext.Provider>;
}

/** A press on a rail link: its destination, the path it was made on, and the link that made it. */
export interface PendingPress {
  href: string;
  from: string;
  /** The reporting link's own id (a {@link RailPress} instance), never its href. */
  by: string;
}

interface RailPressApi {
  /** The path the rail marks: the pending press's destination, or else the page that is open. */
  markedPath: string;
  /** Link `by` started its navigation to `href`. */
  onPress: (by: string, href: string) => void;
  /** Link `by` stopped: it landed, or another navigation took over. */
  onRelease: (by: string) => void;
}

const RailPressContext = createContext<RailPressApi | null>(null);

/** The path the rail marks ({@link RailPressScope}); null outside a scope, where nothing reports a press. */
export function useMarkedPath(): string | null {
  return useContext(RailPressContext)?.markedPath ?? null;
}

/**
 * Sits inside a rail link (a row's, or the brand lockup's), because it reads that link's status
 * and must be within its `<Link>`. It draws nothing and reports only the EDGES of the link's
 * navigation to the rail's scope:
 *  - the press, when the navigation starts. This is Next's own link status, so a modified click
 *    or a new tab never moves anything.
 *  - the release, when it stops: it landed, or another navigation took over. Next sets the
 *    superseded link idle.
 *
 * A render while the link is still pending reports nothing. A Back press commits the restored page
 * before Next drops the old link's status, so reporting again then would re-arm the press on the
 * page it moved to. Outside a scope it reports nothing at all.
 */
export function RailPress({ href }: { href: string }) {
  const { pending } = useLinkStatus();
  const rail = useContext(RailPressContext);
  const by = useId();
  const reported = useRef(false);
  const onPress = rail?.onPress;
  const onRelease = rail?.onRelease;
  useEffect(() => {
    if (onPress === undefined || onRelease === undefined) return;
    if (pending === reported.current) return;
    reported.current = pending;
    if (pending) onPress(by, href);
    else onRelease(by);
  }, [pending, href, by, onPress, onRelease]);
  return null;
}
