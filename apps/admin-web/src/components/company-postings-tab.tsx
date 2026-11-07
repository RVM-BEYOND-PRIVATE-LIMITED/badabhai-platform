"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { ConfirmDialog } from "./confirm-dialog";
import { AdminActionResultBanner, timelineLink } from "./admin-action-result-banner";
import { PostingEditDrawer } from "./posting-edit-drawer";
import { StatusPill } from "./status-pill";
import { useReversibleAction, useToast } from "./toast";
import type { JobPostingListItem } from "../lib/entities";
import type { AdminActionOutcome } from "../lib/admin-action-result";
import { customerHref } from "../lib/customer";
import { formatRelative, timestampTitle } from "../lib/format";
import { queryHref } from "../lib/query-href";
import {
  POSTING_REASON_CATEGORIES,
  POSTING_VERIFICATION_REASON_CATEGORIES,
  QUICK_POSTING_REASON,
} from "../lib/company-vocabulary";
import {
  closePostingAction,
  hidePostingAction,
  pausePostingAction,
  readPostingApplicantCountAction,
  rejectPostingAction,
  resumePostingAction,
  unhidePostingAction,
  verifyPostingAction,
} from "../app/(portal)/companies/[id]/posting-actions";

/**
 * A company's Postings tab (A9, #2579), built on the #2566 admin posting controls.
 *
 * Visibility is a separate state from lifecycle status and is clearly marked on every hidden
 * row. A hide with no applicants is T1 (act now, Undo for 8s); a hide with applicants is T2
 * (reason required). Pause/Resume are T1; Close and Verify/Reject are T2.
 */
export function CompanyPostingsTab({
  companyId,
  companyName,
  postings,
  mayManage,
  mayReadEvents,
  timelineHref,
}: {
  companyId: string;
  companyName: string | null;
  postings: JobPostingListItem[] | null;
  mayManage: boolean;
  mayReadEvents: boolean;
  timelineHref: string | null;
}) {
  const retryHref = queryHref(customerHref(companyId), { tab: "postings" });

  return (
    <div className="company-postings">
      <div className="panel__head panel__head--row">
        <div>
          <h2 className="panel__title">Postings</h2>
          <p className="panel__sub">
            {postings === null
              ? "The postings read failed."
              : `${postings.length} posting${postings.length === 1 ? "" : "s"} across the organisation, newest first.`}
          </p>
        </div>
        {mayReadEvents && timelineHref ? (
          <Link className="btn btn--ghost" href={timelineHref}>
            <Icon name={ACTION_ICON.timeline} />
            Company timeline
          </Link>
        ) : null}
      </div>

      {postings === null ? (
        <div className="state state--error">
          <h3 className="state__title">Postings could not be loaded</h3>
          <p className="state__body">
            The company record above loaded, but the postings read failed — so this table is
            missing, not empty.
          </p>
          <div className="state__actions">
            <Link className="btn btn--ghost" href={retryHref}>
              <Icon name={ACTION_ICON.retry} />
              Retry
            </Link>
          </div>
        </div>
      ) : postings.length === 0 ? (
        <div className="state">
          <h3 className="state__title">No postings yet</h3>
          <p className="state__body">
            This {companyName ? "company" : "company or agency"} has never created a posting.
          </p>
        </div>
      ) : (
        <div className="tablewrap">
          <table className="table postings-table">
            <caption className="sr-only">Postings belonging to this company</caption>
            <thead>
              <tr>
                <th scope="col">Posting</th>
                <th scope="col">Status</th>
                <th scope="col">Trust review</th>
                <th scope="col">Visibility</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {postings.map((posting) => (
                <PostingRow
                  key={posting.id}
                  posting={posting}
                  mayManage={mayManage}
                  mayReadEvents={mayReadEvents}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PostingRow({
  posting,
  mayManage,
  mayReadEvents,
}: {
  posting: JobPostingListItem;
  mayManage: boolean;
  mayReadEvents: boolean;
}) {
  const router = useRouter();
  const { show } = useToast();
  const runReversible = useReversibleAction();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"hide" | "close" | "verify" | "reject" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);

  const hidden = posting.hidden === true;
  const eventsLink = mayReadEvents
    ? timelineLink(`/jobs/${posting.id}/timeline`)
    : null;

  function settled(result: AdminActionOutcome) {
    setOutcome(result);
    if (result.ok) router.refresh();
  }

  async function toggleVisibility() {
    if (!mayManage || busy) return;
    if (hidden) {
      const result = await runReversible({
        act: () => unhidePostingAction(posting.id, QUICK_POSTING_REASON),
        undo: async () => {
          const undone = await hidePostingAction(posting.id, QUICK_POSTING_REASON);
          if (undone.ok) router.refresh();
          return undone;
        },
        doneMessage: "Posting visible again.",
        undoneMessage: "Posting hidden again.",
      });
      if (result.ok) router.refresh();
      return;
    }

    setBusy(true);
    const applicants = await readPostingApplicantCountAction(posting.id);
    setBusy(false);
    if (!applicants.ok) {
      show({ message: applicants.error, tone: "danger" });
      return;
    }
    if (applicants.counts.total > 0) {
      setDialog("hide");
      return;
    }
    const result = await runReversible({
      act: () => hidePostingAction(posting.id, QUICK_POSTING_REASON),
      undo: async () => {
        const undone = await unhidePostingAction(posting.id, QUICK_POSTING_REASON);
        if (undone.ok) router.refresh();
        return undone;
      },
      doneMessage: "Posting hidden.",
      undoneMessage: "Posting visible again.",
    });
    if (result.ok) router.refresh();
  }

  function togglePause() {
    const pausing = posting.status === "open";
    void runReversible({
      act: () =>
        pausing
          ? pausePostingAction(posting.id, QUICK_POSTING_REASON)
          : resumePostingAction(posting.id, QUICK_POSTING_REASON),
      undo: async () => {
        const undone = pausing
          ? await resumePostingAction(posting.id, QUICK_POSTING_REASON)
          : await pausePostingAction(posting.id, QUICK_POSTING_REASON);
        if (undone.ok) router.refresh();
        return undone;
      },
      doneMessage: pausing ? "Posting paused." : "Posting resumed.",
      undoneMessage: pausing ? "Posting resumed." : "Posting paused.",
    }).then((result) => {
      if (result.ok) router.refresh();
    });
  }

  return (
    <tr className={hidden ? "posting-row posting-row--hidden" : "posting-row"} data-hidden={hidden ? "true" : undefined}>
      <td>
        <Link className="link" href={`/jobs/${posting.id}`}>
          {posting.role_title}
        </Link>
        <span className="table__meta">{posting.org_label}</span>
      </td>
      <td>
        <StatusPill value={posting.status} />
      </td>
      <td>
        <StatusPill value={posting.verification_status} />
      </td>
      <td>
        <div className="visibility">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={!hidden}
            aria-label={hidden ? "Hidden from workers — unhide" : "Visible to workers — hide"}
            title={hidden ? "Hidden by BadaBhai — unhide" : "Visible to workers — hide"}
            disabled={!mayManage || busy}
            onClick={toggleVisibility}
          >
            <span className="switch__thumb" />
          </button>
          <span className="switch-row__state">{hidden ? "Hidden" : "Visible"}</span>
          {hidden ? (
            <StatusPill
              value="hidden"
              label="Hidden by BadaBhai"
              tone="bad"
              title={
                posting.hidden_reason_text ??
                posting.hidden_reason_code ??
                "Hidden from the worker feed and every search."
              }
            />
          ) : null}
        </div>
        {hidden && posting.hidden_reason_text ? (
          <p className="table__meta">Reason: {posting.hidden_reason_text}</p>
        ) : null}
        {busy ? <p className="table__meta">Checking applicants…</p> : null}
      </td>
      <td>
        <time dateTime={posting.created_at} title={timestampTitle(posting.created_at)}>
          {formatRelative(posting.created_at)}
        </time>
      </td>
      <td>
        {mayManage ? (
          <div className="row-actions">
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => setEditOpen(true)}
              disabled={posting.status === "closed"}
            >
              <Icon name={ACTION_ICON.edit} />
              <span>Edit</span>
            </button>
            {posting.status === "open" || posting.status === "paused" ? (
              <button className="btn btn--ghost btn--sm" type="button" onClick={togglePause}>
                <Icon
                  name={posting.status === "open" ? ACTION_ICON.suspend : ACTION_ICON.reinstate}
                />
                <span>{posting.status === "open" ? "Pause" : "Resume"}</span>
              </button>
            ) : null}
            {posting.status !== "closed" ? (
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => setDialog("close")}
              >
                <Icon name={ACTION_ICON.close} />
                <span>Close</span>
              </button>
            ) : null}
            {posting.verification_status !== "verified" ? (
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => setDialog("verify")}
              >
                <Icon name={ACTION_ICON.approve} />
                <span>Verify</span>
              </button>
            ) : null}
            {posting.verification_status !== "rejected" ? (
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => setDialog("reject")}
              >
                <Icon name={ACTION_ICON.reject} />
                <span>Reject</span>
              </button>
            ) : null}
            {mayReadEvents ? (
              <Link className="btn btn--ghost btn--sm" href={`/jobs/${posting.id}/timeline`}>
                <Icon name={ACTION_ICON.timeline} />
                <span>Timeline</span>
              </Link>
            ) : null}
            {outcome ? (
              <AdminActionResultBanner outcome={outcome} eventsLink={eventsLink} />
            ) : null}
          </div>
        ) : (
          <Link className="btn btn--ghost btn--sm" href={`/jobs/${posting.id}`}>
            Open posting
          </Link>
        )}

        <PostingEditDrawer
          postingId={posting.id}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          timelineHref={eventsLink?.href ?? null}
        />

      <ConfirmDialog
        open={dialog === "hide"}
        onClose={() => setDialog(null)}
        tier="consequential"
        title="Hide this posting?"
        description="It has applicants, so hiding needs a reason. This is still reversible with Undo for eight seconds after it is hidden."
        changes={[
          { label: "Visibility", before: "Visible", after: "Hidden" },
          { label: "Worker feed", before: "Listed", after: "Removed" },
        ]}
        categories={POSTING_REASON_CATEGORIES}
        confirmLabel="Hide posting"
        onConfirm={({ category, text }) =>
          hidePostingAction(posting.id, { reasonCode: category, reasonText: text })
        }
        onSettled={settled}
      />

      <ConfirmDialog
        open={dialog === "close"}
        onClose={() => setDialog(null)}
        tier="consequential"
        title="Close this posting?"
        description="Closing is final — a closed posting cannot be reopened. Use Pause for a reversible stop."
        changes={[{ label: "Status", before: posting.status, after: "Closed" }]}
        categories={POSTING_REASON_CATEGORIES}
        confirmLabel="Close posting"
        onConfirm={({ category, text }) =>
          closePostingAction(posting.id, { reasonCode: category, reasonText: text })
        }
        onSettled={settled}
      />

      <ConfirmDialog
        open={dialog === "verify"}
        onClose={() => setDialog(null)}
        tier="consequential"
        title="Verify this posting?"
        description="A verified posting carries the trust badge in the worker feed."
        changes={[
          {
            label: "Trust review",
            before: posting.verification_status,
            after: "Verified",
          },
        ]}
        categories={POSTING_VERIFICATION_REASON_CATEGORIES}
        confirmLabel="Verify posting"
        onConfirm={({ category, text }) =>
          verifyPostingAction(posting.id, { reasonCode: category, reasonText: text })
        }
        onSettled={settled}
      />

      <ConfirmDialog
        open={dialog === "reject"}
        onClose={() => setDialog(null)}
        tier="consequential"
        title="Reject this posting?"
        description="A rejected posting fails trust review and carries no verified badge."
        changes={[
          {
            label: "Trust review",
            before: posting.verification_status,
            after: "Rejected",
          },
        ]}
        categories={POSTING_VERIFICATION_REASON_CATEGORIES}
        confirmLabel="Reject posting"
        onConfirm={({ category, text }) =>
          rejectPostingAction(posting.id, { reasonCode: category, reasonText: text })
        }
        onSettled={settled}
      />
      </td>
    </tr>
  );
}
