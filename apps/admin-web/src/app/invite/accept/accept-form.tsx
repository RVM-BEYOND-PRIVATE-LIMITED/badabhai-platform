"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInviteAction, type AcceptOutcome } from "./actions";

/**
 * The redeem button and its two outcomes (#1494).
 *
 * A DELIBERATE BUTTON, not an auto-POST on mount. Accepting is a single-use, irreversible
 * consumption of the token: an auto-POST would burn it on a link preview, an email
 * scanner's prefetch, or a stray double-render, and the invitee would arrive to find their
 * own invite already spent. One tap, by the person holding the link.
 *
 * The token is a PROP from the server component and goes straight back to a Server Action.
 * It is never put in component state, never logged, and never rendered.
 */
export function AcceptForm({ token }: { token: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<AcceptOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  function redeem() {
    setOutcome(null);
    startTransition(async () => {
      setOutcome(await acceptInviteAction({ token }));
    });
  }

  if (outcome?.ok) {
    return (
      <div className="alert alert--ok" role="status">
        <div className="alert__text">
          <p className="alert__title">Your admin account is active</p>
          <p className="alert__body">
            Sign in to finish setting up. You&rsquo;ll get a one-time code by email, then
            register an authenticator app for your second factor.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => router.push("/login")}>
          Go to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="auth-step">
      <p className="auth-step__lede">
        Accepting activates your admin account. You&rsquo;ll sign in afterwards with a
        one-time code and an authenticator app.
      </p>
      {outcome && !outcome.ok ? (
        <p className="field__error" role="alert">
          {outcome.error}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary"
        onClick={redeem}
        disabled={pending}
      >
        {pending ? "Activating…" : "Accept invite"}
      </button>
    </div>
  );
}
