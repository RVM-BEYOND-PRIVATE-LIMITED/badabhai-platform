"use client";

import { useState } from "react";
import Link from "next/link";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card } from "../../../components/ds";
import { pausePostingAction, resumePostingAction } from "./actions";

/**
 * Client job-management surface (ADR-0019 Phase 1) — DS2.2 re-skin onto the BadaBhai
 * Design System.
 *
 * Runs in the BROWSER and sees NO secret. Each posting renders as a DS Card with its
 * real `status` Badge, the per-posting applicant count in mono tabular, and a link to its
 * own faceless applicant feed (a LIVE payer-authed read; XB-A binds tenancy to the
 * server-held session — the client never passes a payer id).
 *
 * PAUSE / RESUME (LIVE, feature #178): an OPEN posting offers Pause; a PAUSED posting
 * shows a paused Badge + a Resume affordance. Both call the Server Actions, which bind to
 * the server-held payer (the payer JWT, XB-A — the client sends only the posting id) and
 * hit the payer-authed `POST /payer/job-postings/:id/pause|resume`. The row updates in
 * place from the returned faceless posting. A posting that isn't the caller's returns the
 * SAME neutral not-found (no cross-tenant existence oracle) → a retryable inline error.
 *
 * APPLICANT-QUOTA TOP-UP stays GATED: its top-up rides the paid posting-plan money surface,
 * not this faceless row, so it renders as a disabled "coming soon" DS Button (never a fake
 * live route). Its step copy stays config-derived upstream.
 *
 * LOADING / A11Y-OF-FAILURE (B8): each row tracks its OWN busy + error; the acting Button
 * shows the DS `loading` spinner + `aria-busy` + disabled while pending, and every row keeps
 * an `aria-live="polite"` region so a per-row failure is announced without blanking the row.
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

const EMPTY_ROW: RowState = { busy: false, error: null };

export function PostingsManager({ postings }: { postings: PostingSummary[] }) {
  // LOCAL row overrides: after a pause/resume the returned posting replaces the seed row so the
  // status Badge + affordance flip in place without a full-page reload. Keyed by posting id.
  const [overrides, setOverrides] = useState<Record<string, PostingSummary>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  function stateOf(id: string): RowState {
    return rowState[id] ?? EMPTY_ROW;
  }
  function patch(id: string, p: Partial<RowState>) {
    setRowState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ROW), ...p } }));
  }

  // Pause / Resume the row via the Server Action (XB-A: id only, no payer id). On success the
  // returned faceless posting replaces the row; a neutral not-found OR a transient failure both
  // surface a retryable inline error (no-oracle: the row is never blanked or removed).
  async function onLifecycle(id: string, action: "pause" | "resume") {
    patch(id, { busy: true, error: null });
    const res = await (action === "pause"
      ? pausePostingAction({ postingId: id })
      : resumePostingAction({ postingId: id }));
    if (res.ok) {
      setOverrides((prev) => ({ ...prev, [id]: res.posting }));
      patch(id, { busy: false, error: null });
    } else {
      patch(id, { busy: false, error: res.error });
    }
  }

  if (postings.length === 0) {
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
      {postings.map((seed) => {
        // The LOCAL override (from a pause/resume) wins over the seed row so the status flips in place.
        const p = overrides[seed.id] ?? seed;
        const row = stateOf(p.id);
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
              </div>
            </div>

            <div className="posting-card__actions">
              <div className="posting-card__btns">
                {/* PAUSE / RESUME — LIVE. A paused posting offers Resume; open offers Pause. Both
                    are disabled for draft/closed (not a valid open<->paused transition). */}
                {p.status === "paused" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="play"
                    disabled={row.busy}
                    loading={row.busy}
                    aria-busy={row.busy}
                    onClick={() => onLifecycle(p.id, "resume")}
                  >
                    {row.busy ? "Resuming…" : row.error ? "Retry resume" : "Resume"}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="pause"
                    disabled={row.busy || p.status !== "open"}
                    loading={row.busy}
                    aria-busy={row.busy}
                    title={p.status !== "open" ? "Only an open posting can be paused" : undefined}
                    onClick={() => onLifecycle(p.id, "pause")}
                  >
                    {row.busy ? "Pausing…" : row.error ? "Retry pause" : "Pause"}
                  </Button>
                )}
                {/* Applicant-quota top-up stays gated (rides the paid posting-plan surface). */}
                <Button variant="secondary" size="sm" disabled iconLeft="plus-circle">
                  Top up applicant quota
                </Button>
              </div>
              <p className="posting-card__soon">
                Applicant-quota top-up is <strong>coming soon</strong> (rides the paid plan surface).
              </p>
              {/* B8 — per-row error region announces a pause/resume failure without blanking the row. */}
              <div aria-live="polite">
                {row.error ? <p className="posting-card__error">{row.error}</p> : null}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
