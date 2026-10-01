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
 * Tokens only (no raw hex/px).
 */

/** The DS Badge tone for a posting's REAL state (reflects `status`, never invented). 4-state now. */
function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
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
        <Card variant="flat" className="agency-jobs__empty">
          You haven&rsquo;t posted anything yet — use New posting to publish your first one.
          It&rsquo;s free through launch.
        </Card>
      ) : (
        <div className="agency-jobs__list">
          {rows.map((j) => {
            const busy = busyId === j.id;
            const err = errorById[j.id] ?? null;
            const active = isActiveJob(j);
            const paused = isPausedJob(j);
            const editing = editingId === j.id;
            return (
              <Card key={j.id} className="agency-job">
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
                        <Icon name={ACTION_ICON.view} /> Details
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
                        iconLeft={ACTION_ICON.edit}
                        onClick={() => setEditingId((cur) => (cur === j.id ? null : j.id))}
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
                  {editing ? (
                    <div className="agency-job__editform">
                      <AgencyJobForm
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
                    </div>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
