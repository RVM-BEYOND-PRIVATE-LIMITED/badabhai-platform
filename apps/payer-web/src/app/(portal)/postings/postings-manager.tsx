"use client";

import Link from "next/link";
import { useState } from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card } from "../../../components/ds";
import {
  closePostingAction,
  pausePostingAction,
  resumePostingAction,
  topUpQuotaAction,
} from "./actions";

/**
 * Client job-management surface (ADR-0019 Phase 1) — DS2.2 skin, LIVE lifecycle.
 *
 * Runs in the BROWSER and sees NO secret. Each posting renders as a DS Card with its
 * real `status` Badge and links to its manage page + faceless applicant feed (XB-A: the
 * Server Actions bind tenancy to the server-held session — the client never passes a
 * payer id, only the posting id).
 *
 * The trio (pause / resume / quota top-up) + CLOSE are LIVE payer-authed routes
 * (`POST /payer/job-postings/:id/{pause|resume|quota-topup|close}`, #178/#180). Each
 * action is per-row busy-guarded; a failure renders a retryable inline error in the
 * row's aria-live region — never fake data, never a blanked row.
 *
 * FACELESS: a posting row carries only the payer's OWN fields (role / location / vacancy
 * band / status / applicant count / created date) — no worker name/phone ever reaches the DOM.
 */

const NONE = "—";

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/** The DS Badge tone for a posting's REAL lifecycle status (reflects `status`, never invented). */
function statusTone(status: PostingSummary["status"]): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused") return "warning";
  // draft + closed read as a muted/neutral status chip.
  return "neutral";
}

interface RowState {
  busy: boolean;
  error: string | null;
}

const IDLE: RowState = { busy: false, error: null };

export function PostingsManager({ postings }: { postings: PostingSummary[] }) {
  // Rows are seeded from the server payload and patched with each action's returned
  // posting (the fresh backend row) so status/quota reflect reality without a reload.
  const [rows, setRows] = useState<PostingSummary[]>(postings);
  const [state, setState] = useState<Record<string, RowState>>({});

  function rowState(id: string): RowState {
    return state[id] ?? IDLE;
  }
  function patchState(id: string, p: Partial<RowState>) {
    setState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE), ...p } }));
  }

  async function run(
    id: string,
    action: (input: { postingId: string }) => Promise<
      { ok: true; posting: PostingSummary } | { ok: false; error: string }
    >,
  ) {
    patchState(id, { busy: true, error: null });
    const res = await action({ postingId: id });
    if (res.ok) {
      setRows((prev) => prev.map((p) => (p.id === id ? res.posting : p)));
      patchState(id, { busy: false });
    } else {
      patchState(id, { busy: false, error: res.error });
    }
  }

  if (rows.length === 0) {
    return (
      <Card variant="flat" className="postings-empty">
        You haven&rsquo;t posted a job yet.{" "}
        <Link className="postings-link" href="/postings/new">
          Post your first job
        </Link>{" "}
        — free through launch.
      </Card>
    );
  }

  return (
    <div className="postings-list">
      {rows.map((p) => {
        const rs = rowState(p.id);
        return (
          <Card key={p.id} padding="md" className="posting-card">
            <div className="posting-card__main">
              <div className="posting-card__head">
                <Link className="posting-card__title" href={`/postings/${p.id}/applicants`}>
                  {p.roleTitle}
                </Link>
                <Badge tone={statusTone(p.status)} upper>
                  {p.status}
                </Badge>
              </div>
              <div className="posting-card__meta">
                <span>{p.locationLabel ?? "Location flexible"}</span>
                <span aria-hidden="true">·</span>
                <span>{p.vacancyBand} vacancies</span>
                <span aria-hidden="true">·</span>
                <span>
                  <span className="bb-mono">{p.applicantCount}</span> /{" "}
                  <span className="bb-mono">{p.applicantQuota ?? NONE}</span> applicants
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Posted <span className="bb-mono">{day(p.createdAt)}</span>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  <Link className="postings-link" href={`/postings/${p.id}`}>
                    Details
                  </Link>{" "}
                  <Link className="postings-link" href={`/postings/${p.id}/edit`}>
                    Edit
                  </Link>
                </span>
              </div>
            </div>

            <div className="posting-card__actions">
              {/* LIVE lifecycle trio + close (#178/#180) — per-row busy + inline error. */}
              <div className="posting-card__btns">
                {p.status === "paused" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="play"
                    loading={rs.busy}
                    disabled={rs.busy}
                    onClick={() => void run(p.id, resumePostingAction)}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="pause"
                    loading={rs.busy}
                    disabled={rs.busy || p.status !== "open"}
                    onClick={() => void run(p.id, pausePostingAction)}
                  >
                    Pause
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft="plus-circle"
                  loading={rs.busy}
                  disabled={rs.busy || p.status === "closed"}
                  onClick={() => void run(p.id, topUpQuotaAction)}
                >
                  Top up applicant quota
                </Button>
                {(p.status === "draft" || p.status === "open") && (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="x-circle"
                    loading={rs.busy}
                    disabled={rs.busy}
                    onClick={() => void run(p.id, closePostingAction)}
                  >
                    Close
                  </Button>
                )}
              </div>
              {/* B8 — the per-row error region is announceable (aria-live) + retryable. */}
              <div aria-live="polite">
                {rs.error !== null && <p className="posting-card__soon">{rs.error}</p>}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
