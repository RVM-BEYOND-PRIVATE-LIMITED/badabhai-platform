"use client";

import { useTransition } from "react";
import { logoutAction } from "./logout-action";

/**
 * Logout control — an ICON-ONLY button (Phosphor `sign-out`) tinted with the DS danger
 * token, paired with an explicit accessible name (it carries no visible label). Invokes the
 * server action; no client-side session state exists. While the transition is pending the
 * button is disabled + `aria-busy` and swaps to a spinner so the action reads as in-flight.
 */
export function LogoutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="portal-logout"
      type="button"
      aria-label="Sign out"
      title="Sign out"
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => logoutAction())}
    >
      <i
        className={pending ? "ph ph-spinner portal-logout__spin" : "ph ph-sign-out"}
        aria-hidden="true"
      />
    </button>
  );
}
