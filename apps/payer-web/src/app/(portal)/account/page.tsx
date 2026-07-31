import Link from "next/link";
import { requirePayer } from "../../../lib/auth";
import { Avatar, Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { AccountForm } from "./account-form";

export const dynamic = "force-dynamic";

/**
 * Account (PROF-2 read shell + PROF-4 edit) — the payer's OWN account.
 *
 * Reads the SERVER-HELD session ({@link requirePayer}, which already resolves GET /payer/me
 * server-side and redirects to /login if there is no session). Renders an identity header
 * (org display label + avatar), then the {@link AccountForm} which EDITS org name + contact
 * phone (email is read-only login identity; role/status are read-only display). All the
 * payer's OWN data, shown back to them only — NEVER worker PII; nothing here is logged or
 * eventized (invariant #2).
 *
 * If the session lacks its account fields (a verify-step session before /payer/me resolves),
 * a neutral retry Card renders instead of a blank page — mirroring the dashboard's resilience.
 */
export default async function AccountPage() {
  const session = await requirePayer();

  // The core identity field (email) is rollout-optional on the session. If it is missing the
  // /payer/me read hasn't populated this session yet — show a neutral retry, never a blank page.
  if (!session.email) {
    return (
      <>
        <h1 className="dash-title">Account</h1>
        <Card className="dash-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="dash-state__msg">
            We couldn&rsquo;t load your account details right now. Please retry shortly.
          </p>
          <RetryButton />
        </Card>
      </>
    );
  }

  return (
    <>
      <p className="account-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">Account</h1>
      <p className="dash-sub">Your organisation&rsquo;s details on BadaBhai.</p>

      <Card className="account-card">
        <div className="account-card__head">
          <Avatar name={session.displayLabel} size={52} brand />
          <div className="account-card__id">
            <span className="account-card__org">{session.displayLabel}</span>
            <span className="account-card__email bb-mono">{session.email}</span>
          </div>
        </div>
      </Card>

      <AccountForm
        orgName={session.displayLabel}
        email={session.email}
        phoneLast4={session.phoneLast4 ?? null}
        role={session.role}
        status={session.status}
      />

      {session.role === "agent" ? (
        <section className="account-section">
          <h2 className="account-section__title">KYC &amp; Bank Details</h2>
          <p className="account-section__sub">
            Identity verification and payout banking information for your agency.
          </p>
          <div className="account-section__cards">
            <Card className="account-stat" href="/agency/referrals" ariaLabel="KYC details — manage">
              <div className="account-stat__head">
                <span className="account-stat__label">KYC</span>
              </div>
              <div className="account-stat__value">PAN &amp; Identity</div>
              <div className="account-stat__foot">
                <Badge tone="warning" upper>Pending</Badge>
                <span className="account-stat__hint">Submit your KYC documents</span>
              </div>
            </Card>

            <Card className="account-stat" href="/agency/referrals" ariaLabel="Bank details — add">
              <div className="account-stat__head">
                <span className="account-stat__label">Bank Account</span>
              </div>
              <div className="account-stat__value">Not added</div>
              <div className="account-stat__foot">
                <Badge tone="neutral" upper>Not set</Badge>
                <span className="account-stat__hint">Add payout bank details</span>
              </div>
            </Card>
          </div>
        </section>
      ) : null}
    </>
  );
}
