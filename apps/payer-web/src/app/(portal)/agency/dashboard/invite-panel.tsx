"use client";

import { useState, useTransition } from "react";
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
 * AGENCY INVITE panel (ADR-0022, LIVE).
 *
 * Runs in the BROWSER and sees NO secret. FACELESS: the ONLY input is an optional,
 * non-PII campaign tag — there is deliberately NO phone/name/email/CSV input (the agency
 * never types a contact, which would breach the faceless boundary + the consent gate).
 * The action binds to the server-held session payer (XB-A) and returns an OPAQUE
 * code/link to copy & share. Consent-first: a worker is only ever attributed AFTER they
 * self-onboard and accept consent (invariant #6) — minting a link does none of that.
 *
 * A mint-cap-reached OR a transient backend failure surfaces as the SAME neutral error
 * (no fake success, no leaked reason).
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
    <section className="section">
      <h2>Invite workers</h2>
      <div className="note">
        <strong>Consent-first.</strong> Share this link with workers. They must self-onboard and
        accept consent before BadaBhai processes their data — minting a link does not.
      </div>
      <p className="page-sub">
        Agencies never upload worker phone numbers or names here — workers join themselves and give
        their own consent. You only ever see consent-safe, aggregate progress.
      </p>

      <form className="form" onSubmit={handleCreate}>
        <div className="field">
          <label htmlFor="campaign">Campaign tag (optional)</label>
          <input
            id="campaign"
            className="input"
            placeholder="diwali-drive"
            value={campaign}
            aria-invalid={campaignError ? true : undefined}
            aria-describedby={campaignError ? "campaign-error" : undefined}
            onChange={(e) => {
              setCampaign(e.target.value);
              if (campaignError) setCampaignError(null);
            }}
          />
          {campaignError ? (
            <p className="error-text" id="campaign-error">
              {campaignError}
            </p>
          ) : null}
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            A short, non-identifying label to group invites. Never a phone, name, or email.
          </p>
        </div>

        <div className="btn-row">
          <button
            className="btn"
            type="submit"
            disabled={pending || tagError(campaign) !== null}
          >
            {pending ? "Creating…" : "Create invite link"}
          </button>
          <span className="badge badge-ok">Live</span>
        </div>
        <div aria-live="polite">{error ? <p className="error-text">{error}</p> : null}</div>
      </form>

      {invite ? (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="page-sub" style={{ margin: 0 }}>
            <strong>Invite created.</strong> Share this opaque link — it identifies no worker and
            carries no contact. Attribution happens only after the worker consents.
          </p>
          <dl className="dl">
            <dt>Code</dt>
            <dd className="mono">{invite.code}</dd>
            <dt>Link</dt>
            <dd className="mono">{invite.link}</dd>
          </dl>
          <div className="btn-row">
            <button className="btn secondary" type="button" onClick={() => copy(invite.link)}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
