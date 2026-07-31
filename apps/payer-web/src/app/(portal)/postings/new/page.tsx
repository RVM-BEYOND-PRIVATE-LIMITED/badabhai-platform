import Link from "next/link";
import { getLiveCatalog } from "../../../../lib/live-catalog";
import {
  applicantQuotaStep,
  postingIsFreeThroughLaunch,
  postingPaidTiers,
} from "../../../../lib/pricing-config";
import { getCapacity, listMatchSkills } from "../../../../lib/payer-api";
import { formatInr } from "../../../../lib/format";
import { Badge, Card } from "../../../../components/ds";
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
      <h1 className="dash-title">Post a job</h1>
      <p className="dash-sub">Describe the role. Applicants appear faceless until you unlock them.</p>

      {/* ADR-0035 entry point: the AI chat is an ALTERNATIVE INPUT SURFACE onto this same
          create path — the manual form below is unchanged and remains the default. */}
      <Card variant="outline" className="posting-mode">
        <div className="posting-mode__opt">
          <Badge tone="brand" upper>
            AI-assisted
          </Badge>
          <p className="posting-mode__msg">
            Answer a few questions in plain language and we&rsquo;ll build the posting for you —
            resumable on any device you sign in on.
          </p>
          <Link className="posting-mode__cta" href="/postings/ai/new">
            Post with AI →
          </Link>
        </div>
        <div className="posting-mode__opt">
          <Badge tone="neutral" upper>
            Manual form
          </Badge>
          <p className="posting-mode__msg">
            Prefer to type the fields yourself? The full form is right below — nothing changes.
          </p>
        </div>
      </Card>

      {atCapacity ? (
        <Card variant="outline" className="posting-note">
          <Badge tone="warning" upper>
            At capacity
          </Badge>
          <p className="posting-note__msg">
            You are at capacity; this posting may be paused until you{" "}
            <Link href="/capacity">add capacity</Link>.
          </p>
        </Card>
      ) : null}

      {free ? (
        <Card variant="outline" className="posting-note">
          <Badge tone="success" upper>
            Free through launch
          </Badge>
          <p className="posting-note__msg">
            Posting a job is free during the launch phase. (We show this from a launch-phase config
            flag — the pricing catalog cannot represent a ₹0 price, so &ldquo;free&rdquo; is not a
            catalog amount.)
          </p>
        </Card>
      ) : (
        <Card variant="outline" className="posting-note">
          <Badge tone="warning" upper>
            Paid plans
          </Badge>
          <p className="posting-note__msg">
            Paid posting plans (config-driven):{" "}
            {paidTiers.length === 0
              ? "unavailable"
              : paidTiers
                  .map((t) => `${t.code} ${formatInr(t.priceInr)} / ${t.validityDays}d`)
                  .join(" · ")}
            .
          </p>
        </Card>
      )}

      {!live ? <CachedPricingNote /> : null}

      <PostingForm quotaStep={quotaStep} matchSkills={matchSkills} />
    </>
  );
}
