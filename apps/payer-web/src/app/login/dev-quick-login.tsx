"use client";

import { useState, useTransition } from "react";
import { Button } from "../../components/ds";
import { devQuickLogin } from "./dev-quick-login-action";

/**
 * DEV-ONLY quick-login panel — rendered by the login page ONLY when `DEV_QUICK_LOGIN`
 * is "true" (see {@link devQuickLogin} for the server-side re-assert). Two one-click
 * buttons obtain a REAL backend session via the server action (no manual OTP). It is
 * visibly marked dev-only, never appears in staging/production, and never handles a
 * secret — the action runs entirely server-side.
 */
type DevRole = "employer" | "agent";

/** A server-action redirect surfaces as a thrown error carrying a NEXT_REDIRECT digest. */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export function DevQuickLogin() {
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<DevRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  function login(role: DevRole) {
    setError(null);
    setActive(role);
    startTransition(async () => {
      try {
        await devQuickLogin(role);
        // On success the action redirects; control does not return here.
      } catch (err) {
        // A redirect is navigation, not a failure — let the framework handle it.
        if (isRedirect(err)) return;
        setActive(null);
        setError("Dev quick login failed — is the local backend running with console OTP?");
      }
    });
  }

  return (
    <div className="login-demo login-demo--dev">
      <strong>⚙️ DEV-ONLY QUICK LOGIN</strong>
      <p>
        One click → a REAL local backend session (skips manual OTP). Never enabled in
        staging or production.
      </p>
      <div className="login-demo__btns">
        <Button
          variant="secondary"
          block
          loading={pending && active === "employer"}
          disabled={pending}
          onClick={() => login("employer")}
        >
          Login as Employer
        </Button>
        <Button
          variant="secondary"
          block
          loading={pending && active === "agent"}
          disabled={pending}
          onClick={() => login("agent")}
        >
          Login as Agency
        </Button>
      </div>
      {error ? (
        <p role="alert" className="login-demo__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
