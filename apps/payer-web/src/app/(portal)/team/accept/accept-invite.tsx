"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Card } from "../../../../components/ds";
import { acceptInviteAction } from "../actions";

/**
 * Client ACCEPT affordance (ADR-0027 / B5.5). Runs in the BROWSER and sees NO secret; it calls the
 * {@link acceptInviteAction} Server Action, which re-validates the token + binds the accept to the
 * server-held session identity. The single-use token is passed straight through from the URL — it
 * is never rendered, logged, or echoed in a result message. A bad/expired/mismatched token yields a
 * NEUTRAL failure (no-oracle).
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
      <Card variant="outline" className="team-note" style={{ marginTop: "var(--space-4)" }}>
        <p className="team-note__msg">
          This invite link is missing its code. Ask your team owner to resend the invite.
        </p>
      </Card>
    );
  }

  if (result?.ok) {
    return (
      <Card variant="outline" className="team-note" style={{ marginTop: "var(--space-4)" }}>
        <p className="team-note__msg">{result.message}</p>
        <p className="chrome-actions" style={{ marginTop: "var(--space-3)" }}>
          <Link href="/dashboard">Go to your dashboard →</Link>
        </p>
      </Card>
    );
  }

  return (
    <section className="team-section">
      <div className="chrome-actions">
        <Button variant="primary" loading={pending} aria-busy={pending} onClick={onAccept}>
          {pending ? "Joining…" : "Accept invite"}
        </Button>
      </div>
      <div aria-live="polite">
        {result && !result.ok ? (
          <Card variant="outline" className="team-note" style={{ marginTop: "var(--space-3)" }}>
            <p className="team-note__msg">{result.message}</p>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
