"use client";

import { Fragment, useState, useTransition } from "react";
import { looksLikeActionContextPii } from "@badabhai/validators";
import { Badge, Button, Card, Input, SelectMenu } from "../../../../components/ds";
import { inviteContextSlugError } from "../../../../lib/invite-meta";
import {
  inviteShareMessage,
  shareableInviteUrl,
  whatsAppShareUrl,
} from "../../../../lib/invite-share";
import { createInviteBatchAction } from "./batch-invite-actions";

/**
 * Client-side screens for the batch mint, mirroring `batch-invite-actions.ts`. The Server
 * Action + the backend DTO stay the AUTHORITY — these only reject bad input INLINE before
 * the round-trip, and they name the field, never echo the offending content.
 */
const TAG_MAX = 64; // parity with the action's campaignSchema.max(64)
const BATCH_MIN = 1; // parity with the action's countSchema
const BATCH_MAX = 50; // parity with the action's countSchema (the backend DTO is authoritative)

/** Shown when `navigator.clipboard` is missing or refuses (no secure context, denied permission). */
const COPY_FAILED =
  "Could not copy the links automatically — the clipboard is not available here. Every link is written out in full below; select it and copy it by hand.";

/**
 * BATCH INVITE panel (ADR-0022 amendment) — mint up to 50 anonymous invite links at once.
 *
 * NOT THE PARKED "BULK INVITE UPLOAD". That module is DEAD BY DESIGN (consent violation):
 * it UPLOADS a list of real workers' contacts — an inbound assertion about people who never
 * consented. This panel is the opposite direction and has no referent: BadaBhai GENERATES N
 * opaque codes that denote nobody. The only things this form can send are a COUNT and one
 * optional non-PII tag shared by all N. There is deliberately NO name/phone/email field, NO
 * CSV, NO per-link label, and NO "send to" — if a per-link field ever appears here, the
 * input regains arity over people and this becomes bulk upload with a weaker identifier.
 *
 * Delivery is OUT-OF-BAND: the agency prints/shares the links itself. BadaBhai messages
 * nobody, because messaging would require the phone numbers this product refuses to hold.
 *
 * A cap-reached mint OR a transient backend failure surfaces as the SAME neutral error (no
 * fake success, no leaked reason). A partial batch is reported honestly — we render exactly
 * the links that came back, never the number that was asked for.
 *
 * MINTED CODES ARE IRRECOVERABLE ONCE DROPPED. Every link on screen is already written to
 * `agency_invites` and already charged against the hourly mint cap, and there is deliberately
 * NO per-invite readback endpoint — so this component is the ONLY place those strings exist.
 * A FAILED attempt therefore never clears a SUCCESSFUL one (mint 50, hit the cap on the next
 * try, and the 50 must still be on screen), the links stay recoverable BY HAND (each row is a
 * real focusable anchor, and a failed clipboard write reveals them written out in full), and
 * a clipboard failure is always SAID — never a silently unchanged button.
 *
 * Runs in the BROWSER and sees NO secret. The mint form stays a native `<form>` so its
 * submit + `aria-live` region remain reachable; that region announces the OUTCOME too
 * (validation message, mint failure, "N links created", copy failure), because every success
 * payload renders outside it and focus is never moved — a screen-reader user who mints 50
 * links would otherwise hear nothing. The field, buttons and the opaque-code result use DS
 * primitives, with codes/links in mono tabular.
 */
export function AgencyBatchInvitePanel() {
  const [count, setCount] = useState("10");
  const [countError, setCountError] = useState<string | null>(null);
  const [campaign, setCampaign] = useState("");
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ code: string; link: string }[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // NOTE: new state goes at the END — the unit tests seed state positionally by source order.
  const [copyError, setCopyError] = useState<string | null>(null);
  // W1 metadata — ONE medium and ONE context for the whole batch, never one per invite.
  // A per-invite field is exactly the arity-over-people this panel refuses to grow.
  const [medium, setMedium] = useState("");
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [contextError, setContextError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * The ABSOLUTE urls to share. The mint returns RELATIVE "/i/<code>" paths, and "Copy all
   * links" used to put those raw paths on the clipboard — fifty lines that resolve to
   * nothing once pasted anywhere but a portal tab. Falls back to the raw link only when no
   * origin can be established at all, so a link is never simply missing from the list.
   */
  const shareLinks = (invites ?? []).map((i) => ({
    code: i.code,
    url: shareableInviteUrl(i.link, process.env.NEXT_PUBLIC_SITE_URL) || i.link,
  }));

  /** Inline count screen: a whole number in [1, 50]. Blank / decimal / text are rejected. */
  function countValidationError(raw: string): string | null {
    const t = raw.trim();
    if (t === "") return `Enter how many links you need (${BATCH_MIN}–${BATCH_MAX}).`;
    if (!/^\d+$/.test(t)) return `Use a whole number between ${BATCH_MIN} and ${BATCH_MAX}.`;
    const n = Number(t);
    if (!Number.isInteger(n) || n < BATCH_MIN || n > BATCH_MAX) {
      return `Choose between ${BATCH_MIN} and ${BATCH_MAX} links at a time.`;
    }
    return null;
  }

  /** Inline tag screen: empty is fine (optional); a phone/email-like tag is rejected. */
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
    setCopyError(null);
    const countErr = countValidationError(count);
    const tagErr = tagError(campaign);
    const ctxErr = inviteContextSlugError("role", role) ?? inviteContextSlugError("city", city);
    setCountError(countErr);
    setCampaignError(tagErr);
    setContextError(ctxErr);
    if (countErr || tagErr || ctxErr) return;
    startTransition(async () => {
      const res = await createInviteBatchAction({
        // CARDINALITY ONLY — a number plus optional SCALAR metadata that applies to all N.
        // Never a list, and never one value per invite.
        count: Number(count.trim()),
        campaign: campaign.trim() || undefined,
        medium: medium || undefined,
        context:
          role.trim() || city.trim()
            ? { role: role.trim() || undefined, city: city.trim() || undefined }
            : undefined,
      });
      if (res.ok) {
        setInvites(res.invites);
      } else {
        // DO NOT clear `invites`. A failed attempt (cap reached, transient 5xx) says nothing
        // about the batch already on screen: those codes are minted, permanent, already
        // charged against the cap, and have no readback endpoint. Wiping them here destroyed
        // up to 50 live links with no way to get them back. Only the error changes.
        setError(res.error);
      }
    });
  }

  async function copyAll(links: string[]) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard is unavailable outside a secure context (and can be denied anywhere). A
      // silent no-op here left the staffer with live codes they could neither read in full
      // nor copy — so SAY it and write every link out untruncated below.
      setCopied(false);
      setCopyError(COPY_FAILED);
    }
  }

  // The submit stays enabled while invalid ON PURPOSE: disabling it also suppressed Enter
  // submission, so `handleCreate` never ran, `countError`/`campaignError` were never set, and
  // the inline messages below were unreachable — the button just greyed out with no reason
  // given. Submitting invalid input now names the problem inline AND announces it.
  const submitBlocked = pending;
  const validationMessage = [countError, campaignError].filter(Boolean).join(" ");

  return (
    <section className="agency-section agency-batch">
      <h2 className="agency-section__title">Create several invite links at once</h2>
      <Card variant="flat" className="agency-invite__note">
        <strong>Each link is anonymous.</strong> A link is just a random code — it is not assigned
        to anyone and BadaBhai does not know who you give it to. The worker joins themselves and
        gives their own consent before any data is processed.
      </Card>
      <p className="agency-section__sub">
        Useful for a gate drive or a print run: generate up to {BATCH_MAX} links, then share or
        print them yourself. You never upload a worker&rsquo;s name, phone or number list here —
        BadaBhai sends nothing on your behalf.
      </p>

      <form className="agency-batch__form" onSubmit={handleCreate}>
        <div className="agency-batch__count">
          <Input
            id="batch-count"
            label="How many links"
            type="number"
            inputMode="numeric"
            min={BATCH_MIN}
            max={BATCH_MAX}
            step={1}
            value={count}
            error={countError ?? undefined}
            aria-invalid={countError ? true : undefined}
            hint={`Between ${BATCH_MIN} and ${BATCH_MAX} at a time.`}
            onChange={(e) => {
              setCount(e.target.value);
              if (countError) setCountError(null);
            }}
          />
        </div>

        <Input
          id="batch-campaign"
          label="Campaign tag"
          optional
          placeholder="pune-gate-2"
          value={campaign}
          error={campaignError ?? undefined}
          aria-invalid={campaignError ? true : undefined}
          hint="One label for the whole batch, to group these invites. Never a phone, name, or email."
          onChange={(e) => {
            setCampaign(e.target.value);
            if (campaignError) setCampaignError(null);
          }}
        />

        {/*
          LINK METADATA (W1) — ONE value each, applied to the whole batch. Referent-free by
          construction: a channel and a job shape, never a person. Per-invite variants are
          deliberately absent (see the note on the action).
        */}
        <SelectMenu
          id="batch-medium"
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
          id="batch-role"
          label="Role slug"
          optional
          placeholder="welder"
          value={role}
          error={contextError && role.trim() ? contextError : undefined}
          hint="What these links advertise, as a lowercase slug. Never a person's name."
          onChange={(e) => {
            setRole(e.target.value);
            if (contextError) setContextError(null);
          }}
        />
        <Input
          id="batch-city"
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
          <Button type="submit" disabled={submitBlocked} loading={pending}>
            {pending ? "Creating…" : "Create links"}
          </Button>
          <Badge tone="success" upper>
            Live
          </Badge>
        </div>
        {/*
          THE ONE ANNOUNCED REGION. It carries every outcome, not just failure: the mint
          result list renders outside the form and focus never moves, so a success that is
          not announced here is silent to a screen reader.
        */}
        <div aria-live="polite" className="agency-invite__status">
          {validationMessage ? <p className="agency-invite__error">{validationMessage}</p> : null}
          {error ? (
            <p className="agency-invite__error">
              {error}
              {invites && invites.length > 0
                ? " The links already created are still listed below and are still valid."
                : ""}
            </p>
          ) : null}
          {copyError ? <p className="agency-invite__error">{copyError}</p> : null}
          {!error && invites && invites.length > 0 ? (
            <p className="agency-section__sub">
              {invites.length} {invites.length === 1 ? "link" : "links"} created and listed below.
              {copied ? " All links copied to the clipboard." : ""}
            </p>
          ) : null}
        </div>
      </form>

      {invites && invites.length > 0 ? (
        <Card className="agency-batch__result">
          <p className="agency-section__sub">
            <strong>
              {invites.length} {invites.length === 1 ? "link" : "links"} created.
            </strong>{" "}
            Share or print them — each one identifies no worker and carries no contact. Attribution
            happens only after a worker joins and consents. If you want to note who you gave a link
            to, keep that note in your own records: BadaBhai must never hold it.
          </p>
          <ol className="agency-batch__list">
            {shareLinks.map((invite) => (
              <li key={invite.code} className="agency-batch__item">
                <span className="agency-batch__code bb-mono">{invite.code}</span>
                {/*
                  A real anchor, not a <span>: the row is CSS-truncated to an ellipsis, so a
                  non-focusable span left the link unreachable by keyboard and un-copyable
                  without the clipboard. The href carries the FULL url (open / copy address /
                  read by a screen reader) even when the visible text is clipped.
                */}
                <a className="bb-mono" href={invite.url}>
                  {invite.url}
                </a>
                {/*
                  PER-ROW, deliberately. A batch is minted so each link can go to a
                  DIFFERENT worker, so the useful WhatsApp action is "send this one", not
                  one message carrying fifty links. Still no recipient stored anywhere: the
                  contact is picked inside WhatsApp and never returns to us.
                */}
                <a
                  className="agency-batch__share"
                  href={whatsAppShareUrl(inviteShareMessage(invite.url))}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Send invite ${invite.code} on WhatsApp`}
                >
                  WhatsApp
                </a>
              </li>
            ))}
          </ol>
          <div className="agency-invite__actions">
            <Button variant="secondary" onClick={() => copyAll(shareLinks.map((i) => i.url))}>
              {copied ? "Copied" : "Copy all links"}
            </Button>
          </div>
          {copyError ? (
            <div className="agency-invite__result">
              <p className="agency-invite__error">{COPY_FAILED}</p>
              {/* The single-mint fallback shape: `.agency-invite__dl dd` wraps (break-all),
                  so every url is readable in full and transcribable by hand. */}
              <dl className="agency-invite__dl">
                {shareLinks.map((invite) => (
                  <Fragment key={invite.code}>
                    <dt className="bb-mono">{invite.code}</dt>
                    <dd className="bb-mono">{invite.url}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}
