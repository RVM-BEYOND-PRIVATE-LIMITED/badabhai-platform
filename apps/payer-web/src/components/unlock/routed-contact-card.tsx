/**
 * Shared unlock→reveal CARDS (DS1.5) — the routed-contact + masked-resume reveal surfaces,
 * extracted VERBATIM from the applicant feed so every payer surface renders ONE implementation.
 *
 * SHARED (no "use client"): purely presentational — no hooks, no handlers, no network. The caller
 * passes the already-mapped, PII-free view (from lib/unlock-view). Style is DS Card + tokens only.
 *
 * FACELESS / ADR-0010 F-4: there is deliberately NO field here that could show a phone or a number.
 * `ContactView`/`RevealView` carry neither, so a raw phone is a COMPILE error, not a review miss —
 * the routed artifact is an opaque, expiring relay; the masked resume is initials + a link only.
 */
import type { ContactView, RevealView } from "../../lib/unlock-view";
import { Card } from "../ds";

/** Format an ISO timestamp as YYYY-MM-DD (no time component reaches the DOM). */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * Renders the LIVE reveal: a ROUTED relay handle ONLY (ADR-0010 F-4). There is NO
 * field here that could show a phone or a number — the artifact is an opaque, expiring
 * relay; the raw contact stays server-side and is never sent to the browser.
 */
export function RoutedContactCard({ view }: { view: Extract<ContactView, { kind: "routed" }> }) {
  return (
    <Card variant="flat" padding="sm" className="reveal-card">
      <p className="reveal-card__lead">
        <strong>Routed contact.</strong> This is an opaque relay —{" "}
        <strong>not a phone number</strong>. Use it in-app to reach the candidate; it expires with
        your access window.
      </p>
      <dl className="reveal-card__dl">
        <dt>Relay handle</dt>
        <dd className="bb-mono">{view.relayHandle}</dd>
        <dt>Channel</dt>
        <dd>{view.channel === "in_app_relay" ? "In-app relay" : "Proxy number"}</dd>
        <dt>Access until</dt>
        <dd className="bb-mono">{day(view.expiresAt)}</dd>
      </dl>
    </Card>
  );
}

/**
 * WAITING (mock) masked-resume preview (XB-E): masked initials + a link + NO phone.
 * There is no field here that could show a raw name or phone — the artifact carries
 * neither. Flagged as a preview until a payer-authed disclosure endpoint lands.
 */
export function MaskedResumeCard({ view }: { view: Extract<RevealView, { kind: "masked" }> }) {
  return (
    <Card variant="flat" padding="sm" className="reveal-card">
      <p className="reveal-card__lead">
        <strong>Masked resume (preview).</strong> Identity is masked —{" "}
        <strong>no phone, no full name</strong> is shown.
      </p>
      <dl className="reveal-card__dl">
        <dt>Candidate</dt>
        <dd className="bb-mono">{view.displayInitials}</dd>
        <dt>Resume</dt>
        <dd>
          <a href={view.resumeUrl} target="_blank" rel="noopener noreferrer">
            Open masked resume (PDF) →
          </a>
        </dd>
        <dt>Access until</dt>
        <dd className="bb-mono">{day(view.expiresAt)}</dd>
      </dl>
    </Card>
  );
}
