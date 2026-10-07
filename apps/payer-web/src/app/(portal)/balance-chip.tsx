"use client";

import Link from "next/link";
import { useEffect, useRef, type PointerEvent } from "react";
import {
  ACTION_ICON,
  Icon,
  dismissTooltipOnEscape,
  restoreTooltip,
  watchEscapeWhileHovered,
} from "@badabhai/icons";

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
 */
export function BalanceChip({ balance, linkToCredits }: { balance: number; linkToCredits: boolean }) {
  const words = `${balance} ${balance === 1 ? "credit" : "credits"}`;
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
      <Icon name={ACTION_ICON.credits} />
      <span className="ui-num pshell__balancenum">{balance}</span>{" "}
      <span className="pshell__balancelabel">{balance === 1 ? "credit" : "credits"}</span>
      <span className="bb-icon-tip bb-icon-tip--bottom-end" aria-hidden="true">
        {words}
      </span>
    </>
  );

  if (linkToCredits) {
    return (
      <Link
        className="pshell__balance"
        href="/credits"
        aria-label={`${words} — open Credits`}
        onKeyDown={(e) => dismissTooltipOnEscape(e.currentTarget, e.key)}
        onBlur={(e) => restoreTooltip(e.currentTarget)}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        {body}
      </Link>
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
