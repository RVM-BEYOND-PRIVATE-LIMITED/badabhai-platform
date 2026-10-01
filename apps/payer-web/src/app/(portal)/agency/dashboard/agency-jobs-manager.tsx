"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  createAgencyJobAction,
  pauseAgencyJobAction,
  resumeAgencyJobAction,
  updateAgencyJobAction,
  type AgencyJobActionResult,
} from "./jobs-actions";

/**
 * Client vacancy-management surface for the agency dashboard (ADR-0022, LIVE) — DS3.1
 * re-skin onto the BadaBhai Design System (VISUAL layer only).
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to the
 * server-held payer (the payer JWT, XB-A) — the client passes ONLY a job id + coarse,
 * non-PII demand fields, NEVER a payer id. Create + edit happen INLINE (no separate
 * route). Every vacancy renders as a DS `Card`: opaque id + bands + a count + a status
 * `Badge`; no worker identity, no employer name (faceless/coarse). ₹ pay band + counts
 * render in mono tabular (`bb-mono`). A not-found/not-owned action result reads neutrally
 * (no oracle). The post/edit/pause/close are DS `Button`s wired to the SAME live actions
 * as before — the re-skin changes presentation only; pause + close stay LIVE (the agency
 * status is `open|closed`, pause == close). Tokens only (no raw hex/px).
 */

/** The DS Badge tone for a vacancy's REAL state (reflects `status`, never invented). 4-state now. */
function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

/** The card that hosts an inline editor: the create card, or the vacancy's own row. */
const CREATE_HOST_ID = "agency-create";
const rowHostId = (jobId: string) => `agency-job-${jobId}`;

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

export function AgencyJobsManager({ jobs }: { jobs: AgencyJob[] }) {
  const router = useRouter();
  // useState call order (mirrored by agency-jobs-manager.test.tsx): rows, creating, editingId,
  // busyId, errorById.
  const [rows, setRows] = useState<AgencyJob[]>(jobs);
  const [creating, setCreating] = useState(false);
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
      <div className="agency-jobs__bar">
        <Button
          variant={creating ? "secondary" : "primary"}
          iconLeft={creating ? "x" : "plus-circle"}
          onClick={() => {
            const opening = !creating;
            setEditingId(null);
            setCreating(opening);
            if (opening) revealEditor(CREATE_HOST_ID);
          }}
        >
          {creating ? "Close form" : "Post a vacancy"}
        </Button>
      </div>

      {creating ? (
        <Card id={CREATE_HOST_ID} className="agency-jobs__createcard">
          <AgencyJobForm
            lead={<h3 className="agency-jobs__createtitle">Post a vacancy</h3>}
            mode="create"
            submitLabel="Post vacancy"
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              const res = await createAgencyJobAction(input);
              if (res.ok) {
                upsertRow(res.job);
                setCreating(false);
                router.refresh();
                return { ok: true };
              }
              return { ok: false, error: res.error };
            }}
          />
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <Card variant="flat" className="agency-jobs__empty">
          You haven&rsquo;t posted a vacancy yet — post your first one above. It&rsquo;s free
          through launch.
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
                    <span className="agency-job__title">{j.title}</span>
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
                    <span aria-hidden="true">·</span>
                    <span>
                      <Link className="postings-link" href={`/agency/jobs/${j.id}`}>
                        Details
                      </Link>
                    </span>
                  </div>
                </div>

                <div className="agency-job__actions">
                  {active || paused ? (
                    <div className="agency-job__btns">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        iconLeft="pencil-simple"
                        onClick={() => {
                          const opening = !editing;
                          setCreating(false);
                          setEditingId(opening ? j.id : null);
                          if (opening) revealEditor(rowHostId(j.id));
                        }}
                      >
                        {editing ? "Close edit" : "Edit"}
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
                        iconLeft="x-circle"
                        onClick={() => runLifecycle(j.id, () => closeAgencyJobAction({ jobId: j.id }))}
                      >
                        {busy ? "Working…" : "Close"}
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
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (input) => {
                      // Pass the current row as `initial` so the seam computes the clear diff.
                      const res = await updateAgencyJobAction(j.id, input, j);
                      if (res.ok) {
                        upsertRow(res.job);
                        setEditingId(null);
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
