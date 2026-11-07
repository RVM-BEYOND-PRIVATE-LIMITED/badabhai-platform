import type { ReactNode } from "react";
import Link from "next/link";
import type { CompanyDetail } from "../lib/companies";
import type { AdminPaymentHistory } from "../lib/payment-history";
import type { CreditsView, JobPostingListItem } from "../lib/entities";
import type { EntityTimeline } from "../lib/events";
import { displayName, identityPosture, NAME_UNREADABLE } from "../lib/identity";
import { COMPANY_AGENCY_TYPE_LABELS, COMPANY_KIND_LABELS } from "../lib/company-vocabulary";
import { formatCount, formatDate, shortId, timestampTitle } from "../lib/format";
import { customerHref } from "../lib/customer";
import { PageHeader } from "./page-header";
import { DetailList } from "./detail-list";
import { StatusPill } from "./status-pill";
import { IdentityCapNotice } from "./identity-notice";
import { CopyId } from "./copy-id";
import { CompanyTabs, type CompanyTabValue } from "./company-tabs";
import { CompanyHeaderActions } from "./company-header-actions";
import { CompanyPostingsTab } from "./company-postings-tab";
import { CompanyPaymentHistoryTab } from "./company-payment-history-tab";
import { CompanyCreditsTab } from "./company-credits-tab";
import { CompanyUsersTab } from "./company-users-tab";
import { CompanyTimelineTab } from "./company-timeline-tab";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export type CompanyTab = "overview" | "postings" | "payments" | "credits" | "users" | "timeline";

export interface CompanyDetailViewProps {
  company: CompanyDetail;
  /** The first page of the payment timeline (also the header's balance source). */
  paymentHistory: AdminPaymentHistory | null;
  /** `undefined` = not the active tab; `null` = the read failed. */
  postings?: JobPostingListItem[] | null;
  credits?: CreditsView | null;
  timeline?: EntityTimeline | null;
  timelineRefused: boolean;
  timelineFailed: boolean;
  activeTab: CompanyTab;
  basePath: string;
  mayReadEvents: boolean;
  mayManageCompanies: boolean;
  mayManagePostings: boolean;
  maySuspend: boolean;
  mayGrantCredits: boolean;
  mayReadIdentity: boolean;
  /** Whether User accounts (and its filtered view) is open to this role. */
  mayOpenAccounts: boolean;
  cursors: { ledger?: string; payments?: string; events?: string };
}

const TABS: readonly { value: CompanyTabValue; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "postings", label: "Postings" },
  { value: "payments", label: "Payment history" },
  { value: "credits", label: "Credits ledger" },
  { value: "users", label: "Users" },
  { value: "timeline", label: "Timeline" },
];

/**
 * One company record (A9, #2579) — a Company or an Agency, named by its own `kind`.
 *
 * The header carries the name, kind, status and live balance; the tabs below are the record's
 * six surfaces. Every write in the header and the Postings tab is a governed API action with a
 * written reason and its own timeline event.
 */
export function CompanyDetailView(props: CompanyDetailViewProps) {
  const {
    company,
    paymentHistory,
    postings,
    credits,
    timeline,
    timelineRefused,
    timelineFailed,
    activeTab,
    basePath,
    mayReadEvents,
    mayManageCompanies,
    mayManagePostings,
    maySuspend,
    mayGrantCredits,
    mayReadIdentity,
    mayOpenAccounts,
    cursors,
  } = props;

  const posture = identityPosture([company], "org_name", mayReadIdentity);
  const name = displayName(company.org_name);
  const kindLabel = COMPANY_KIND_LABELS[company.kind];
  const noun = kindLabel.toLowerCase();
  const balance = paymentHistory?.totals.balance ?? null;
  const timelineHref = mayReadEvents ? `${customerHref(company.id)}/timeline` : null;

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/companies", label: "Companies" }}
        title={name ?? shortId(company.id)}
        titleMono={name === null}
        description={`One ${noun} record — profile, postings, payments, credits, users and its timeline.`}
        info={
          <>
            <p>
              The registered name is self-declared at signup, not a verified legal name. It is
              disclosed only to a role with name access, and every such read is audited.
            </p>
            <p>
              Postings, payments and credits all come from the company record&apos;s own API
              endpoints; no figure on this page is computed from another screen.
            </p>
          </>
        }
        primaryAction={
          <CompanyHeaderActions
            company={company}
            balance={balance}
            mayManage={mayManageCompanies}
            maySuspend={maySuspend}
            mayGrantCredits={mayGrantCredits}
            mayReadEvents={mayReadEvents}
            mayReadIdentity={mayReadIdentity}
            timelineHref={timelineHref}
          />
        }
        secondaryActions={
          timelineHref ? (
            <Link className="btn btn--ghost" href={timelineHref}>
              <Icon name={ACTION_ICON.timeline} />
              View event timeline
            </Link>
          ) : null
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see this {noun}&apos;s registered name, so this is a limit on the read:
          this admin account has spent its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="company-facts" aria-label="Company summary">
        <span className="company-facts__item">
          <span className="company-facts__label">Kind</span>
          <strong>{kindLabel}</strong>
        </span>
        <span className="company-facts__item">
          <span className="company-facts__label">Status</span>
          <StatusPill value={company.status} />
        </span>
        <span className="company-facts__item">
          <span className="company-facts__label">Verification</span>
          <StatusPill value={company.verification_status} />
        </span>
        <span className="company-facts__item">
          <span className="company-facts__label">Credit balance</span>
          <strong className="ui-num">{balance === null ? "—" : formatCount(balance)}</strong>
        </span>
        <span className="company-facts__item">
          <span className="company-facts__label">Company id</span>
          <span className="mono">{shortId(company.id)}</span>
          <CopyId id={company.id} label="company id" />
        </span>
      </section>

      {company.status === "archived" && (
        <section className="notice notice--bad" role="status">
          <strong>Archived.</strong> Every login is off the platform and its sessions ended.
          Billing history is untouched. {noun === "company" ? "A company" : "An agency"} restores
          to the status each login held before the archive.
        </section>
      )}
      {company.status === "suspended" && (
        <section className="notice notice--bad" role="status">
          <strong>Suspended.</strong> Its postings are hidden from the worker feed and its
          sessions are revoked. Reinstate returns the login to{" "}
          <strong>{company.previous_status ?? "its previous state"}</strong>.
        </section>
      )}

      <CompanyTabs tabs={TABS} active={activeTab} basePath={basePath} />

      <section
        className="panel company-tabpanel"
        id="company-tabpanel"
        role="tabpanel"
        aria-label={TABS.find((t) => t.value === activeTab)?.label ?? "Overview"}
      >
        {activeTab === "overview" && <CompanyOverview company={company} mayReadIdentity={mayReadIdentity} />}
        {activeTab === "postings" && (
          <CompanyPostingsTab
            companyId={company.id}
            companyName={name}
            postings={postings ?? null}
            mayManage={mayManagePostings}
            mayReadEvents={mayReadEvents}
            timelineHref={timelineHref}
          />
        )}
        {activeTab === "payments" && (
          <CompanyPaymentHistoryTab
            history={paymentHistory}
            cursor={cursors.payments}
            basePath={basePath}
          />
        )}
        {activeTab === "credits" && (
          <CompanyCreditsTab credits={credits ?? null} cursor={cursors.ledger} basePath={basePath} />
        )}
        {activeTab === "users" && (
          <CompanyUsersTab company={company} mayOpenAccounts={mayOpenAccounts} />
        )}
        {activeTab === "timeline" && (
          <CompanyTimelineTab
            timeline={timeline ?? null}
            refused={timelineRefused}
            failed={timelineFailed}
            cursor={cursors.events}
            basePath={basePath}
            noun={noun}
          />
        )}
      </section>
    </div>
  );
}

function CompanyOverview({
  company,
  mayReadIdentity,
}: {
  company: CompanyDetail;
  mayReadIdentity: boolean;
}) {
  const named = mayReadIdentity && Object.hasOwn(company, "org_name");
  const contact = company.contact;
  const contactValue = (value: string | null | undefined): ReactNode =>
    contact === undefined ? (
      <span className="table__meta">Not disclosed to your role</span>
    ) : value ? (
      value
    ) : (
      <span className="table__meta">Not recorded</span>
    );

  const cities = (values: string[]) =>
    values.length > 0 ? (
      <ul className="chips">
        {values.map((city) => (
          <li className="chip" key={city}>
            {city}
          </li>
        ))}
      </ul>
    ) : (
      <span className="table__meta">None recorded</span>
    );

  return (
    <div className="company-overview">
      <div className="cols">
        <div>
          <h2 className="panel__title">Profile</h2>
          <DetailList
            items={[
              {
                label: "Registered name",
                value: named ? (
                  displayName(company.org_name) ?? (
                    <span className="table__meta" title={NAME_UNREADABLE}>
                      —
                    </span>
                  )
                ) : (
                  <span className="table__meta">Not disclosed to your role</span>
                ),
              },
              { label: "Kind", value: COMPANY_KIND_LABELS[company.kind] },
              { label: "Status", value: <StatusPill value={company.status} /> },
              {
                label: "Verification",
                value: <StatusPill value={company.verification_status} />,
              },
              { label: "Registered", value: isoDate(company.created_at) },
              {
                label: "Profile updated",
                value: company.profile_updated_at
                  ? isoDate(company.profile_updated_at)
                  : "No company profile saved yet",
              },
              { label: "Website", value: company.website ?? "Not recorded" },
              company.kind === "employer"
                ? { label: "Industry", value: company.industry ?? "Not recorded" }
                : { label: "Agency type", value: company.agency_type ? COMPANY_AGENCY_TYPE_LABELS[company.agency_type as keyof typeof COMPANY_AGENCY_TYPE_LABELS] ?? company.agency_type : "Not recorded" },
              company.kind === "employer"
                ? { label: "Company size", value: company.company_size ?? "Not recorded" }
                : { label: "Recruiters", value: company.recruiter_count === null ? "Not recorded" : formatCount(company.recruiter_count) },
              company.kind === "employer"
                ? { label: "Hiring locations", value: cities(company.hiring_locations) }
                : { label: "Operating cities", value: cities(company.operating_cities) },
            ]}
          />
        </div>

        <div>
          <h2 className="panel__title">Contact and verification</h2>
          <DetailList
            items={[
              { label: "GSTIN", value: contactValue(contact?.gst_number) },
              { label: "Address", value: contactValue(contact?.address) },
              { label: "Contact person", value: contactValue(contact?.contact_person) },
              { label: "Phone", value: contactValue(contact?.phone) },
              { label: "Email", value: contactValue(contact?.email) },
              { label: "Company id", value: <span className="mono">{company.id}</span> },
              { label: "Organisation id", value: company.org_id ? <span className="mono">{company.org_id}</span> : "No organisation record yet" },
              { label: "Team logins", value: formatCount(company.member_count) },
              { label: "Last login", value: company.last_login_at ? isoDate(company.last_login_at) : "Never" },
            ]}
          />
          {!contact && (
            <p className="field__help">
              The contact fields are encrypted at rest and are shown only to a role with name
              access, within its hourly disclosure budget.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function isoDate(value: string): ReactNode {
  return (
    <time dateTime={value} title={timestampTitle(value)}>
      {formatDate(value)}
    </time>
  );
}
