import Link from "next/link";
import { requirePayer } from "../../../lib/auth";
import { Avatar, Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { AccountForm } from "../account/account-form";

export const dynamic = "force-dynamic";

/**
 * Profile — the /profile door onto the payer's OWN account screen. It renders the very same
 * {@link AccountForm} as /account (see nav-model.ts §3: /account is the advertised route;
 * /profile KEEPS WORKING and is deliberately not removed, only no longer shown twice in the
 * nav). Same data, same server-held session, same faceless invariant — no worker PII.
 *
 * UI-1: composed from the shared page spine (page-back / page-head / panel / kv / alert /
 * state), identical to /account so the two doors do not drift apart visually.
 */
export default async function ProfilePage() {
  const session = await requirePayer();

  if (!session.email) {
    return (
      <>
        <div className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">Profile</h1>
            <p className="page-head__sub">
              Your organisation&rsquo;s name, contact, and verification details.
            </p>
          </div>
        </div>
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            {/* Neutral, account-state-independent copy: it never says WHY the read failed. */}
            <h2 className="state__title">Service unavailable</h2>
            <p className="state__body">
              We couldn&rsquo;t load your profile right now. Nothing has changed &mdash; please
              retry shortly.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Profile</h1>
          <p className="page-head__sub">
            Your organisation&rsquo;s name, contact, and verification details.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Signed in as</h2>
          <div className="panel__actions">
            <Avatar name={session.displayLabel} size={52} brand />
          </div>
        </div>
        <div className="panel__body">
          <dl className="kv">
            <dt className="kv__k">Organisation</dt>
            <dd className="kv__v">{session.displayLabel}</dd>
            <dt className="kv__k">Account email</dt>
            <dd className="kv__v bb-mono">{session.email}</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Your details</h2>
          <p className="panel__sub">
            Change your organisation name or contact number. Your login email stays as it is.
          </p>
        </div>
        <div className="panel__body">
          <AccountForm
            orgName={session.displayLabel}
            email={session.email}
            phoneLast4={session.phoneLast4 ?? null}
            role={session.role}
            status={session.status}
          />
        </div>
      </section>

      {session.role === "agent" ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">KYC &amp; Bank Details</h2>
            <p className="section__sub">
              Identity verification and payout banking information for your agency.
            </p>
          </div>

          {/* Both rows were whole-card links to the SAME destination with an aria-label doing
              the naming; as `alert` bands the destination is unchanged but the action is a
              visible, named control instead of an invisible stretched link. */}
          <div className="alert alert--warning">
            <i className="ph ph-identification-card alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">
                KYC &mdash; PAN &amp; Identity{" "}
                <Badge tone="warning" upper>
                  Pending
                </Badge>
              </p>
              <p className="alert__body">Submit your KYC documents.</p>
            </div>
            <div className="alert__actions">
              <Link
                className="bb-btn bb-btn--secondary bb-btn--sm"
                href="/agency/referrals"
                aria-label="KYC details — manage"
              >
                Manage
              </Link>
            </div>
          </div>

          <div className="alert">
            <i className="ph ph-bank alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">
                Bank Account &mdash; not added{" "}
                <Badge tone="neutral" upper>
                  Not set
                </Badge>
              </p>
              <p className="alert__body">Add payout bank details.</p>
            </div>
            <div className="alert__actions">
              <Link
                className="bb-btn bb-btn--secondary bb-btn--sm"
                href="/agency/referrals"
                aria-label="Bank details — add"
              >
                Add
              </Link>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
