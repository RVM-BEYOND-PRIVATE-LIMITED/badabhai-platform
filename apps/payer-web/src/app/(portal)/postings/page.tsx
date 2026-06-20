import Link from "next/link";
import { getPostings } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { applicantQuotaStep } from "../../../lib/pricing-config";
import type { PostingSummary } from "../../../lib/contracts";
import { PostingsManager } from "./postings-manager";

export const dynamic = "force-dynamic";

/**
 * Manage job postings (ADR-0019 Phase 1 — WAITING mock). Lists the payer's OWN
 * postings (XB-A: the seam binds to the server-held session id) and offers PAUSE /
 * RESUME + applicant-quota TOP-UP. `postings/new` owns CREATE.
 *
 * The quota top-up STEP is config-derived (catalog posting-quota tier) — this page
 * never hardcodes a quota number. The underlying job-postings controller is
 * InternalServiceGuard, so the lifecycle/quota actions are mock shims until a
 * payer-authed endpoint lands (see payer-api.ts ESCALATE notes).
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
      <p className="page-sub">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="page-title">Manage {isAgency ? "vacancies" : "postings"}</h1>
      <p className="page-sub">
        Pause or resume a {isAgency ? "vacancy" : "posting"}, or top up how many applicants you can
        see. <Link href="/postings/new">{isAgency ? "Post a vacancy →" : "Post a job →"}</Link>
      </p>

      <div className="note">
        Applicant quota is &ldquo;view more &rarr; pay more&rdquo;.{" "}
        {quotaStep !== null
          ? `Each top-up adds ${quotaStep} more applicant slots (from the pricing config).`
          : "Top-up amounts come from the pricing config."}
      </div>

      {error ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load your{" "}
          {isAgency ? "vacancies" : "postings"} right now. Please retry.
        </p>
      ) : postings ? (
        <PostingsManager postings={postings} />
      ) : null}
    </>
  );
}
