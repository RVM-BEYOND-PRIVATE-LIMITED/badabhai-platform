"use client";

import Link from "next/link";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card } from "../../../components/ds";

/**
 * Client job-management surface (ADR-0019 Phase 1) — DS2.2 re-skin onto the BadaBhai
 * Design System (VISUAL layer only).
 *
 * Runs in the BROWSER and sees NO secret. Each posting renders as a DS Card with its
 * real `status` Badge, the per-posting applicant count in mono tabular, and a link to its
 * own faceless applicant feed (a LIVE payer-authed read; XB-A binds tenancy to the
 * server-held session — the client never passes a payer id).
 *
 * GATED TRIO (pause / resume / quota top-up): there is NO payer-authed company
 * pause/resume/quota route yet (the underlying job-postings controller is
 * InternalServiceGuard — see payer-api.ts `// LIVE-SWAP BLOCKED`). So these are rendered
 * as visibly DISABLED DS Buttons with a "coming soon" note — never broken, never silently
 * missing, and never wired to a fake live route. They stay flagged until the route lands.
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

export function PostingsManager({ postings }: { postings: PostingSummary[] }) {
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
      {postings.map((p) => (
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
              {/* Posting detail = the plan/boost BUY surface (FE-3 / #179). */}
              <Link className="postings-link" href={`/postings/${p.id}`}>
                Plans &amp; boost →
              </Link>
            </div>
          </div>

          <div className="posting-card__actions">
            {/* GATED TRIO — disabled with a coming-soon note (no payer-authed route yet). */}
            <div className="posting-card__btns">
              {p.status === "paused" ? (
                <Button variant="secondary" size="sm" disabled iconLeft="play">
                  Resume
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled iconLeft="pause">
                  Pause
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled iconLeft="plus-circle">
                Top up applicant quota
              </Button>
            </div>
            <p className="posting-card__soon">
              Pause, resume and applicant-quota top-up are{" "}
              <strong>coming soon</strong> (pending a payer-authed route).
            </p>
            {/* B8 — per-row error region stays announceable even though the trio is gated. */}
            <div aria-live="polite" />
          </div>
        </Card>
      ))}
    </div>
  );
}
