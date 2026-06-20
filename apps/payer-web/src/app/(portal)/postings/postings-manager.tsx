"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PostingSummary } from "../../../lib/contracts";
import { pausePostingAction, resumePostingAction, topUpQuotaAction } from "./actions";

/**
 * Client job-management table (ADR-0019 Phase 1 — WAITING mock).
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to
 * the server-held payer (XB-A) — the client passes ONLY a posting id. The quota TOP-UP
 * step is config-derived server-side; this component never names a price or quota
 * literal. Each action updates only the row it affects.
 */

const ZERO = "—";

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

export function PostingsManager({ postings }: { postings: PostingSummary[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<PostingSummary[]>(postings);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const [, startTransition] = useTransition();

  function setError(id: string, error: string | null) {
    setErrorById((prev) => ({ ...prev, [id]: error }));
  }

  function applyUpdate(updated: PostingSummary) {
    setRows((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function run(
    id: string,
    action: () => Promise<{ ok: true; posting: PostingSummary } | { ok: false; error: string }>,
  ) {
    setError(id, null);
    setBusyId(id);
    startTransition(async () => {
      const res = await action();
      setBusyId(null);
      if (res.ok) {
        applyUpdate(res.posting);
        router.refresh();
      } else {
        setError(id, res.error);
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        You haven&rsquo;t posted a job yet. <Link href="/postings/new">Post your first job</Link> —
        free through launch.
      </div>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Role</th>
          <th>Location</th>
          <th>Vacancies</th>
          <th>Status</th>
          <th>Applicants / quota</th>
          <th>Posted</th>
          <th>Manage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const busy = busyId === p.id;
          const err = errorById[p.id] ?? null;
          return (
            <tr key={p.id}>
              <td>
                <Link href={`/postings/${p.id}/applicants`}>{p.roleTitle}</Link>
              </td>
              <td>{p.locationLabel ?? ZERO}</td>
              <td>{p.vacancyBand}</td>
              <td>
                <span
                  className={
                    p.status === "open"
                      ? "badge badge-ok"
                      : p.status === "paused"
                        ? "badge badge-warn"
                        : "badge"
                  }
                >
                  {p.status}
                </span>
              </td>
              <td className="mono">
                {p.applicantCount} / {p.applicantQuota ?? ZERO}
              </td>
              <td className="mono">{day(p.createdAt)}</td>
              <td>
                <div className="btn-row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {p.status === "paused" ? (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => run(p.id, () => resumePostingAction({ postingId: p.id }))}
                    >
                      {busy ? "Working…" : "Resume"}
                    </button>
                  ) : p.status === "open" ? (
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => run(p.id, () => pausePostingAction({ postingId: p.id }))}
                    >
                      {busy ? "Working…" : "Pause"}
                    </button>
                  ) : null}
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => run(p.id, () => topUpQuotaAction({ postingId: p.id }))}
                  >
                    {busy ? "Working…" : "Top up applicant quota"}
                  </button>
                </div>
                {err ? <p className="error-text">{err}</p> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
