import { notFound } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { listCampusDriveRequests } from "../../../lib/payer-api";
import type { CampusDriveRequest } from "../../../lib/contracts";
import { Card } from "../../../components/ds";
import { PageHeader, type PageHeaderAction } from "../../../components/page-header";
import { PortalLink } from "../../../components/portal-link";
import { PagerLink } from "../../../components/paged-list";
import { Badge } from "../../../components/ds";
import {
  CAMPUS_DRIVE_STATUS_LABEL,
  campusDriveStatusTone,
} from "../../../lib/campus-drive-view";

export const dynamic = "force-dynamic";

/**
 * #2813 — the company's campus-drive requests, newest first. Payer-web only (payments and drives
 * never exist in the mobile apps). Employer accounts only: an agency gets the same neutral not
 * found its create route does.
 *
 * The switch gates NEW requests only, so this list keeps working for a company whose request
 * creation is no longer live. The "Ask for a campus drive" entry appears only when the list read
 * itself answered (a 404 hides the whole surface).
 */
export default async function CampusDrivesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePayer();
  if (session.role !== "employer") notFound();

  const params = (await searchParams) ?? {};
  const rawCursor = params.cursor;
  const cursor = typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : undefined;

  const page = await listCampusDriveRequests(cursor);
  // The route's house 404: hide the surface rather than offer a door that cannot open.
  if (page === null) notFound();

  const newRequest: PageHeaderAction = {
    href: "/campus-drives/new",
    label: "Ask for a campus drive",
    icon: ACTION_ICON.next,
  };
  const firstPage = cursor ? "/campus-drives" : null;

  return (
    <div className="page">
      <PageHeader
        title="Campus drives"
        description="Ask RVM's placement team for a campus drive. The team schedules it in BadaBhai Campus and the date appears here."
        primaryAction={newRequest}
      />

      {page.drive_requests.length === 0 ? (
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.posting} />
            </span>
            <h2 className="state__title">No campus-drive requests yet</h2>
            <p className="state__body">
              Ask RVM&rsquo;s placement team for a drive when you want to hire students in numbers.
              You can name a posting, branches and preferred dates.
            </p>
            <div className="state__actions">
              <PortalLink
                className="bb-btn bb-btn--primary"
                href="/campus-drives/new"
                pendingLabel="Ask for a campus drive"
              >
                Ask for a campus drive
              </PortalLink>
            </div>
          </div>
        </Card>
      ) : (
        <div className="postings-list">
          {page.drive_requests.map((request) => (
            <CampusDriveCard key={request.id} request={request} />
          ))}
        </div>
      )}

      {firstPage || page.next_cursor ? (
        <nav className="candidates-pager" aria-label="Campus-drive request pages">
          {firstPage ? (
            <PagerLink
              className="bb-btn bb-btn--secondary"
              href={firstPage}
              pendingLabel="First page"
            >
              <Icon name={ACTION_ICON.back} />
              <span>First page</span>
            </PagerLink>
          ) : null}
          {page.next_cursor ? (
            <PagerLink
              className="bb-btn bb-btn--secondary"
              href={`/campus-drives?cursor=${encodeURIComponent(page.next_cursor)}`}
              pendingLabel="Next page"
            >
              <span>Next page</span>
              <Icon name={ACTION_ICON.next} />
            </PagerLink>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function CampusDriveCard({ request }: { request: CampusDriveRequest }) {
  return (
    <Card padding="md" className="posting-card">
      <div className="posting-card__main">
        <div className="posting-card__head">
          <PortalLink
            className="posting-card__title"
            href={`/campus-drives/${request.id}`}
            pendingLabel="Campus drive request"
          >
            Campus drive · {request.openings} openings
          </PortalLink>
          <Badge tone={campusDriveStatusTone(request.status)} upper>
            {CAMPUS_DRIVE_STATUS_LABEL[request.status]}
          </Badge>
        </div>
        <div className="posting-card__meta">
          <span>
            Preferred {request.preferred_from} to {request.preferred_to}
          </span>
          <span>
            {request.branch_ids.length === 0
              ? "Any branch"
              : `${request.branch_ids.length} branch(es)`}
          </span>
          {request.scheduled_on ? <span>Drive on {request.scheduled_on}</span> : null}
        </div>
        {request.status === "declined" && request.decision_reason ? (
          <p className="posting-card__meta" role="note">
            <strong>Reason:</strong> {request.decision_reason}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
