"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { shortId } from "../../../lib/format";
import {
  COMPANY_REASON_CATEGORIES,
  type CompanyStatus,
} from "../../../lib/company-vocabulary";
import { archiveCompanyAction, restoreCompanyAction } from "./actions";

/**
 * A company row's Archive (T3) and Restore actions (A9, #2579).
 *
 * Archive is destructive: it takes every login off the platform and ends their sessions, so the
 * dialog asks the operator to type the company's name. Restore is consequential (T2), with the
 * same required reason. Both write `audit_logs` and one `admin.action_performed` server-side.
 */
export function CompanyRowActions({
  company,
  mayManage,
  mayReadEvents,
  timelineHref,
}: {
  company: { id: string; name: string | null; status: CompanyStatus };
  mayManage: boolean;
  mayReadEvents: boolean;
  timelineHref: string | null;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"archive" | "restore" | null>(null);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  if (!mayManage) return null;

  const subject = company.name?.trim() || shortId(company.id);
  const eventsLink = mayReadEvents && timelineHref
    ? { href: timelineHref, label: "View event timeline" }
    : null;

  function settled(result: AdminActionOutcome) {
    setOutcome(result);
    if (result.ok) router.refresh();
  }

  return (
    <div className="row-actions" ref={triggerRef}>
      {company.status === "archived" ? (
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          onClick={() => setDialog("restore")}
        >
          <Icon name={ACTION_ICON.reinstate} />
          <span>Restore</span>
        </button>
      ) : (
        <button
          className="btn btn--ghost btn--sm"
          type="button"
          onClick={() => setDialog("archive")}
        >
          <Icon name={ACTION_ICON.delete} />
          <span>Archive</span>
        </button>
      )}

      {outcome && !outcome.ok ? (
        <AdminActionResultBanner outcome={outcome} eventsLink={eventsLink} />
      ) : null}

      <ConfirmDialog
        open={dialog === "archive"}
        onClose={() => setDialog(null)}
        tier="destructive"
        targetName={subject}
        title={`Archive ${subject}?`}
        description="Every login in this organisation is archived, its postings leave the worker feed and its sessions end. Billing history is untouched."
        changes={[
          { label: "Status", before: company.status, after: "Archived" },
          { label: "Postings", before: "Visible per their own state", after: "Hidden from workers" },
          { label: "Sessions", before: "Live", after: "Ended" },
        ]}
        categories={COMPANY_REASON_CATEGORIES}
        confirmLabel="Archive company"
        onConfirm={({ category, text }) =>
          archiveCompanyAction(company.id, {
            reasonCode: category as never,
            reasonText: text,
          })
        }
        onSettled={settled}
        returnFocus={() => triggerRef.current?.querySelector("button") ?? null}
      />

      <ConfirmDialog
        open={dialog === "restore"}
        onClose={() => setDialog(null)}
        tier="consequential"
        title={`Restore ${subject}?`}
        description="Every archived login returns to the status it held before the archive. A login that was suspended before the archive returns suspended."
        changes={[{ label: "Status", before: "Archived", after: "Previous status" }]}
        categories={COMPANY_REASON_CATEGORIES}
        confirmLabel="Restore company"
        onConfirm={({ category, text }) =>
          restoreCompanyAction(company.id, {
            reasonCode: category as never,
            reasonText: text,
          })
        }
        onSettled={settled}
        returnFocus={() => triggerRef.current?.querySelector("button") ?? null}
      />
    </div>
  );
}
