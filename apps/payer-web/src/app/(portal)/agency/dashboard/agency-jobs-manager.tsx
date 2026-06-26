"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgencyJob } from "../../../../lib/contracts";
import {
  day,
  experienceBandLabel,
  isActiveJob,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "../../../../lib/agency-view";
import { Badge, Button, Card } from "../../../../components/ds";
import { AgencyJobForm } from "./agency-job-form";
import {
  closeAgencyJobAction,
  createAgencyJobAction,
  pauseAgencyJobAction,
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

/** The DS Badge tone for a vacancy's REAL state (reflects `status`, never invented). */
function statusTone(active: boolean): "success" | "neutral" {
  return active ? "success" : "neutral";
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
            setEditingId(null);
            setCreating((v) => !v);
          }}
        >
          {creating ? "Close form" : "Post a vacancy"}
        </Button>
      </div>

      {creating ? (
        <Card className="agency-jobs__createcard">
          <h3 className="agency-jobs__createtitle">Post a vacancy</h3>
          <AgencyJobForm
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
            const editing = editingId === j.id;
            return (
              <Card key={j.id} className="agency-job">
                <div className="agency-job__main">
                  <div className="agency-job__head">
                    <span className="agency-job__title">{j.title}</span>
                    <Badge tone={statusTone(active)} upper>
                      {active ? "open" : "closed"}
                    </Badge>
                  </div>
                  <div className="agency-job__meta">
                    <span>{tradeLabel(j.tradeKey)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{[j.city, j.area].filter(Boolean).join(" · ") || "—"}</span>
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
                  {active ? (
                    <div className="agency-job__btns">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        iconLeft="pencil-simple"
                        onClick={() => {
                          setCreating(false);
                          setEditingId((cur) => (cur === j.id ? null : j.id));
                        }}
                      >
                        {editing ? "Close edit" : "Edit"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        iconLeft="pause"
                        onClick={() => runLifecycle(j.id, () => pauseAgencyJobAction({ jobId: j.id }))}
                      >
                        {busy ? "Working…" : "Pause"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        iconLeft="x-circle"
                        onClick={() => runLifecycle(j.id, () => closeAgencyJobAction({ jobId: j.id }))}
                      >
                        {busy ? "Working…" : "Close"}
                      </Button>
                    </div>
                  ) : (
                    <span className="agency-job__closed">Closed</span>
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
                          const res = await updateAgencyJobAction(j.id, input);
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
