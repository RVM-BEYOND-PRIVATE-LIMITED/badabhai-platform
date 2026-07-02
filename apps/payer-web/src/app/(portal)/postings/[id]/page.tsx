import Link from "next/link";
import { notFound } from "next/navigation";
import { getPosting } from "../../../../lib/payer-api";
import { requirePayer } from "../../../../lib/auth";
import { boostTiers, postingPlanTiers } from "../../../../lib/pricing-config";
import type { PostingSummary } from "../../../../lib/contracts";
import { Badge, Card, Toast } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";
import { PostingBuyPanel, type BoostTierOption, type PlanTierOption } from "./posting-buy-panel";

export const dynamic = "force-dynamic";

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

function statusTone(status: PostingSummary["status"]): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

/**
 * Company POSTING-DETAIL page (B3 / #179) — the faceless posting summary + the plan/boost BUY UI.
 *
 * The posting is a LIVE payer-authed read (GET /payer/job-postings/:id, XB-A: the seam binds to
 * the server-held session — the client never passes a payer id). An unknown OR not-owned id
 * returns the SAME neutral 404 (no-oracle) → `notFound()`. The buy panel MIRRORS the capacity buy
 * UX: plan/boost tiers come from CONFIG, and buying sends ONLY a tier CODE (+ optional coupon) to
 * the mock-money Server Action (XT5: never a price/amount; XB-A: never a payer_id — the id rides
 * the PATH). Money is MOCK — the copy says so; there is no card field, no real payment.
 *
 * FACELESS: the posting row carries only the payer's OWN fields (role / location / vacancy band /
 * status / created date) — no worker name/phone ever reaches the DOM (applicants are a separate
 * faceless reach feed, linked below).
 */
export default async function PostingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // Narrow the config'd codes to the buy panel's literal-union (a code outside the known set is
  // dropped — the backend Zod enum is the AUTHORITY; the panel only offers what it can name).
  const planTiers: PlanTierOption[] = postingPlanTiers().filter(
    (t): t is PlanTierOption => t.code === "standard" || t.code === "pro",
  );
  const boostOptions: BoostTierOption[] = boostTiers().filter(
    (t): t is BoostTierOption => t.code === "all_candidates",
  );

  let posting: PostingSummary | null = null;
  let error: string | null = null;
  try {
    posting = await getPosting(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // no-oracle: an unknown OR not-owned posting is a neutral not-found (never leaks existence).
  if (!error && posting === null) notFound();

  return (
    <>
      <p className="posting-detail__back">
        <Link href="/postings">← Manage {isAgency ? "vacancies" : "postings"}</Link>
      </p>

      {error || !posting ? (
        <Card variant="outline" className="posting-detail__state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="posting-detail__state-msg">
            We couldn&rsquo;t load this posting right now. Please retry.
          </p>
          <RetryButton />
        </Card>
      ) : (
        <>
          <div className="posting-detail__head">
            <h1 className="dash-title">{posting.roleTitle}</h1>
            <Badge tone={statusTone(posting.status)} upper>
              {posting.status}
            </Badge>
          </div>
          <p className="dash-sub">
            {posting.locationLabel ?? "Location flexible"} · {posting.vacancyBand} vacancies ·
            Posted <span className="bb-mono">{day(posting.createdAt)}</span>
          </p>
          <p className="posting-detail__links">
            <Link href={`/postings/${posting.id}/applicants`}>View applicants →</Link>
          </p>

          <section className="posting-buy">
            <h2 className="posting-buy__heading">Buy a plan or boost</h2>
            <p className="dash-sub">
              Buy a plan to see more applicants, or a boost to broadcast this posting to all
              candidates. Prices are <strong>mock</strong> — no real payment is taken.
            </p>
            <PostingBuyPanel
              postingId={posting.id}
              planTiers={planTiers}
              boostOptions={boostOptions}
            />
            <div className="posting-buy__nudge">
              <Toast tone="neutral">
                <strong>Mock payments only.</strong> No card details are collected and no money
                moves. Real checkout (Razorpay) is a separate, human-gated rollout (ADR-0019
                Decision D).
              </Toast>
            </div>
          </section>
        </>
      )}
    </>
  );
}
