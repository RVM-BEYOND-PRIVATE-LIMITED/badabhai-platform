"use client";

import { useState, useTransition } from "react";
import { looksLikeActionContextPii } from "@badabhai/validators";
import { Badge, Button, Card, Input } from "../../../../components/ds";
import { createInviteBatchAction } from "./batch-invite-actions";

/**
 * Client-side screens for the batch mint, mirroring `batch-invite-actions.ts`. The Server
 * Action + the backend DTO stay the AUTHORITY — these only reject bad input INLINE before
 * the round-trip, and they name the field, never echo the offending content.
 */
const TAG_MAX = 64; // parity with the action's campaignSchema.max(64)
const BATCH_MIN = 1; // parity with the action's countSchema
const BATCH_MAX = 50; // parity with the action's countSchema (the backend DTO is authoritative)

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
 * Runs in the BROWSER and sees NO secret. The mint form stays a native `<form>` so its
 * submit + `aria-live` error region remain reachable; the field, buttons and the opaque-code
 * result use DS primitives, with codes/links in mono tabular.
 */
export function AgencyBatchInvitePanel() {
  const [count, setCount] = useState("10");
  const [countError, setCountError] = useState<string | null>(null);
  const [campaign, setCampaign] = useState("");
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [invites, setInvites] = useState<{ code: string; link: string }[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
    const countErr = countValidationError(count);
    const tagErr = tagError(campaign);
    setCountError(countErr);
    setCampaignError(tagErr);
    if (countErr || tagErr) return;
    startTransition(async () => {
      const res = await createInviteBatchAction({
        // CARDINALITY ONLY — a number and an optional scalar tag. Never a list.
        count: Number(count.trim()),
        campaign: campaign.trim() || undefined,
      });
      if (res.ok) {
        setInvites(res.invites);
      } else {
        setInvites(null);
        setError(res.error);
      }
    });
  }

  async function copyAll(links: string[]) {
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (no secure context) — every link is shown to copy by hand.
      setCopied(false);
    }
  }

  const submitBlocked =
    pending || countValidationError(count) !== null || tagError(campaign) !== null;

  return (
    <section className="agency-section agency-batch">
      <h2 className="agency-section__title">Create several invite links at once</h2>
      <Card variant="flat" className="agency-invite__note">
        <strong>Each link is anonymous.</strong> A link is just a random code — it is not
        assigned to anyone and BadaBhai does not know who you give it to. The worker joins
        themselves and gives their own consent before any data is processed.
      </Card>
      <p className="agency-section__sub">
        Useful for a gate drive or a print run: generate up to {BATCH_MAX} links, then share
        or print them yourself. You never upload a worker&rsquo;s name, phone or number list
        here — BadaBhai sends nothing on your behalf.
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

        <div className="agency-invite__actions">
          <Button type="submit" disabled={submitBlocked} loading={pending}>
            {pending ? "Creating…" : "Create links"}
          </Button>
          <Badge tone="success" upper>
            Live
          </Badge>
        </div>
        <div aria-live="polite" className="agency-invite__status">
          {error ? <p className="agency-invite__error">{error}</p> : null}
        </div>
      </form>

      {invites && invites.length > 0 ? (
        <Card className="agency-batch__result">
          <p className="agency-section__sub">
            <strong>
              {invites.length} {invites.length === 1 ? "link" : "links"} created.
            </strong>{" "}
            Share or print them — each one identifies no worker and carries no contact.
            Attribution happens only after a worker joins and consents. If you want to note
            who you gave a link to, keep that note in your own records: BadaBhai must never
            hold it.
          </p>
          <ol className="agency-batch__list">
            {invites.map((invite) => (
              <li key={invite.code} className="agency-batch__item">
                <span className="agency-batch__code bb-mono">{invite.code}</span>
                <span className="bb-mono">{invite.link}</span>
              </li>
            ))}
          </ol>
          <div className="agency-invite__actions">
            <Button variant="secondary" onClick={() => copyAll(invites.map((i) => i.link))}>
              {copied ? "Copied" : "Copy all links"}
            </Button>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
