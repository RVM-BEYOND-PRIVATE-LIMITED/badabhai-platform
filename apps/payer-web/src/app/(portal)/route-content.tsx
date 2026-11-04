"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { afterAnimations, type Animated } from "./after-animations";

/**
 * THE CONTENT COLUMN, ONE PER PATH (W6 #2586) — how a route change gets its entrance.
 *
 * The shell is a persistent layout, so its `<main>` used to stay mounted across every navigation:
 * its one entrance played on the first load only and each later page arrived as a hard cut. Keyed
 * on the PATH, a route change mounts a fresh column and its entrance plays — the content fades in
 * with a 6px rise over 200ms (globals.css, W6 block); the old page simply leaves, there is no exit
 * animation. A QUERY change (`?reached=`, the candidates pager, "All postings") keeps the path,
 * so it keeps the column: no remount, nothing replays.
 *
 * NOT A BOUNDARY. A key is not a `<Suspense>`: nothing here can show a fallback or hold a
 * navigation, and there is still no loading.tsx, React.lazy or next/dynamic above a page
 * (app/no-suspense-above-a-page.test.ts). The navigation still keeps the current page on screen
 * until the next one has rendered; the new column is simply committed with it.
 *
 * FIRST RENDER ONLY, FOR LISTS. A fresh column carries {@link ENTERING_ATTR} from its mount until
 * its entrance has played ({@link afterEntrance}); the stylesheet staggers a list's first items in
 * only while it is there, so a list that changes later on the same page — the next page of
 * candidates, a row a save added — never replays it.
 */
export function RouteContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return <ContentColumn key={pathname}>{children}</ContentColumn>;
}

/** On the column while its entrance plays (`data-entering` below); the list stagger keys on it. */
export const ENTERING_ATTR = "data-entering";

/** The entrance keyframes (globals.css, W6 block) — the animations {@link afterEntrance} waits for. */
export const ENTRANCE_ANIMATIONS: ReadonlySet<string> = new Set(["page-enter", "list-enter"]);

export function ContentColumn({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const column = ref.current;
    if (column === null) return undefined;
    return afterEntrance(column, () => setEntering(false));
  }, []);
  return (
    <main ref={ref} className="pshell__content" id="main" data-entering={entering ? "" : undefined}>
      {children}
    </main>
  );
}

/**
 * Calls `done` once every entrance animation in `column` (its own and its lists') has finished.
 * When none is running, that is at once: reduced motion, or the first load already played them
 * before hydration. Anything else that animates there is not waited for (a spinner turns forever).
 * The returned cleanup stops a late `done`, for when the column leaves first. The waiting itself is
 * shared with the rail marker (after-animations.ts).
 */
export function afterEntrance(column: Animated, done: () => void): () => void {
  return afterAnimations(column, ENTRANCE_ANIMATIONS, done);
}
