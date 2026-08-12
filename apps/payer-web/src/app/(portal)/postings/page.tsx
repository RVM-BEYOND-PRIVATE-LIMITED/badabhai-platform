import Link from "next/link";
import { getPostings } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { applicantQuotaStep } from "../../../lib/pricing-config";
import type { PostingSummary } from "../../../lib/contracts";
import { Card } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { RetryButton } from "../../../components/retry-button";
import { PostingsManager } from "./postings-manager";

export const dynamic = "force-dynamic";

/**
 * Manage job postings (ADR-0019 Phase 1) — migrated onto the UI-1 page spine
 * (page-back / page-head / alert / state). Lists the payer's OWN postings (XB-A: the seam
 * binds to the server-held session id) via the LIVE `GET /payer/job-postings` read.
 * `postings/new` owns CREATE; each row links to its own faceless applicant feed.
 *
 * The PAUSE / RESUME / quota TOP-UP / CLOSE lifecycle is LIVE: the payer-authed
 * `POST /payer/job-postings/:id/{pause|resume|quota-topup|close}` routes (#178/#180),
 * wired in the manager with per-row busy state + inline retryable errors.
 *
 * The quota top-up STEP copy is config-derived from the LIVE catalog (D-6; fetch
 * failure ⇒ compile-time defaults + the cached-pricing note) — this page never
 * hardcodes a quota number.
 */
export default async function PostingsPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const { products, live } = await getLiveCatalog();
  const quotaStep = applicantQuotaStep(products);

  let postings: PostingSummary[] | null = null;
  let error: string | null = null;
  try {
    postings = await getPostings();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Manage {isAgency ? "vacancies" : "postings"}</h1>
          <p className="page-head__sub">
            Every {isAgency ? "vacancy" : "posting"} you have opened, its applicant feed, and the
            controls to pause, resume, top up or close it.
          </p>
        </div>
        <div className="page-head__actions">
          <Link className="bb-btn bb-btn--primary bb-btn--sm" href="/postings/new">
            <i className="ph ph-plus" aria-hidden="true" />
            <span>{isAgency ? "Post a vacancy" : "Post a job"}</span>
          </Link>
        </div>
      </div>

      <div className="alert alert--info">
        <i className="ph ph-info alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Applicant quota</p>
          <p className="alert__body">
            Applicant quota is &ldquo;view more &rarr; pay more&rdquo;.{" "}
            {quotaStep !== null
              ? `Each top-up adds ${quotaStep} more applicant slots (from the pricing config).`
              : "Top-up amounts come from the pricing config."}
          </p>
        </div>
      </div>

      {!live ? <CachedPricingNote /> : null}

      {error || !postings ? (
        // B7: the seam either threw (→ `error`) OR returned no postings array (the future
        // real-fetch failure path). BOTH degrade to the SAME neutral fallback + in-page
        // Retry — never a blank-content path. Loading is handled separately by loading.tsx.
        // NO-LEAK: the caught `error` string is never rendered; the copy stays neutral.
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h2 className="state__title">
              We couldn&rsquo;t load your {isAgency ? "vacancies" : "postings"}
            </h2>
            <p className="state__body">
              This is usually temporary and nothing has changed — your{" "}
              {isAgency ? "vacancies" : "postings"} and their applicants are safe. Retry to run
              the read again.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : (
        <PostingsManager postings={postings} />
      )}
    </>
  );
}
