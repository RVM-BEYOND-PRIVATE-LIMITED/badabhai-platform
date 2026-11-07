import { notFound } from "next/navigation";
import { requireCapability } from "../lib/auth";
import { can } from "../lib/auth/capabilities";
import { getCompany, type CompanyDetail } from "../lib/companies";
import { getPaymentHistory } from "../lib/payment-history";
import { getPayerCredits, listCompanyJobPostings, type CreditsView, type JobPostingListItem } from "../lib/entities";
import { getEntityTimeline, type EntityTimeline } from "../lib/events";
import { isAdminRequestError } from "../lib/admin-http";
import { customerHref } from "../lib/customer";
import { CompanyDetailView, type CompanyTab } from "./company-detail";

/**
 * The company detail route body (`/companies/[id]`).
 *
 * Reads exactly what the active tab renders:
 *  - always the company record (`GET /admin/companies/:id`, read_entities);
 *  - always the payment timeline's first page, because its totals carry the header balance and
 *    the Payment history tab must not disagree with what the header shows (read_entities);
 *  - the active tab's own read: postings, credits ledger, or the event timeline (read_events).
 *
 * The timeline read is branched on `read_events` so a role that holds only `read_entities` gets a
 * clean refusal in the tab, not an error boundary (the page-gates rule).
 */
export async function CompanyDetailRoute({
  id,
  tab,
  ledgerCursor,
  paymentsCursor,
  eventsCursor,
}: {
  id: string;
  tab: string | undefined;
  ledgerCursor: string | undefined;
  paymentsCursor: string | undefined;
  eventsCursor: string | undefined;
}) {
  const session = await requireCapability("read_entities");
  const mayReadEvents = can(session.capabilities, "read_events");

  let company: CompanyDetail;
  try {
    company = await getCompany(id);
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  const active = parseTab(tab);
  const paymentHistory = await getPaymentHistory(id, {
    limit: 50,
    ...(active === "payments" && paymentsCursor ? { cursor: paymentsCursor } : {}),
  }).catch(() => null);

  let postings: JobPostingListItem[] | null = null;
  if (active === "postings") {
    const ids = [
      company.id,
      ...company.members.flatMap((member) => (member.payer_id ? [member.payer_id] : [])),
    ];
    postings = await listCompanyJobPostings(ids, 50).catch(() => null);
  }

  let credits: CreditsView | null = null;
  if (active === "credits") {
    credits = await getPayerCredits(id, {
      limit: 50,
      ...(ledgerCursor ? { cursor: ledgerCursor } : {}),
    }).catch(() => null);
  }

  let timeline: EntityTimeline | null = null;
  let timelineRefused = false;
  let timelineFailed = false;
  if (active === "timeline") {
    if (!mayReadEvents) timelineRefused = true;
    else {
      try {
        timeline = await getEntityTimeline("payer", id, { limit: 50, cursor: eventsCursor });
      } catch {
        timelineFailed = true;
      }
    }
  }

  return (
    <CompanyDetailView
      company={company}
      paymentHistory={paymentHistory}
      postings={active === "postings" ? postings : undefined}
      credits={active === "credits" ? credits : undefined}
      timeline={active === "timeline" ? timeline : undefined}
      timelineRefused={timelineRefused}
      timelineFailed={timelineFailed}
      activeTab={active}
      basePath={customerHref(company.id)}
      mayReadEvents={mayReadEvents}
      mayManageCompanies={can(session.capabilities, "manage_companies")}
      mayManagePostings={can(session.capabilities, "manage_postings")}
      maySuspend={can(session.capabilities, "suspend_payer")}
      mayGrantCredits={can(session.capabilities, "grant_credits")}
      mayReadIdentity={can(session.capabilities, "read_identity")}
      mayOpenAccounts={can(session.capabilities, "manage_payer_credentials")}
      cursors={{ ledger: ledgerCursor, payments: paymentsCursor, events: eventsCursor }}
    />
  );
}

/** The tab an address asks for; an unknown or absent value is Overview. */
function parseTab(value: string | undefined): CompanyTab {
  switch (value) {
    case "postings":
    case "payments":
    case "credits":
    case "users":
    case "timeline":
      return value;
    default:
      return "overview";
  }
}

export type { CompanyDetail };
