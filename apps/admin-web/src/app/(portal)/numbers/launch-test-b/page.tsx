import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import {
  getContactsPerHire,
  type ContactsPerHireHire,
  type ContactsPerHireReport,
} from "../../../../lib/numbers";
import { isAdminRequestError, isAdminUnauthorized } from "../../../../lib/admin-http";
import { customerHref } from "../../../../lib/customer";
import {
  formatCount,
  formatRelative,
  shortId,
  timestampTitle,
} from "../../../../lib/format";
import {
  CONTACTS_PER_HIRE_REASON_LABELS,
  UNLOCK_OUTCOME_LABELS,
} from "../../../../lib/numbers-vocabulary";
import { PageHeader } from "../../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../../components/data-grid";
import { Stat } from "../../../../components/stat";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { NumbersTabs } from "../numbers-tabs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Launch test B" };

/**
 * Launch test B (#2884; API #2755 part D) — contacts opened before the first confirmed hires.
 *
 * Read-only, ids only. The mean arrives as a fraction (`numerator / denominator`) and is divided
 * here for display; 0/0 says "no hire yet" rather than printing a confident zero.
 */
export default async function LaunchTestBPage() {
  await requireCapability("read_business_numbers");

  let report: ContactsPerHireReport | null = null;
  let problem: "off" | "unavailable" | "error" | null = null;

  try {
    report = await getContactsPerHire();
  } catch (err) {
    if (isAdminUnauthorized(err)) throw err;
    if (isAdminRequestError(err)) {
      if (err.status === 404) problem = "off";
      else if (err.status === 503) problem = "unavailable";
      else problem = "error";
    } else {
      problem = "error";
    }
  }

  const mean = report ? contactsPerHire(report.totals.contacts_per_hire) : null;

  return (
    <div className="page">
      <PageHeader
        back={{ href: "/numbers", label: "Numbers" }}
        title="Launch test B"
        description="The contacts a company opened before it confirmed one of the first 50 hires."
        info={
          <>
            <p>
              Read-only. It lists ids only — the company, the posting, the worker and each contact
              opened for that posting before the hire.
            </p>
            <p>
              The mean is the report&apos;s own numerator over its denominator. No contacts opened
              and no hire counted reads as “no hire yet”, never as 0.
            </p>
          </>
        }
        filters={<NumbersTabs active="launch-test-b" />}
      />

      {problem ? (
        <Problem problem={problem} />
      ) : report ? (
        <>
          <section aria-labelledby="ltb-totals">
            <h2 className="sr-only" id="ltb-totals">
              Totals
            </h2>
            <div className="stats">
              <Stat label="Hires listed" value={formatCount(report.totals.hires_listed)} />
              <Stat
                label={`Hires with a contact count`}
                value={formatCount(report.totals.hires_counted)}
              />
              <Stat
                label="Contacts opened before those hires"
                value={formatCount(report.totals.contacts_opened)}
              />
              <Stat
                label="Contacts per hire"
                value={mean === null ? "no hire yet" : mean}
                absent={mean === null}
                valueTitle={
                  report.totals.contacts_per_hire.denominator === 0
                    ? "No hire has a contact count yet."
                    : `${report.totals.contacts_per_hire.numerator} contacts over ${report.totals.contacts_per_hire.denominator} hires.`
                }
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="ltb-hires" aria-live="polite">
            <div className="panel__head">
              <h2 className="panel__title" id="ltb-hires">
                Hires
              </h2>
              <p className="panel__sub">
                {formatCount(report.hires.length)} of the first {formatCount(report.limit)} confirmed
                hires, oldest first.
              </p>
            </div>
            {report.hires.length > 0 ? (
              <DataGrid
                id="launch-test-b"
                caption="Confirmed hires and the contacts opened before them"
                columns={COLUMNS}
                rows={report.hires}
                rowKey={(hire) => hire.hire_id}
                variant="prose"
              />
            ) : (
              <div className="state">
                <h3 className="state__title">No confirmed hire yet</h3>
                <p className="state__body">
                  The report fills from the first confirmed hire. Nothing is being measured as
                  zero until there is one.
                </p>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function contactsPerHire(mean: { numerator: number; denominator: number }): string | null {
  if (mean.denominator === 0) return null;
  return (mean.numerator / mean.denominator).toFixed(2).replace(/\.?0+$/, "");
}

function Problem({ problem }: { problem: "off" | "unavailable" | "error" }) {
  if (problem === "off") {
    return (
      <section className="panel">
        <div className="state">
          <h3 className="state__title">Not switched on yet</h3>
          <p className="state__body">
            This deployment has not turned the numbers screen on. Nothing is wrong with your
            access.
          </p>
        </div>
      </section>
    );
  }
  if (problem === "unavailable") {
    return (
      <section className="panel">
        <div className="state state--error">
          <h3 className="state__title">Try again later</h3>
          <p className="state__body">
            A migration this report reads has not been applied, so nothing was fetched.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="state state--error">
        <h3 className="state__title">The report did not load</h3>
        <p className="state__body">This is a fault on our side. Retry reads it again.</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/numbers/launch-test-b">
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    </section>
  );
}

const COLUMNS: readonly GridColumn<ContactsPerHireHire>[] = [
  {
    id: "company",
    header: "Company",
    width: "customer",
    rowHeader: true,
    cell: (hire) => (
      <Link className="mono" href={customerHref(hire.payer_id)} title={hire.payer_id}>
        {shortId(hire.payer_id)}
      </Link>
    ),
  },
  {
    id: "posting",
    header: "Posting",
    width: "short",
    cell: (hire) =>
      hire.job_posting_id ? (
        <Link
          className="mono"
          href={`/jobs/${encodeURIComponent(hire.job_posting_id)}`}
          title={hire.job_posting_id}
        >
          {shortId(hire.job_posting_id)}
        </Link>
      ) : (
        <span className="table__meta">Agency job</span>
      ),
  },
  {
    id: "worker",
    header: "Worker",
    width: "short",
    cell: (hire) => (
      <Link
        className="mono"
        href={`/candidates/${encodeURIComponent(hire.worker_id)}`}
        title={hire.worker_id}
      >
        {shortId(hire.worker_id)}
      </Link>
    ),
  },
  {
    id: "confirmed",
    header: "Confirmed",
    width: "date",
    cell: (hire) => (
      <time dateTime={hire.confirmed_at} title={timestampTitle(hire.confirmed_at)}>
        {formatRelative(hire.confirmed_at)}
      </time>
    ),
  },
  {
    id: "contacts",
    header: "Contacts opened before the hire",
    text: "wrap",
    cell: (hire) => <ContactsCell hire={hire} />,
  },
];

function ContactsCell({ hire }: { hire: ContactsPerHireHire }) {
  if (hire.contacts === null) {
    return (
      <span className="table__meta">
        No contact count —{" "}
        {hire.contacts_reason
          ? CONTACTS_PER_HIRE_REASON_LABELS[hire.contacts_reason]
          : "the posting cannot be told apart."}
      </span>
    );
  }
  if (hire.contacts.length === 0) {
    return <span className="table__meta">No contacts opened before the hire.</span>;
  }
  return (
    <ul className="list">
      {hire.contacts.map((contact) => (
        <li key={contact.unlock_id}>
          <span className="mono" title={contact.unlock_id}>
            {shortId(contact.unlock_id)}
          </span>{" "}
          ·{" "}
          {contact.worker_id ? (
            <span className="mono" title={contact.worker_id}>
              {shortId(contact.worker_id)}
            </span>
          ) : (
            "worker erased"
          )}{" "}
          · opened{" "}
          <time dateTime={contact.granted_at} title={timestampTitle(contact.granted_at)}>
            {formatRelative(contact.granted_at)}
          </time>{" "}
          ·{" "}
          {contact.outcome ? (
            <span title={timestampTitle(contact.outcome.answered_at)}>
              {UNLOCK_OUTCOME_LABELS[contact.outcome.outcome]} (
              {contact.outcome.answered_by === "company" ? "company" : "desk"})
            </span>
          ) : (
            <span className="table__meta">No outcome yet</span>
          )}
        </li>
      ))}
    </ul>
  );
}
