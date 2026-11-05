"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ACTION_ICON,
  Icon,
  dismissTooltipOnEscape,
  restoreTooltip,
  watchEscapeWhileHovered,
} from "@badabhai/icons";
import { CountUp } from "../../components/ds/count-up";
import { useLiveBalance } from "../../components/live-balance";
import { PortalLink } from "../../components/portal-link";

/**
 * The shell header's credit balance — the ONE place the shell shows it, in "credits" (the unit
 * every billing surface uses) with the wallet icon.
 *
 * The shell renders it as a LINK to Credits for every member (any member can buy — owner ruling
 * 2026-10-07); `linkToCredits={false}` keeps a static variant for a context with no Credits
 * door. Below ~540px the unit word is hidden VISUALLY (globals.css), so the chip carries:
 *   - an explicit accessible name — "1234 credits — open Credits" on the link (the visible
 *     number leads it, so the name contains the visible label); the static chip's text already
 *     reads "1234 credits";
 *   - the shared tooltip (`.bb-icon-tip`, @badabhai/icons) with the same words, on hover
 *     (pointer devices) and keyboard focus, Escape-dismissable through the shared helpers — the
 *     same behaviour as every icon-only control. Above 540px the words are on the chip itself,
 *     so the tooltip stays hidden there (globals.css).
 *
 * LIVE, WITH NO RELOAD (#2585). The layout reads `balance` once and a page navigation never
 * re-renders it, so the chip also takes the balance a screen PUBLISHES after the server answered
 * (components/live-balance.ts: an unlock's read-back) — whichever the server read LAST: a publish
 * read after the layout's `balanceAsOf`, or the layout's figure (a refresh re-reads it, so after a
 * purchase the layout's new figure outranks every earlier publish, even when it is the same
 * number). When the figure changes the chip counts to it over --duration-count (600ms) while a
 * Safety Yellow tint fades out of it (400ms) — once per change, never looping, and not at all under
 * reduced motion. The accessible name and the tooltip carry the new figure at once.
 */
export function BalanceChip({
  balance,
  balanceAsOf,
  linkToCredits,
}: {
  balance: number;
  /** When the layout's server read `balance` (epoch ms, the portal server's clock). */
  balanceAsOf: number;
  linkToCredits: boolean;
}) {
  const shown = useLiveBalance(balance, balanceAsOf);
  const run = useCountRun(shown);
  const words = `${shown} ${shown === 1 ? "credit" : "credits"}`;
  // The document Escape listener of the current hover, if any (removed on leave and unmount).
  const stopHoverEscape = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopHoverEscape.current?.();
      stopHoverEscape.current = null;
    },
    [],
  );
  const onPointerEnter = (e: PointerEvent<HTMLElement>) => {
    stopHoverEscape.current?.();
    stopHoverEscape.current = watchEscapeWhileHovered(e.currentTarget);
  };
  const onPointerLeave = (e: PointerEvent<HTMLElement>) => {
    stopHoverEscape.current?.();
    stopHoverEscape.current = null;
    restoreTooltip(e.currentTarget);
  };

  const body = (
    <>
      {/* Re-keyed per change, so each change plays the tint once (globals.css, W5 block). */}
      {run ? <span key={run.id} className="pshell__balancetint" aria-hidden="true" /> : null}
      <Icon name={ACTION_ICON.credits} />
      <span className="ui-num pshell__balancenum">
        {run ? <CountUp key={run.id} from={run.from} to={run.to} /> : shown}
      </span>{" "}
      <span className="pshell__balancelabel">{shown === 1 ? "credit" : "credits"}</span>
      <span className="bb-icon-tip bb-icon-tip--bottom-end" aria-hidden="true">
        {words}
      </span>
    </>
  );

  if (linkToCredits) {
    return (
      // The navigation to Credits shows the pending cue (components/portal-link.tsx) — pinned to
      // the chip's corner, so the header never reflows.
      <PortalLink
        className="pshell__balance"
        href="/credits"
        pendingLabel="Credits"
        aria-label={`${words} — open Credits`}
        onKeyDown={(e) => dismissTooltipOnEscape(e.currentTarget, e.key)}
        onBlur={(e) => restoreTooltip(e.currentTarget)}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        {body}
      </PortalLink>
    );
  }
  return (
    <span
      className="pshell__balance pshell__balance--static"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {body}
    </span>
  );
}

/** One count, from the figure the chip showed to the one it shows now; `id` re-keys each run. */
interface CountRun {
  from: number;
  to: number;
  id: number;
}

/** The count the latest change started (null until the figure first changes — it is printed). */
function useCountRun(shown: number): CountRun | null {
  const [printed, setPrinted] = useState(shown);
  const [run, setRun] = useState<CountRun | null>(null);
  if (printed !== shown) {
    const next = { from: printed, to: shown, id: (run?.id ?? 0) + 1 };
    setPrinted(shown);
    setRun(next);
    return next;
  }
  return run;
}
