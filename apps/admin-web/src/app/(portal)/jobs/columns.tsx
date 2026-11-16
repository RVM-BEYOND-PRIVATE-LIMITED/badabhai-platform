import type { JobPostingListItem } from "../../../lib/entities";
import { formatPayBand, formatRelative, timestampTitle } from "../../../lib/format";
import { CustomerLink } from "../../../components/customer-link";
import { StatusPill } from "../../../components/status-pill";
import type { GridColumn } from "../../../components/data-grid";

/** #2746 — the audience tokens as words. An omitted block means the API's default. */
export function audienceLabel(audience: JobPostingListItem["audience"]): string {
  switch (audience) {
    case "rvm_students":
      return "RVM students";
    case "both":
      return "Both";
    case "badabhai_workers":
      return "BadaBhai workers";
    default:
      return "—";
  }
}

/**
 * The postings columns on the data grid (A4, #2574). Nine columns have to fit a 1440px window
 * beside the full sidebar without scrolling sideways, so the three poster-typed text columns share
 * what the fixed ones leave and cut long values (each keeps its whole text in `title`); the row's
 * link is its role title.
 */
export const POSTING_COLUMNS: readonly GridColumn<JobPostingListItem>[] = [
  {
    id: "title",
    header: "Role title",
    cell: (j) => j.role_title,
    trail: (j) => <span className="table__meta">{j.vacancy_band} openings</span>,
    title: (j) => `${j.role_title} · ${j.vacancy_band} openings`,
  },
  { id: "org", header: "Published as", cell: (j) => j.org_label, title: (j) => j.org_label },
  {
    id: "location",
    header: "Location",
    className: "table__meta",
    cell: (j) => j.city ?? j.location_label ?? "—",
    title: (j) => j.location_label ?? j.city ?? undefined,
  },
  {
    id: "pay",
    header: "Pay",
    width: "money",
    className: "table__meta",
    cell: (j) => formatPayBand(j.pay_min, j.pay_max),
  },
  { id: "status", header: "Status", width: "status", cell: (j) => <StatusPill value={j.status} /> },
  {
    id: "audience",
    header: "Audience",
    width: "status",
    className: "table__meta",
    cell: (j) => audienceLabel(j.audience),
    title: (j) =>
      j.rvm_review ? `RVM review: ${j.rvm_review.state}` : audienceLabel(j.audience),
  },
  {
    id: "rvm",
    header: "RVM review",
    width: "status",
    cell: (j) =>
      j.rvm_review ? (
        <span className="table__meta">{j.rvm_review.state}</span>
      ) : (
        <span className="table__meta">—</span>
      ),
    title: (j) => j.rvm_review?.reason ?? undefined,
  },
  {
    id: "trust",
    header: "Trust review",
    width: "status",
    cell: (j) => <StatusPill value={j.verification_status} />,
  },
  {
    id: "customer",
    header: "Customer",
    width: "customer",
    cell: (j) =>
      j.payer_id ? (
        <CustomerLink payerId={j.payer_id} payerRole={j.payer_role} />
      ) : (
        // No payer_id means ops created it directly — there is no customer account behind it,
        // and saying so beats a dead link.
        <span className="table__meta">ops-created</span>
      ),
  },
  {
    id: "created",
    header: "Created",
    width: "date",
    cell: (j) => (
      <time dateTime={j.created_at} title={timestampTitle(j.created_at)}>
        {formatRelative(j.created_at)}
      </time>
    ),
  },
];
