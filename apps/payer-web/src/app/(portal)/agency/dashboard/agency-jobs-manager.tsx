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
import { AgencyJobForm } from "./agency-job-form";
import {
  closeAgencyJobAction,
  createAgencyJobAction,
  pauseAgencyJobAction,
  updateAgencyJobAction,
  type AgencyJobActionResult,
} from "./jobs-actions";

/**
 * Client vacancy-management surface for the agency dashboard (ADR-0022, LIVE).
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to the
 * server-held payer (the payer JWT, XB-A) — the client passes ONLY a job id + coarse,
 * non-PII demand fields, NEVER a payer id. Create + edit happen INLINE (no separate
 * route). Every cell is faceless/coarse: opaque id + bands + a count; no worker identity,
 * no employer name. A not-found/not-owned action result reads neutrally (no oracle).
 */
export function AgencyJobsManager({ jobs }: { jobs: AgencyJob[] }) {
  const router = useRouter();
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
    <div>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button
          className="btn"
          type="button"
          onClick={() => {
            setEditingId(null);
            setCreating((v) => !v);
          }}
        >
          {creating ? "Close form" : "Post a vacancy"}
        </button>
      </div>

      {creating ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Post a vacancy</h3>
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
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty">
          You haven&rsquo;t posted a vacancy yet — post your first one above. It&rsquo;s free
          through launch.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Trade</th>
              <th>Location</th>
              <th>Pay band</th>
              <th>Experience</th>
              <th>Needed by</th>
              <th>Status</th>
              <th>Applicants</th>
              <th>Posted</th>
              <th>Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => {
              const busy = busyId === j.id;
              const err = errorById[j.id] ?? null;
              const active = isActiveJob(j);
              const editing = editingId === j.id;
              return (
                <tr key={j.id}>
                  <td>{j.title}</td>
                  <td>{tradeLabel(j.tradeKey)}</td>
                  <td>{[j.city, j.area].filter(Boolean).join(" · ")}</td>
                  <td className="mono">{payBandLabel(j.payMin, j.payMax)}</td>
                  <td>{experienceBandLabel(j.minExperienceYears, j.maxExperienceYears)}</td>
                  <td>{neededByLabel(j.neededBy)}</td>
                  <td>
                    <span className={active ? "badge badge-ok" : "badge"}>
                      {active ? "open" : "closed"}
                    </span>
                  </td>
                  <td className="mono">{j.applicantsReceived}</td>
                  <td className="mono">{day(j.createdAt)}</td>
                  <td>
                    <div className="btn-row" style={{ flexWrap: "wrap", gap: 6 }}>
                      {active ? (
                        <>
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setCreating(false);
                              setEditingId((cur) => (cur === j.id ? null : j.id));
                            }}
                          >
                            {editing ? "Close edit" : "Edit"}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => runLifecycle(j.id, () => pauseAgencyJobAction({ jobId: j.id }))}
                          >
                            {busy ? "Working…" : "Pause"}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => runLifecycle(j.id, () => closeAgencyJobAction({ jobId: j.id }))}
                          >
                            {busy ? "Working…" : "Close"}
                          </button>
                        </>
                      ) : (
                        <span className="page-sub">Closed</span>
                      )}
                    </div>
                    {err ? <p className="error-text">{err}</p> : null}
                    {editing ? (
                      <div className="card" style={{ marginTop: 8 }}>
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
