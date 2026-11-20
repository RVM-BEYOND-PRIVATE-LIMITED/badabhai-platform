import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePayer } from "../../../../lib/auth";
import { getCampusDriveRequest } from "../../../../lib/payer-api";
import { Badge, Card } from "../../../../components/ds";
import { PageHeader } from "../../../../components/page-header";
import {
  CAMPUS_DRIVE_STATUS_LABEL,
  campusDriveStatusTone,
  canCancelCampusDrive,
} from "../../../../lib/campus-drive-view";
import { CancelCampusDriveButton } from "./cancel-button";

export const dynamic = "force-dynamic";

/**
 * #2813 — one campus-drive request. Unknown or foreign ids are the same neutral 404 the API
 * answers. `roles_note` and `decision_reason` are the placement team's/company's own words, so
 * they render as PLAIN TEXT (React escapes them; no markdown, no auto-linking).
 */
export default async function CampusDriveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePayer();
  if (session.role !== "employer") notFound();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const request = await getCampusDriveRequest(id);
  if (!request) notFound();

  const cancellable = canCancelCampusDrive(request.status);

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/campus-drives", label: "Campus drives" }}
        title={`Campus drive · ${request.openings} openings`}
        description="What you asked RVM's placement team for, and where it stands."
        status={
          <Badge tone={campusDriveStatusTone(request.status)} upper>
            {CAMPUS_DRIVE_STATUS_LABEL[request.status]}
          </Badge>
        }
      />

      <div className="cols">
        <Card>
          <h2 className="panel__title">Request</h2>
          <dl className="kv">
            <dt className="kv__k">Openings</dt>
            <dd className="kv__v bb-mono">{request.openings}</dd>
            <dt className="kv__k">Preferred dates</dt>
            <dd className="kv__v">
              {request.preferred_from} to {request.preferred_to}
            </dd>
            <dt className="kv__k">Branches</dt>
            <dd className="kv__v">
              {request.branch_ids.length === 0
                ? "Any branch"
                : request.branch_ids.join(", ")}
            </dd>
            {request.job_posting_id ? (
              <>
                <dt className="kv__k">Posting</dt>
                <dd className="kv__v bb-mono">{request.job_posting_id}</dd>
              </>
            ) : null}
            {request.roles_note ? (
              <>
                <dt className="kv__k">Roles note</dt>
                <dd className="kv__v kv__v--prose">{request.roles_note}</dd>
              </>
            ) : null}
            <dt className="kv__k">Contact</dt>
            <dd className="kv__v">
              {request.contact
                ? `${request.contact.name} · phone ending ${request.contact.phone_last4}`
                : "Removed"}
            </dd>
          </dl>
        </Card>

        <Card>
          <h2 className="panel__title">Decision</h2>
          <dl className="kv">
            <dt className="kv__k">Status</dt>
            <dd className="kv__v">{CAMPUS_DRIVE_STATUS_LABEL[request.status]}</dd>
            {request.scheduled_on ? (
              <>
                <dt className="kv__k">Scheduled on</dt>
                <dd className="kv__v bb-mono">{request.scheduled_on}</dd>
              </>
            ) : null}
            {request.campus_drive_ref ? (
              <>
                <dt className="kv__k">Campus reference</dt>
                <dd className="kv__v bb-mono">{request.campus_drive_ref}</dd>
              </>
            ) : null}
            {request.decision_reason ? (
              <>
                <dt className="kv__k">Reason</dt>
                <dd className="kv__v kv__v--prose">{request.decision_reason}</dd>
              </>
            ) : null}
          </dl>
          {cancellable ? (
            <div className="state__actions">
              <CancelCampusDriveButton id={request.id} />
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
