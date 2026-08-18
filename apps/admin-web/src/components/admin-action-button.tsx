"use client";

import { useId, useState, useTransition } from "react";
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
  /** Called with the full outcome once the action settles, success or failure. */
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
 */
export function AdminActionButton({
  label,
  confirmLabel,
  action,
  variant = "danger",
  disabled = false,
  onSettled,
}: AdminActionButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  function handleClick() {
    if (pending) return;
    if (!armed) {
      setArmed(true);
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const outcome = await action();
      setArmed(false);
      if (!outcome.ok) setError(outcome.error);
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
        aria-describedby={error ? errorId : undefined}
      >
        {pending ? "Working…" : armed ? confirmLabel : label}
      </button>
      {armed && !pending && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setArmed(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      )}
      {error && (
        <span className="admin-action__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
