"use client";

import { useTransition } from "react";
import { logoutAction } from "../app/logout/actions";

/**
 * Sign out. A form-less button calling the Server Action directly, so the revoke happens
 * server-side and the httpOnly cookie is cleared where it lives.
 *
 * Disabled while pending: a double-click would fire a second revoke against an
 * already-dead session and surface a spurious error on the way out.
 */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      className="btn btn--ghost btn--block"
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => void logoutAction())}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
