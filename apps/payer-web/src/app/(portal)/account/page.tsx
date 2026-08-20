import Link from "next/link";
import { requirePayer } from "../../../lib/auth";
import { getAgencyKyc } from "../../../lib/payer-api";
import type { AgencyKyc } from "../../../lib/contracts";
import { maskLast4 } from "../../../lib/masking";
import { Avatar, Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { AccountForm } from "./account-form";

type BadgeTone = "neutral" | "brand" | "success" | "danger" | "warning" | "info";

/** Real KYC status → the card's badge tone + label + one-line body. */
function kycView(kyc: AgencyKyc): { tone: BadgeTone; label: string; body: string } {
  switch (kyc.status) {
    case "verified":
      return {
        tone: "success",
        label: "Verified",
        body: `PAN ${maskLast4(kyc.panLast4)} verified.`,
      };
    case "pending":
      return {
        tone: "warning",
        label: "Under review",
        body: "Your documents are being reviewed.",
      };
    case "rejected":
      return {
        tone: "danger",
        label: "Rejected",
        body: kyc.rejectReason ?? "Please resubmit your documents.",
      };
    case "not_submitted":
    default:
      return { tone: "neutral", label: "Not submitted", body: "Submit your KYC documents." };
  }
}

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
 * a neutral retry state renders instead of a blank page — mirroring the dashboard's resilience.
 *
 * UI-1: composed from the shared page spine (page-back / page-head / panel / kv / alert /
 * state). The identity block has no bespoke card of its own any more — it is a `panel` whose
 * head carries the avatar and whose body is the `kv` description list.
 */
export default async function AccountPage() {
  const session = await requirePayer();

  // The core identity field (email) is rollout-optional on the session. If it is missing the
  // /payer/me read hasn't populated this session yet — show a neutral retry, never a blank page.
  if (!session.email) {
    return (
      <>
        <div className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">Account</h1>
            <p className="page-head__sub">Your organisation&rsquo;s details on BadaBhai.</p>
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
              We couldn&rsquo;t load your account details right now. Nothing has changed &mdash;
              please retry shortly.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      </>
    );
  }

  // Agent-only, LIVE KYC status. `getAgencyKyc` maps the gated 404 to null (the
  // payouts flag is off), so a null result HIDES the card rather than showing a
  // permanent, misleading "Pending" (#1011).
  const kyc: AgencyKyc | null = session.role === "agent" ? await getAgencyKyc() : null;

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Account</h1>
          <p className="page-head__sub">Your organisation&rsquo;s details on BadaBhai.</p>
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

      {kyc ? (
        (() => {
          const view = kycView(kyc);
          const bankAdded = Boolean(kyc.bankLast4 && kyc.bankLast4.length > 0);
          return (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">KYC &amp; Bank Details</h2>
                <p className="section__sub">
                  Identity verification and payout banking information for your agency.
                </p>
              </div>

              <div className={`alert${view.tone === "warning" ? " alert--warning" : ""}`}>
                <i className="ph ph-identification-card alert__icon" aria-hidden="true" />
                <div className="alert__text">
                  <p className="alert__title">
                    KYC &mdash; PAN &amp; Identity{" "}
                    <Badge tone={view.tone} upper>
                      {view.label}
                    </Badge>
                  </p>
                  <p className="alert__body">{view.body}</p>
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
                    Bank Account &mdash; {bankAdded ? maskLast4(kyc.bankLast4) : "not added"}{" "}
                    <Badge tone={bankAdded ? "success" : "neutral"} upper>
                      {bankAdded ? "Added" : "Not set"}
                    </Badge>
                  </p>
                  <p className="alert__body">
                    {bankAdded ? "Payout bank details on file." : "Add payout bank details."}
                  </p>
                </div>
                <div className="alert__actions">
                  <Link
                    className="bb-btn bb-btn--secondary bb-btn--sm"
                    href="/agency/referrals"
                    aria-label={bankAdded ? "Bank details — manage" : "Bank details — add"}
                  >
                    {bankAdded ? "Manage" : "Add"}
                  </Link>
                </div>
              </div>
            </section>
          );
        })()
      ) : null}
    </>
  );
}
