"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "../../../../components/ds";
import { acceptInviteAction } from "../actions";

/**
 * Client ACCEPT affordance (ADR-0027 / B5.5). Runs in the BROWSER and sees NO secret; it calls the
 * {@link acceptInviteAction} Server Action, which re-validates the token + binds the accept to the
 * server-held session identity. The single-use token is passed straight through from the URL — it
 * is never rendered, logged, or echoed in a result message. A bad/expired/mismatched token yields a
 * NEUTRAL failure (no-oracle).
 *
 * UI-1: the three outcomes now speak the shared language — a missing code is an error `state` with
 * a way out, and the accepted / rejected results are `alert` bands. The failure copy is still the
 * server's neutral message, rendered verbatim.
 */
export function AcceptInvite({ token }: { token: string }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const hasToken = token.trim().length > 0;

  function onAccept() {
    setResult(null);
    startTransition(async () => {
      setResult(await acceptInviteAction({ token }));
    });
  }

  if (!hasToken) {
    return (
      <div className="state state--error">
        <span className="state__icon">
          <i className="ph ph-link-break" aria-hidden="true" />
        </span>
        <h2 className="state__title">This invite link is missing its code</h2>
        <p className="state__body">Ask your team owner to resend the invite.</p>
        <div className="state__actions">
          <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/dashboard">
            Go to your dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (result?.ok) {
    return (
      <div className="alert alert--success">
        <i className="ph ph-check-circle alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Invite accepted</p>
          <p className="alert__body">{result.message}</p>
        </div>
        <div className="alert__actions">
          <Link className="bb-btn bb-btn--primary bb-btn--sm" href="/dashboard">
            <span>Go to your dashboard</span>
            <i className="ph ph-arrow-right" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="form-actions">
        <Button variant="primary" loading={pending} aria-busy={pending} onClick={onAccept}>
          {pending ? "Joining…" : "Accept invite"}
        </Button>
      </div>
      <div aria-live="polite" className="form-status">
        {result && !result.ok ? (
          <div className="alert alert--danger">
            <i className="ph ph-warning-circle alert__icon" aria-hidden="true" />
            <div className="alert__text">
              {/* The server's NEUTRAL message, verbatim — it never says which check failed. */}
              <p className="alert__body">{result.message}</p>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
