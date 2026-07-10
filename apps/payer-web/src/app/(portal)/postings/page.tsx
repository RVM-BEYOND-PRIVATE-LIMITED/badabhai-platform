import Link from "next/link";
import { getPostings } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { applicantQuotaStep } from "../../../lib/pricing-config";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { PostingsManager } from "./postings-manager";

export const dynamic = "force-dynamic";

/**
 * Manage job postings (ADR-0019 Phase 1) — DS2.2 re-skin onto the BadaBhai Design System
 * (VISUAL layer only). Lists the payer's OWN postings (XB-A: the seam binds to the
 * server-held session id) via the LIVE `GET /payer/job-postings` read. `postings/new`
 * owns CREATE; each row links to its own faceless applicant feed.
 *
 * The PAUSE / RESUME / quota TOP-UP / CLOSE lifecycle is LIVE: the payer-authed
 * `POST /payer/job-postings/:id/{pause|resume|quota-topup|close}` routes (#178/#180),
 * wired in the manager with per-row busy state + inline retryable errors.
 *
 * The quota top-up STEP copy is config-derived (catalog posting-quota tier) — this page
 * never hardcodes a quota number.
 */
export default async function PostingsPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const quotaStep = applicantQuotaStep();

  let postings: PostingSummary[] | null = null;
  let error: string | null = null;
  try {
    postings = await getPostings();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="postings-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="postings-title">Manage {isAgency ? "vacancies" : "postings"}</h1>
      <p className="postings-sub">
        Review a {isAgency ? "vacancy" : "posting"} and its applicants.{" "}
        <Link className="postings-link" href="/postings/new">
          {isAgency ? "Post a vacancy →" : "Post a job →"}
        </Link>
      </p>

      <Card variant="flat" className="postings-note">
        <Badge tone="info" upper>
          Applicant quota
        </Badge>
        <p className="postings-note__msg">
          Applicant quota is &ldquo;view more &rarr; pay more&rdquo;.{" "}
          {quotaStep !== null
            ? `Each top-up adds ${quotaStep} more applicant slots (from the pricing config).`
            : "Top-up amounts come from the pricing config."}
        </p>
      </Card>

      {error || !postings ? (
        // B7: the seam either threw (→ `error`) OR returned no postings array (the future
        // real-fetch failure path). BOTH degrade to the SAME neutral fallback + in-page
        // Retry — never a blank-content path. Loading is handled separately by loading.tsx.
        <Card variant="outline" className="postings-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="postings-state__msg">
            We couldn&rsquo;t load your {isAgency ? "vacancies" : "postings"} right now. Please retry.
          </p>
          <RetryButton />
        </Card>
      ) : (
        <PostingsManager postings={postings} />
      )}
    </>
  );
}
