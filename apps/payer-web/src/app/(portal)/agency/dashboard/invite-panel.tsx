"use client";

import { useState, useTransition } from "react";
import { looksLikeActionContextPii } from "@badabhai/validators";
import { Badge, Button, Card, Input, SelectMenu } from "../../../../components/ds";
import { inviteContextSlugError } from "../../../../lib/invite-meta";
import {
  inviteShareMessage,
  shareableInviteUrl,
  whatsAppShareUrl,
} from "../../../../lib/invite-share";
import { createInviteAction } from "./invite-actions";

/**
 * Client-side PII screen for the campaign tag (C11), using the SAME `looksLikeActionContextPii`
 * helper as `campaignSchema` in invite-actions.ts and the backend DTO — not a local regex copy.
 * The Server Action + backend DTO stay the AUTHORITY; this only rejects INLINE before the
 * round-trip. It names the field, never the offending content (no echo).
 *
 * The regex this replaces mirrored `looksLikePii` (email + digit runs only), so a worker's
 * NAME passed — and the tag reaches the `agency_invite.created` payload, an invariant-#2 sink.
 * Three copies of that regex existed across the two mint panels and their actions; sharing one
 * helper is what stops the screens drifting apart again.
 */
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
  // NOTE: new state goes at the END — the unit tests seed state positionally by source
  // order (the same convention batch-invite-panel.tsx documents). Inserting above would
  // silently re-map every existing seed onto the wrong hook.
  //
  // W1 metadata. `medium` selects which click→install match window this link is judged
  // against (organic 168h vs paid 24h); `role`/`city` are the non-PII deep-link context.
  const [medium, setMedium] = useState("");
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [contextError, setContextError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * The ABSOLUTE url to share. The mint returns a RELATIVE "/i/<code>" (the API cannot know
   * which host the portal is served from), and this panel used to copy that path verbatim —
   * so an agent pasting into WhatsApp sent "/i/abc123", which resolves to nothing outside a
   * tab already on the portal. Every share affordance below uses THIS, never `invite.link`.
   */
  const shareUrl = invite ? shareableInviteUrl(invite.link, process.env.NEXT_PUBLIC_SITE_URL) : "";

  /** Inline tag screen (C11): empty is fine (optional); a name/phone/email-like tag is rejected. */
  function tagError(raw: string): string | null {
    const t = raw.trim();
    if (t === "") return null;
    if (t.length > TAG_MAX) return "The campaign tag is too long.";
    if (looksLikeActionContextPii(t))
      return "The campaign tag must be a non-PII label — use a short slug like diwali-drive, never a person's name, phone, or email.";
    return null;
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    const tagErr = tagError(campaign);
    setCampaignError(tagErr);
    // Both context fields are screened, and the FIRST failure is reported — reporting only
    // `role` while `city` is also wrong would send the agent round the loop twice.
    const ctxErr = inviteContextSlugError("role", role) ?? inviteContextSlugError("city", city);
    setContextError(ctxErr);
    if (tagErr || ctxErr) return;
    startTransition(async () => {
      const res = await createInviteAction({
        campaign: campaign.trim() || undefined,
        medium: medium || undefined,
        context:
          role.trim() || city.trim()
            ? { role: role.trim() || undefined, city: city.trim() || undefined }
            : undefined,
      });
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
          hint="A short slug to group invites, like diwali-drive. Never a phone, name, or email."
          onChange={(e) => {
            setCampaign(e.target.value);
            if (campaignError) setCampaignError(null);
          }}
        />

        {/*
          LINK METADATA (W1). Both are REFERENT-FREE and that is why they may exist on a
          faceless surface at all: `medium` describes the CHANNEL the link travels on, and
          role/city describe the JOB SHAPE it advertises. Neither can denote a person, and
          there is still no phone/name/email/recipient field anywhere on this panel.
        */}
        <SelectMenu
          id="medium"
          label="Link type"
          optional
          value={medium}
          placeholder="Organic (default)"
          hint="Paid links are matched against a shorter 24-hour install window; organic gets 7 days."
          options={[
            { value: "organic", label: "Organic — shared by hand" },
            { value: "paid", label: "Paid — an ad or promoted post" },
          ]}
          onChange={setMedium}
        />
        <Input
          id="role"
          label="Role slug"
          optional
          placeholder="welder"
          value={role}
          error={contextError && role.trim() ? contextError : undefined}
          hint="What this link is advertising, as a lowercase slug. Never a person's name."
          onChange={(e) => {
            setRole(e.target.value);
            if (contextError) setContextError(null);
          }}
        />
        <Input
          id="city"
          label="City slug"
          optional
          placeholder="pune-west"
          value={city}
          error={contextError && !role.trim() ? contextError : undefined}
          hint="Where the work is, as a lowercase slug."
          onChange={(e) => {
            setCity(e.target.value);
            if (contextError) setContextError(null);
          }}
        />

        <div className="agency-invite__actions">
          {/* Enabled while the tag is invalid ON PURPOSE: disabling the submit also blocked
              Enter, so `handleCreate` never ran and `campaignError` — the only thing that
              renders the reason — was never set. The button just greyed out silently. */}
          <Button type="submit" disabled={pending} loading={pending}>
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
            {/* The ABSOLUTE url — what is shown must be exactly what gets copied and sent,
                or an agent reading it off the screen types a path that goes nowhere. */}
            <dd className="bb-mono">{shareUrl || invite.link}</dd>
          </dl>
          <div className="agency-invite__actions">
            <Button variant="secondary" onClick={() => copy(shareUrl || invite.link)}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            {/*
              A real WhatsApp hand-off: `wa.me` with no number opens the CONTACT PICKER with
              the message pre-filled, so the agent chooses the recipient. It needs no
              WhatsApp Business number — this is a client-side hand-off to the agent's own
              WhatsApp, not a platform-sent message. Rendered only once an absolute url
              exists, because a wa.me carrying "/i/abc" would send a dead link.
            */}
            {shareUrl ? (
              <a
                className="bb-btn bb-btn--secondary"
                href={whatsAppShareUrl(inviteShareMessage(shareUrl))}
                target="_blank"
                rel="noopener noreferrer"
              >
                Send on WhatsApp
              </a>
            ) : null}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
