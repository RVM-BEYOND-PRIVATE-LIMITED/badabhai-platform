"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Card, Toast } from "../../../components/ds";
import { topUpQuotaAction } from "./actions";

/**
 * Client job-management surface (ADR-0019 Phase 1) — DS2.2 re-skin onto the BadaBhai
 * Design System (VISUAL layer only).
 *
 * Runs in the BROWSER and sees NO secret. Each posting renders as a DS Card with its
 * real `status` Badge, the per-posting applicant count in mono tabular, and a link to its
 * own faceless applicant feed (a LIVE payer-authed read; XB-A binds tenancy to the
 * server-held session — the client never passes a payer id).
 *
 * QUOTA TOP-UP is now LIVE (POST /payer/job-postings/:id/quota-topup, #180 / FE-4). Selecting
 * a config'd top-up tier sends ONLY the tier CODE + the posting id (XB-A: no payer_id; XT5: the
 * server prices it) via the Server Action; on success the REAL raised quota
 * (`applicantsUsed / applicantQuota`) is shown for that row and the counter increments. A
 * posting with no active plan to top up returns a neutral "not available" (no oracle). Money is
 * MOCK — the confirm copy says so; there is no card field.
 *
 * PAUSE / RESUME stay GATED (the backend lifecycle has no `paused` state) — rendered as visibly
 * DISABLED DS Buttons with a "coming soon" note, never wired to a fake live route.
 *
 * FACELESS: a posting row carries only the payer's OWN fields (role / location / vacancy
 * band / status / applicant count / created date) — no worker name/phone ever reaches the DOM.
 */

const NONE = "—";

export type QuotaTopUpTierOption = { code: string; priceInr: number; additionalVisibilityQuota: number };

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

/** The LIVE, per-row applicant-quota counter after a successful top-up (used / quota). */
type LiveQuota = { used: number; quota: number };

export function PostingsManager({
  postings,
  quotaTiers,
}: {
  postings: PostingSummary[];
  quotaTiers: QuotaTopUpTierOption[];
}) {
  const router = useRouter();
  // The SMALLEST config'd top-up tier is the one this "Top up applicant quota" button buys —
  // config-derived, never a page literal. `null` when the catalog carries no top-up product.
  const tier = quotaTiers.length > 0 ? quotaTiers[0]! : null;

  // Per-row LIVE quota (populated after a successful top-up) + the pending/error state.
  const [liveQuota, setLiveQuota] = useState<Record<string, LiveQuota>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  function onTopUp(postingId: string) {
    if (!tier) return;
    const ok = window.confirm(
      `Add ${tier.additionalVisibilityQuota} more applicant views for this posting? ` +
        "This is a mock top-up — no real payment is taken.",
    );
    if (!ok) return;
    setRowError((m) => ({ ...m, [postingId]: "" }));
    setPendingId(postingId);
    startTransition(async () => {
      const res = await topUpQuotaAction({ postingId, tier: tier.code });
      setPendingId(null);
      if (res.ok) {
        // Surface the REAL raised quota for this row (used / quota) — increments after each top-up.
        setLiveQuota((m) => ({
          ...m,
          [postingId]: { used: res.quota.applicantsUsed, quota: res.quota.applicantQuota },
        }));
        router.refresh();
      } else {
        setRowError((m) => ({ ...m, [postingId]: res.error }));
      }
    });
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
      {postings.map((p) => {
        // Prefer the LIVE, per-row quota once a top-up has returned it; else the row projection.
        const live = liveQuota[p.id];
        const usedDisplay = live ? live.used : p.applicantCount;
        const quotaDisplay = live ? String(live.quota) : (p.applicantQuota ?? NONE);
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
                  <span className="bb-mono">{usedDisplay}</span> /{" "}
                  <span className="bb-mono">{quotaDisplay}</span> applicants
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Posted <span className="bb-mono">{day(p.createdAt)}</span>
                </span>
              </div>
            </div>

            <div className="posting-card__actions">
              <div className="posting-card__btns">
                {/* PAUSE / RESUME stay gated (no `paused` state on the backend lifecycle). */}
                {p.status === "paused" ? (
                  <Button variant="secondary" size="sm" disabled iconLeft="play">
                    Resume
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" disabled iconLeft="pause">
                    Pause
                  </Button>
                )}
                {/* LIVE quota top-up (FE-4). Disabled when the catalog carries no top-up tier. */}
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft="plus-circle"
                  disabled={tier === null || pendingId !== null}
                  loading={pendingId === p.id}
                  onClick={() => onTopUp(p.id)}
                >
                  {pendingId === p.id ? "Adding…" : "Top up applicant quota"}
                </Button>
              </div>
              <p className="posting-card__soon">
                Pause and resume are <strong>coming soon</strong> (pending a payer-authed route).
              </p>
              {/* B8 — per-row result region (announceable). */}
              <div aria-live="polite">
                {rowError[p.id] ? <Toast tone="danger">{rowError[p.id]}</Toast> : null}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
