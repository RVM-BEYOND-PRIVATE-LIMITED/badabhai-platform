"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Input } from "../../../../components/ds";
import { createInviteAction } from "./invite-actions";

/**
 * Client-side PII screen for the campaign tag (C11), mirroring `campaignSchema`'s
 * PHONE_OR_EMAIL in invite-actions.ts. The Server Action + backend DTO stay the AUTHORITY —
 * this only rejects a phone-like / email-like tag INLINE before the round-trip. It names the
 * field, never the offending content (no echo).
 */
const PHONE_OR_EMAIL = /(\+?\d[\d\s-]{7,}\d)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const TAG_MAX = 64; // parity with campaignSchema.max(64)

/**
 * AGENCY INVITE panel (ADR-0022, LIVE) — DS3.1 re-skin onto the BadaBhai Design System
 * (VISUAL layer only).
 *
 * Runs in the BROWSER and sees NO secret. FACELESS: the ONLY input is an optional,
 * non-PII campaign tag — there is deliberately NO phone/name/email/CSV input (the agency
 * never types a contact, which would breach the faceless boundary + the consent gate).
 * The action binds to the server-held session payer (XB-A) and returns an OPAQUE
 * code/link to copy & share. Consent-first: a worker is only ever attributed AFTER they
 * self-onboard and accept consent (invariant #6) — minting a link does none of that.
 *
 * A mint-cap-reached OR a transient backend failure surfaces as the SAME neutral error
 * (no fake success, no leaked reason). The mint form stays a native `<form>` (so its
 * submit + aria-live error region remain reachable); only the field + buttons + the
 * opaque-code result move to DS primitives. The opaque code/link render in mono tabular.
 */
export function AgencyInvitePanel() {
  const [campaign, setCampaign] = useState("");
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ code: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /** Inline tag screen (C11): empty is fine (optional); a phone/email-like tag is rejected. */
  function tagError(raw: string): string | null {
    const t = raw.trim();
    if (t === "") return null;
    if (t.length > TAG_MAX) return "The campaign tag is too long.";
    if (PHONE_OR_EMAIL.test(t))
      return "The campaign tag must be a non-PII label — remove any phone or email.";
    return null;
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    const tagErr = tagError(campaign);
    setCampaignError(tagErr);
    if (tagErr) return;
    startTransition(async () => {
      const res = await createInviteAction({ campaign: campaign.trim() || undefined });
      if (res.ok) {
        setInvite({ code: res.code, link: res.link });
      } else {
        setInvite(null);
        setError(res.error);
      }
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (no secure context) — the code is shown to copy by hand.
      setCopied(false);
    }
  }

  return (
    <section className="agency-section">
      <h2 className="agency-section__title">Invite workers</h2>
      <Card variant="flat" className="agency-invite__note">
        <strong>Consent-first.</strong> Share this link with workers. They must self-onboard and
        accept consent before BadaBhai processes their data — minting a link does not.
      </Card>
      <p className="agency-section__sub">
        Agencies never upload worker phone numbers or names here — workers join themselves and give
        their own consent. You only ever see consent-safe, aggregate progress.
      </p>

      <form className="agency-invite__form" onSubmit={handleCreate}>
        <Input
          id="campaign"
          label="Campaign tag"
          optional
          placeholder="diwali-drive"
          value={campaign}
          error={campaignError ?? undefined}
          aria-invalid={campaignError ? true : undefined}
          hint="A short, non-identifying label to group invites. Never a phone, name, or email."
          onChange={(e) => {
            setCampaign(e.target.value);
            if (campaignError) setCampaignError(null);
          }}
        />

        <div className="agency-invite__actions">
          <Button type="submit" disabled={pending || tagError(campaign) !== null} loading={pending}>
            {pending ? "Creating…" : "Create invite link"}
          </Button>
          <Badge tone="success" upper>
            Live
          </Badge>
        </div>
        <div aria-live="polite" className="agency-invite__status">
          {error ? <p className="agency-invite__error">{error}</p> : null}
        </div>
      </form>

      {invite ? (
        <Card className="agency-invite__result">
          <p className="agency-section__sub">
            <strong>Invite created.</strong> Share this opaque link — it identifies no worker and
            carries no contact. Attribution happens only after the worker consents.
          </p>
          <dl className="agency-invite__dl">
            <dt>Code</dt>
            <dd className="bb-mono">{invite.code}</dd>
            <dt>Link</dt>
            <dd className="bb-mono">{invite.link}</dd>
          </dl>
          <div className="agency-invite__actions">
            <Button variant="secondary" onClick={() => copy(invite.link)}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
