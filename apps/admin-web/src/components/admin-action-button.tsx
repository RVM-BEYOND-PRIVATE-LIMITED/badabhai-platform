"use client";

import { useState, useTransition } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import type { AdminActionOutcome } from "../lib/admin-action-result";

interface AdminActionButtonProps {
  /** Button copy before the first click. */
  label: string;
  /** Button copy once armed — must read as a question ("Confirm suspend?"), not a command. */
  confirmLabel: string;
  /** The bound Server Action, invoked only on the SECOND (confirming) click. */
  action: () => Promise<AdminActionOutcome>;
  /** The tone of the CONFIRMING click. The first click always renders as a quiet ghost button. */
  variant?: "danger" | "primary";
  disabled?: boolean;
  /**
   * The action's glyph, drawn before the label in every state (rest, armed, working, disabled)
   * and recoloured by the button. Take it from `ACTION_ICON` — one concept, one icon.
   */
  icon?: IconName;
  /**
   * WHICH record a per-row action acts on, read to assistive tech after the label ("Suspend"
   * becomes "Suspend admin 1a2b3c4d…"). A table of rows whose actions all share one name gives
   * a screen-reader user a list of identical "Suspend" buttons. Visually unchanged: the row
   * already says which record it is.
   */
  subject?: string;
  /**
   * Called with the full outcome once the action settles, success or failure.
   *
   * This is the ONLY channel for the result. The button renders no success or failure copy
   * of its own — see the component doc for why there is exactly one owner of it.
   */
  onSettled?: (outcome: AdminActionOutcome) => void;
}

/**
 * A consequential admin action, gated behind an explicit second click (Step 1.2 of the admin
 * write-action plan).
 *
 * Every action this wraps mutates real state — suspend, grant credits, close a posting, flag
 * a worker, suspend an admin — so a single stray click must never fire it. There is no modal
 * in this codebase (`apps/admin-web/src/components/` has none) and this console is built
 * quiet and dense rather than layered with overlays, so the confirm step is inline: the FIRST
 * click only arms the control, swapping its label for `confirmLabel` and revealing Cancel;
 * only a SECOND click while still armed invokes `action`. Disabled the whole time a request is
 * in flight (`useTransition`), so a double-click cannot fire it twice.
 *
 * ── ONE OWNER FOR THE RESULT COPY ───────────────────────────────────────────────────────
 * This button reports the outcome through `onSettled` and renders NOTHING about it itself.
 * It used to also keep its own `error` state and print the failure inline, while every one of
 * its six callers ALSO renders `AdminActionResultBanner` from the same outcome — so a single
 * 409 appeared twice on screen, once beside the button and once in the danger banner. The
 * banner is the owner (it is the only one that can also express a SUCCESS and link to the
 * event timeline), so failure copy lives there and only there.
 */
export function AdminActionButton({
  label,
  confirmLabel,
  action,
  variant = "danger",
  disabled = false,
  icon,
  subject,
  onSettled,
}: AdminActionButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    if (pending) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      const outcome = await action();
      setArmed(false);
      onSettled?.(outcome);
    });
  }

  return (
    <span className="admin-action" aria-live="polite">
      <button
        type="button"
        className={`btn btn--sm ${armed ? `btn--${variant}` : "btn--ghost"}`}
        onClick={handleClick}
        disabled={disabled || pending}
      >
        {icon ? <Icon name={icon} /> : null}
        <span>{pending ? "Working…" : armed ? confirmLabel : label}</span>
        {subject ? <span className="sr-only"> {subject}</span> : null}
      </button>
      {armed && !pending && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setArmed(false)}
        >
          <Icon name={ACTION_ICON.close} />
          <span>Cancel</span>
          {subject ? <span className="sr-only"> {subject}</span> : null}
        </button>
      )}
    </span>
  );
}
