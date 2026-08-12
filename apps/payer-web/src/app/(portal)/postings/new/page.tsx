import Link from "next/link";
import { getLiveCatalog } from "../../../../lib/live-catalog";
import {
  applicantQuotaStep,
  postingIsFreeThroughLaunch,
  postingPaidTiers,
} from "../../../../lib/pricing-config";
import { getCapacity, listMatchSkills } from "../../../../lib/payer-api";
import { formatInr } from "../../../../lib/format";
import { CachedPricingNote } from "../../../../components/cached-pricing-note";
import type { MatchSkillWire } from "../../../../lib/contracts";
import { PostingForm } from "./posting-form";

export const dynamic = "force-dynamic";

/**
 * Post a job (ADR-0019 Phase 1). Free-through-launch: the "free" label is sourced
 * from a CONFIG FLAG, never a hardcoded ₹0 — the catalog cannot model a ₹0 price
 * (priceInr min(1)), which is the open ADR-0013 escalation. Post-launch paid tiers
 * are shown for transparency, read from the LIVE catalog (D-6; fetch failure ⇒ the
 * compile-time defaults + the cached-pricing note). The quota STEP for the form's
 * derived-band display is resolved HERE (server) and passed down — the client form
 * never fetches the catalog.
 *
 * QUOTA-PAUSE A4 (faithful slice): a NON-BLOCKING at-capacity warning is shown when the
 * payer is at/over their concurrent-vacancy allowance. The signal derives from the REAL
 * enforcement-engine count via `getCapacity()` (activeVacancies >= allowance) on the
 * server; it is informational and does NOT disable submit. A capacity read failure is
 * swallowed (the warning simply doesn't show) — it must never block posting.
 */
export default async function NewPostingPage() {
  const free = postingIsFreeThroughLaunch();
  const { products, live } = await getLiveCatalog();
  const paidTiers = postingPaidTiers(products);
  const quotaStep = applicantQuotaStep(products);

  let atCapacity = false;
  try {
    const capacity = await getCapacity();
    atCapacity = capacity.activeVacancies >= capacity.activeVacancyAllowance;
  } catch {
    // Capacity read failed — do NOT block posting; just omit the informational warning.
    atCapacity = false;
  }

  // ADR-0036 — the closed match vocabulary, fetched SERVER-side so the Bearer never
  // reaches the browser. Unlike the capacity read this failing is NOT swallowed into
  // "carry on": a posting with no match skill reaches nobody, so the form renders an
  // explicit reload prompt and keeps submit disabled rather than quietly producing an
  // invisible job. `[]` is the signal for that, and it is distinguishable from a real
  // empty vocabulary only because a real one is never empty (the seed is checked in).
  let matchSkills: MatchSkillWire[] = [];
  try {
    matchSkills = await listMatchSkills();
  } catch {
    matchSkills = [];
  }

  return (
    <>
      <p className="page-back">
        <Link href="/postings">← Manage postings</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Post a job</h1>
          <p className="page-head__sub">
            Describe the role. Applicants appear faceless until you unlock them.
          </p>
        </div>
      </div>

      {/* ADR-0035 entry point: the AI chat is an ALTERNATIVE INPUT SURFACE onto this same
          create path — the manual form below is unchanged and remains the default. Both
          options are stated in one band so neither reads as the "real" way in. */}
      <div className="alert alert--info">
        <i className="ph ph-sparkle alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Answer a few questions instead of filling this form</p>
          <p className="alert__body">
            Tell us about the role in plain language and we&rsquo;ll build the posting for you —
            resumable on any device you sign in on. Prefer to type the fields yourself? The full
            manual form is right below — nothing changes.
          </p>
        </div>
        <div className="alert__actions">
          <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings/ai/new">
            <span>Post with AI</span>
            <i className="ph ph-arrow-right" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {atCapacity ? (
        <div className="alert alert--warning">
          <i className="ph ph-gauge alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">At capacity</p>
            <p className="alert__body">
              You are at capacity; this posting may be paused until you{" "}
              <Link href="/capacity">add capacity</Link>.
            </p>
          </div>
        </div>
      ) : null}

      {free ? (
        <div className="alert alert--success">
          <i className="ph ph-gift alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Free through launch</p>
            <p className="alert__body">
              Posting a job is free during the launch phase. (We show this from a launch-phase
              config flag — the pricing catalog cannot represent a ₹0 price, so &ldquo;free&rdquo;
              is not a catalog amount.)
            </p>
          </div>
        </div>
      ) : (
        <div className="alert alert--warning">
          <i className="ph ph-tag alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Paid plans</p>
            <p className="alert__body">
              Paid posting plans (config-driven):{" "}
              {paidTiers.length === 0
                ? "unavailable"
                : paidTiers
                    .map((t) => `${t.code} ${formatInr(t.priceInr)} / ${t.validityDays}d`)
                    .join(" · ")}
              .
            </p>
          </div>
        </div>
      )}

      {!live ? <CachedPricingNote /> : null}

      <PostingForm quotaStep={quotaStep} matchSkills={matchSkills} />
    </>
  );
}
