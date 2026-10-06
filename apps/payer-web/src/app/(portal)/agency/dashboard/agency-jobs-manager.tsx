"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { AgencyJob } from "../../../../lib/contracts";
import {
  day,
  experienceBandLabel,
  isActiveJob,
  isPausedJob,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "../../../../lib/agency-view";
import { bandLabel } from "../../../../lib/masking";
import { Badge, Button, Card } from "../../../../components/ds";
import { AgencyJobForm } from "./agency-job-form";
import {
  closeAgencyJobAction,
  pauseAgencyJobAction,
  resumeAgencyJobAction,
  updateAgencyJobAction,
  type AgencyJobActionResult,
} from "./jobs-actions";

/**
 * Client management surface for an agency's OWN postings (ADR-0022, LIVE) — the body of the
 * Postings page (`/agency/jobs`). DS3.1 skin.
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to the
 * server-held payer (the payer JWT, XB-A) — the client passes ONLY a job id + coarse,
 * non-PII demand fields, NEVER a payer id. EDIT happens inline; CREATE is its own page
 * (`/agency/jobs/new`, the "New posting" entry point everywhere), so this list carries no
 * second create control. Every posting renders as a DS `Card`: bands + a count + a status
 * `Badge`; no worker identity, no employer name (faceless/coarse). ₹ pay band + counts render
 * in mono tabular (`bb-mono`). A not-found/not-owned action result reads neutrally (no oracle).
 * Like a company row, the TITLE opens the posting's details, and each row also links the job's
 * REAL applicants (#1956 — the feed serves the workers who applied since #1955). Tokens only
 * (no raw hex/px).
 */

/** The DS Badge tone for a posting's REAL state (reflects `status`, never invented). 4-state now. */
function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

/** The card that hosts the inline editor: the posting's own row. */
const rowHostId = (jobId: string) => `agency-job-${jobId}`;
/** A row's Edit / Cancel toggle — a STABLE id, so focus can find it again (`refocusToggle`). */
const rowToggleId = (jobId: string) => `agency-job-edit-${jobId}`;

/**
 * Opening an inline editor brings its host card to the preview rail's sticky line (CSS
 * `scroll-margin-top`), so the worker card and the form's actions are on screen from the first
 * field — not 300px down the dashboard. Runs after React has committed the opened form.
 */
function revealEditor(hostId: string) {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    document.getElementById(hostId)?.scrollIntoView({ block: "start" });
  });
}

/**
 * Opening or closing a row's editor MOVES the row's header (it leads the editor's form column
 * while editing), so React rebuilds the header — and the toggle the payer just pressed, whose
 * focus would fall to <body>. Focus goes back to the REBUILT toggle (found by its stable id, and
 * known by where it now sits: inside the editor's lead exactly when the row is editing — a frame
 * that still shows the old one waits for the next, so a slow commit after a save cannot win the
 * race). On open it adds no scroll of its own (`revealEditor`, scheduled first, owns that); on
 * close it scrolls the toggle into view (Cancel or a save can be far down the form).
 *
 * It only puts back focus the rebuild DROPPED (to <body>). A save lands seconds after the press,
 * and a payer who moved on meanwhile — into another row's editor, onto another row's link — keeps
 * their focus and their scroll position: taking it back scrolled the page to the saved row
 * (measured 1428 → 0 at 1280) and the payer's next space pressed that row's Edit.
 */
function refocusToggle(jobId: string, opts: { editing: boolean; scroll: boolean }) {
  if (typeof window === "undefined") return;
  let frames = 0;
  const attempt = () => {
    const toggle = document.getElementById(rowToggleId(jobId));
    const rebuilt = toggle !== null && (toggle.closest(".agency-job__lead") !== null) === opts.editing;
    if (!rebuilt) {
      if (++frames < 10) window.requestAnimationFrame(attempt);
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) toggle.focus({ preventScroll: !opts.scroll });
  };
  window.requestAnimationFrame(attempt);
}

export function AgencyJobsManager({ jobs }: { jobs: AgencyJob[] }) {
  const router = useRouter();
  // useState call order (mirrored by agency-jobs-manager.test.tsx): rows, editingId, busyId,
  // errorById.
  const [rows, setRows] = useState<AgencyJob[]>(jobs);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const [, startTransition] = useTransition();

  function setError(id: string, error: string | null) {
    setErrorById((prev) => ({ ...prev, [id]: error }));
  }

  function upsertRow(job: AgencyJob) {
    setRows((prev) => {
      const i = prev.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
  }

  function runLifecycle(id: string, action: () => Promise<AgencyJobActionResult>) {
    setError(id, null);
    setBusyId(id);
    startTransition(async () => {
      const res = await action();
      setBusyId(null);
      if (res.ok) {
        upsertRow(res.job);
        router.refresh();
      } else {
        setError(id, res.error);
      }
    });
  }

  return (
    <div className="agency-jobs">
      {rows.length === 0 ? (
        // The same empty-state pattern as the company list; what to do next is the page head's
        // one primary action, "New posting", which the copy names instead of repeating.
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.posting} />
            </span>
            <h2 className="state__title">No postings yet</h2>
            <p className="state__body">
              Matched workers can only find your agency once a role is live — use New posting
              above. Posting is free through launch.
            </p>
          </div>
        </Card>
      ) : (
        <div className="agency-jobs__list">
          {rows.map((j) => {
            const busy = busyId === j.id;
            const err = errorById[j.id] ?? null;
            const active = isActiveJob(j);
            const paused = isPausedJob(j);
            const editing = editingId === j.id;
            const header = (
              <>
                <div className="agency-job__main">
                  <div className="agency-job__head">
                    <Link className="agency-job__title" href={`/agency/jobs/${j.id}`}>
                      {j.title}
                    </Link>
                    <Badge tone={statusTone(j.status)} upper>
                      {j.status}
                    </Badge>
                  </div>
                  <div className="agency-job__meta">
                    <span>{tradeLabel(j.tradeKey)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{bandLabel([j.city, j.area]) || "—"}</span>
                    <span aria-hidden="true">·</span>
                    <span className="bb-mono">{payBandLabel(j.payMin, j.payMax)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{experienceBandLabel(j.minExperienceYears, j.maxExperienceYears)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Needed {neededByLabel(j.neededBy)}</span>
                  </div>
                  <div className="agency-job__meta">
                    <span>
                      <span className="bb-mono">{j.applicantsReceived}</span> applicants
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Posted <span className="bb-mono">{day(j.createdAt)}</span>
                    </span>
                  </div>
                </div>

                <div className="agency-job__actions">
                  <Link
                    className="bb-btn bb-btn--secondary bb-btn--sm"
                    href={`/agency/jobs/${j.id}/applicants`}
                  >
                    <Icon name={ACTION_ICON.users} />
                    <span>Applicants</span>
                  </Link>
                  {active || paused ? (
                    <div className="agency-job__btns">
                      <Button
                        id={rowToggleId(j.id)}
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        iconLeft={ACTION_ICON.edit}
                        onClick={() => {
                          const opening = !editing;
                          setEditingId(opening ? j.id : null);
                          if (opening) revealEditor(rowHostId(j.id));
                          refocusToggle(j.id, { editing: opening, scroll: !opening });
                        }}
                      >
                        {/* "Cancel", not "Close edit": "Close" is this row's terminal action. */}
                        {editing ? "Cancel" : "Edit"}
                      </Button>
                      {active ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          loading={busy}
                          iconLeft="pause"
                          onClick={() => runLifecycle(j.id, () => pauseAgencyJobAction({ jobId: j.id }))}
                        >
                          {busy ? "Working…" : "Pause"}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          loading={busy}
                          iconLeft="play"
                          onClick={() => runLifecycle(j.id, () => resumeAgencyJobAction({ jobId: j.id }))}
                        >
                          {busy ? "Working…" : "Resume"}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        loading={busy}
                        iconLeft={ACTION_ICON.reject}
                        onClick={() => runLifecycle(j.id, () => closeAgencyJobAction({ jobId: j.id }))}
                      >
                        {busy ? "Working…" : "Close posting"}
                      </Button>
                    </div>
                  ) : (
                    <span className="agency-job__closed">
                      {j.status === "suspended" ? "Suspended" : "Closed"}
                    </span>
                  )}
                  <div aria-live="polite" className="agency-job__status">
                    {err ? <p className="agency-job__error">{err}</p> : null}
                  </div>
                </div>
              </>
            );
            return (
              <Card
                key={j.id}
                id={rowHostId(j.id)}
                className={editing ? "agency-job agency-job--editing" : "agency-job"}
              >
                {editing ? (
                  // EDIT: the row's own header leads the form column, so the preview rail starts
                  // at the top of the row — level with the header, not below it.
                  <AgencyJobForm
                    lead={<div className="agency-job__lead">{header}</div>}
                    mode="edit"
                    job={j}
                    submitLabel="Save changes"
                    onCancel={() => {
                      setEditingId(null);
                      refocusToggle(j.id, { editing: false, scroll: true });
                    }}
                    onSubmit={async (input) => {
                      // Pass the current row as `initial` so the seam computes the clear diff.
                      const res = await updateAgencyJobAction(j.id, input, j);
                      if (res.ok) {
                        upsertRow(res.job);
                        // Close only THIS editor: the payer may have opened another row's
                        // editor while the save was in flight.
                        setEditingId((cur) => (cur === j.id ? null : cur));
                        refocusToggle(j.id, { editing: false, scroll: true });
                        router.refresh();
                        return { ok: true };
                      }
                      return { ok: false, error: res.error };
                    }}
                  />
                ) : (
                  header
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
