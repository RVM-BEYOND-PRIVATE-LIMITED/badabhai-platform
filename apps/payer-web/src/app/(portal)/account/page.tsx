import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { agencyFlags } from "../../../lib/config";
import { getAgencyKyc } from "../../../lib/payer-api";
import { maskLast4 } from "../../../lib/masking";
import type { AgencyKyc } from "../../../lib/contracts";
import { Avatar, Badge, Card } from "../../../components/ds";
import { PageHeader } from "../../../components/page-header";
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
 * a neutral retry state renders instead of a blank page — mirroring the dashboard's resilience.
 *
 * UI-1: composed from the shared page spine (page-back / page-head / panel / kv / alert /
 * state). The identity block has no bespoke card of its own any more — it is a `panel` whose
 * head carries the avatar and whose body is the `kv` description list.
 *
 * The account menu's item and this page's H1 are both "Account" (a top-level page reached from
 * that menu, so its header has no back link).
 *
 * AGENCY KYC (agent role only): the Payout details (KYC) card reads the caller's OWN masked
 * status via {@link getAgencyKyc}. `null` (supply payouts not switched on → 404, or a
 * transient read failure) HIDES the card entirely rather than showing a fake "Pending". A real
 * status drives
 * the tone/label and shows only the masked PAN / bank last-4 the API returns — the agency's
 * OWN data, never a raw document, never worker PII. The card's actions open Referrals, where
 * KYC is managed — an agency page behind the agency-portal flag — so with that flag off the
 * card is not shown (and not read): its buttons would lead to a 404.
 */
export default async function AccountPage() {
  const session = await requirePayer();

  // The core identity field (email) is rollout-optional on the session. If it is missing the
  // /payer/me read hasn't populated this session yet — show a neutral retry, never a blank page.
  if (!session.email) {
    return (
      <div className="account-page">
        <PageHeader title="Account" description={ACCOUNT_DESCRIPTION} />
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
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
      </div>
    );
  }

  // Agency-only: read the caller's OWN masked KYC status. `null` = not enabled (404) or a
  // transient failure → the KYC card is HIDDEN, never faked. Isolated so a KYC read failure
  // can never blank the account page.
  let agencyKyc: AgencyKyc | null = null;
  if (session.role === "agent" && agencyFlags().agencyPortalEnabled) {
    try {
      agencyKyc = await getAgencyKyc();
    } catch {
      agencyKyc = null;
    }
  }

  // `.account-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  return (
    <div className="account-page">
      <PageHeader title="Account" description={ACCOUNT_DESCRIPTION} />

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
          <div className="panel__text">
            <h2 className="panel__title">Your details</h2>
            <p className="panel__sub">
              Change your organisation name or contact number. Your login email stays as it is.
            </p>
          </div>
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

      {session.role === "agent" && agencyKyc ? <AgencyKycCard kyc={agencyKyc} /> : null}
    </div>
  );
}

const ACCOUNT_DESCRIPTION = "Your organisation’s details on BadaBhai.";

/**
 * Per-status presentation for the KYC/PAN row: the alert tone modifier + the status Badge
 * tone + its short label. Kept as a closed map (never a computed class) so every status has a
 * deliberate, reviewed appearance. `not_submitted` is a neutral prompt, `pending` a warning,
 * `verified` green, `rejected` a danger band.
 */
const KYC_PRESENTATION: Record<
  AgencyKyc["status"],
  { alert: string; tone: "neutral" | "warning" | "success" | "danger"; label: string }
> = {
  not_submitted: { alert: "alert", tone: "neutral", label: "Not submitted" },
  pending: { alert: "alert alert--warning", tone: "warning", label: "Pending" },
  verified: { alert: "alert alert--success", tone: "success", label: "Verified" },
  rejected: { alert: "alert alert--danger", tone: "danger", label: "Rejected" },
};

/**
 * The agency Payout details (KYC) card, driven by the REAL masked status. A plain (non-async)
 * function component — the caller has already resolved (and non-null-guarded) the KYC read, so
 * this only maps status → appearance. Shows only the masked PAN / bank last-4 the API returns
 * (`••••234F`); the reject reason surfaces verbatim when rejected. Both rows keep their
 * Manage/Add link to the full KYC surface (/agency/referrals) — and SAY so ("Manage in
 * Referrals"): two buttons labelled "Manage" side by side did not tell a payer where either went.
 */
function AgencyKycCard({ kyc }: { kyc: AgencyKyc }) {
  const view = KYC_PRESENTATION[kyc.status];
  const bankAdded = (kyc.bankLast4 ?? "").trim().length > 0;

  const kycBody =
    kyc.status === "verified"
      ? `PAN ${maskLast4(kyc.panLast4)}`
      : kyc.status === "pending"
        ? "Your documents are being reviewed."
        : kyc.status === "rejected"
          ? (kyc.rejectReason ?? "Your details couldn't be verified. Please resubmit.")
          : "Submit your KYC documents.";

  return (
    <section className="section">
      <div className="section__head">
        <div className="section__text">
          <h2 className="section__title">Payout details (KYC)</h2>
          <p className="section__sub">
            Identity verification and payout banking information for your agency.
          </p>
        </div>
      </div>

      {/* Both rows keep a visible, named action (not an invisible stretched link) to the full
          KYC surface. The status Badge + masked last-4 come straight from the API. */}
      <div className={view.alert}>
        <Icon name="identification-card" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__title">
            KYC &mdash; PAN &amp; Identity{" "}
            <Badge tone={view.tone} upper>
              {view.label}
            </Badge>
          </p>
          <p className="alert__body">{kycBody}</p>
        </div>
        <div className="alert__actions">
          <Link
            className="bb-btn bb-btn--secondary bb-btn--sm"
            href="/agency/referrals"
            aria-label="Manage in Referrals — KYC details"
          >
            <Icon name={ACTION_ICON.edit} />
            <span>Manage in Referrals</span>
          </Link>
        </div>
      </div>

      <div className={bankAdded ? "alert alert--success" : "alert"}>
        <Icon name="bank" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__title">
            Bank account{" "}
            {bankAdded ? (
              <Badge tone="success" upper>
                Added
              </Badge>
            ) : (
              <Badge tone="neutral" upper>
                Not set
              </Badge>
            )}
          </p>
          <p className="alert__body">
            {bankAdded ? (
              <span className="bb-mono">{maskLast4(kyc.bankLast4)}</span>
            ) : (
              "Add payout bank details."
            )}
          </p>
        </div>
        <div className="alert__actions">
          <Link
            className="bb-btn bb-btn--secondary bb-btn--sm"
            href="/agency/referrals"
            aria-label={
              bankAdded ? "Manage in Referrals — bank details" : "Add in Referrals — bank details"
            }
          >
            <Icon name={bankAdded ? ACTION_ICON.edit : ACTION_ICON.add} />
            <span>{bankAdded ? "Manage in Referrals" : "Add in Referrals"}</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
