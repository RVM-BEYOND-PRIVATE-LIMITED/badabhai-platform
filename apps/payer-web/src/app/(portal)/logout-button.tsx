"use client";

import { useTransition } from "react";
import { logoutAction } from "./logout-action";

/** Logout control — invokes the server action; no client-side session state exists. */
export function LogoutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="bb-btn bb-btn--secondary"
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => logoutAction())}
    >
      <span>{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
