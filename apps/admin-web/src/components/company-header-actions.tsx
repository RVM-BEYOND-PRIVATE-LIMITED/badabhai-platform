"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { ConfirmDialog } from "./confirm-dialog";
import { AdminActionResultBanner, timelineLink } from "./admin-action-result-banner";
import { CompanyEditDrawer } from "./company-edit-drawer";
import { GrantCreditsDialog } from "./grant-credits-dialog";
import { reinstatePayerAction, suspendPayerAction } from "./payer-actions";
import type { CompanyDetail } from "../lib/companies";
import { displayName } from "../lib/identity";
import { shortId } from "../lib/format";
import { REASON_CATEGORIES } from "../lib/confirm-tiers";
import { COMPANY_REASON_CATEGORIES } from "../lib/company-vocabulary";
import type { AdminActionOutcome } from "../lib/admin-action-result";
import { archiveCompanyAction, restoreCompanyAction } from "../app/(portal)/companies/actions";

type ConfirmKind = "suspend" | "reinstate" | "archive" | "restore";

/**
 * The company record's header actions (A9, #2579):
 *   Edit (T2 diff + reason) · Suspend / Reinstate (T2) · Grant credits (T2) ·
 *   Archive (T3, typed name) / Restore (T2), in the overflow menu.
 *
 * Every mutation goes through the API's governed routes; the admin actor is the session, never a
 * body value. Archive/restore carry the company's own closed reason codes. Suspend/reinstate use
 * the legacy payer routes, which record the action but do not accept a reason text — the dialog
 * still requires one so the operator's intent is captured in the UI flow, and that contract gap
 * is documented in the A9 report.
 */
export function CompanyHeaderActions({
  company,
  balance,
  mayManage,
  maySuspend,
  mayGrantCredits,
  mayReadEvents,
  mayReadIdentity,
  timelineHref,
}: {
  company: CompanyDetail;
  balance: number | null;
  mayManage: boolean;
  maySuspend: boolean;
  mayGrantCredits: boolean;
  mayReadEvents: boolean;
  mayReadIdentity: boolean;
  timelineHref: string | null;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);

  const name = displayName(company.org_name);
  const subject = name ?? shortId(company.id);
  const archived = company.status === "archived";
  const eventsLink = mayReadEvents ? timelineLink(timelineHref) : null;

  function settled(result: AdminActionOutcome) {
    setOutcome(result);
    if (result.ok) router.refresh();
  }

  function closeMenu() {
    if (menuRef.current) menuRef.current.open = false;
  }

  return (
    <>
      <div className="row-actions">
        {mayManage && !archived && (
          <button className="btn btn--ghost" type="button" onClick={() => setEditOpen(true)}>
            <Icon name={ACTION_ICON.edit} />
            Edit
          </button>
        )}
        {maySuspend && !archived && (
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => setConfirm(company.status === "suspended" ? "reinstate" : "suspend")}
          >
            <Icon
              name={
                company.status === "suspended" ? ACTION_ICON.reinstate : ACTION_ICON.suspend
              }
            />
            {company.status === "suspended" ? "Reinstate" : "Suspend"}
          </button>
        )}
        {mayGrantCredits && !archived && (
          <button className="btn btn--primary" type="button" onClick={() => setGrantOpen(true)}>
            <Icon name={ACTION_ICON.credits} />
            Grant credits
          </button>
        )}
        {mayManage && (
          <details className="menu" ref={menuRef}>
            <summary className="btn btn--ghost" aria-label="More company actions">
              <Icon name={ACTION_ICON.disclosure} className="disclosure__caret" />
              More
            </summary>
            <div className="menu__list">
              {archived ? (
                <button
                  className="menu__item"
                  type="button"
                  onClick={() => {
                    closeMenu();
                    setConfirm("restore");
                  }}
                >
                  <Icon name={ACTION_ICON.reinstate} />
                  Restore company
                </button>
              ) : (
                <button
                  className="menu__item menu__item--danger"
                  type="button"
                  onClick={() => {
                    closeMenu();
                    setConfirm("archive");
                  }}
                >
                  <Icon name={ACTION_ICON.delete} />
                  Archive company
                </button>
              )}
            </div>
          </details>
        )}
      </div>

      {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={eventsLink} /> : null}

      <CompanyEditDrawer
        company={company}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        mayReadIdentity={mayReadIdentity}
        timelineHref={timelineHref}
      />

      <GrantCreditsDialog
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        companyId={company.id}
        balance={balance}
        mayGrant={mayGrantCredits}
        timelineHref={timelineHref}
      />

      <ConfirmDialog
        open={confirm === "suspend"}
        onClose={() => setConfirm(null)}
        tier="consequential"
        title={`Suspend ${subject}?`}
        description="Every login's postings are hidden from the worker feed and its sessions end. Reinstate returns it to the state it held."
        changes={[
          { label: "Status", before: company.status, after: "Suspended" },
          { label: "Postings", before: "Visible per their own state", after: "Hidden from workers" },
          { label: "Sessions", before: "Live", after: "Ended" },
        ]}
        categories={REASON_CATEGORIES}
        confirmLabel="Suspend"
        onConfirm={async () => suspendPayerAction(company.id)}
        onSettled={settled}
      />

      <ConfirmDialog
        open={confirm === "reinstate"}
        onClose={() => setConfirm(null)}
        tier="consequential"
        title={`Reinstate ${subject}?`}
        description="The customer returns to the status it held before the suspension, and its postings to their own prior states."
        changes={[{ label: "Status", before: "Suspended", after: company.previous_status ?? "Previous status" }]}
        categories={REASON_CATEGORIES}
        confirmLabel="Reinstate"
        onConfirm={async () => reinstatePayerAction(company.id)}
        onSettled={settled}
      />

      <ConfirmDialog
        open={confirm === "archive"}
        onClose={() => setConfirm(null)}
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
      />

      <ConfirmDialog
        open={confirm === "restore"}
        onClose={() => setConfirm(null)}
        tier="consequential"
        title={`Restore ${subject}?`}
        description="Every archived login returns to the status it held before the archive. A login suspended before the archive returns suspended."
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
      />
    </>
  );
}
