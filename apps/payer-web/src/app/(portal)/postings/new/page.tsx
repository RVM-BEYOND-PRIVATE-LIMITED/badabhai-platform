import { redirect } from "next/navigation";
import { requirePayer } from "../../../../lib/auth";
import { agentPostingRedirect } from "../../../../lib/posting-routes";
import { PageHeader } from "../../../../components/page-header";
import { HIRING_CAPACITY_HREF } from "../../../../lib/billing-routes";
import { PortalLink } from "../../../../components/portal-link";
import { getLiveCatalog } from "../../../../lib/live-catalog";
import { applicantQuotaStep, postingIsFreeThroughLaunch } from "../../../../lib/pricing-config";
import { getCapacity, listMatchSkills, listPostingTrades } from "../../../../lib/payer-api";
import { CachedPricingNote } from "../../../../components/cached-pricing-note";
import type { MatchSkillWire, PostingTradeFormWire } from "../../../../lib/contracts";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { PostingForm } from "./posting-form";

export const dynamic = "force-dynamic";

/**
 * New posting (ADR-0019 Phase 1). Free-through-launch: the "free" label is sourced
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
  // Company-only surface: an agency posts AGENCY jobs (owner ruling 2026-10-01) → its own form.
  const session = await requirePayer();
  if (session.role === "agent") redirect(agentPostingRedirect("create"));
  const free = postingIsFreeThroughLaunch();
  const catalog = await getLiveCatalog();
  const { live } = catalog;
  const quotaStep = applicantQuotaStep(catalog.products);

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

  // Migration 0141 — the 16-trade form catalogue. A fetch failure falls back to the legacy
  // picker; the form then refuses to publish rather than inventing trade fields.
  let postingTrades: PostingTradeFormWire[] = [];
  try {
    postingTrades = await listPostingTrades();
  } catch {
    postingTrades = [];
  }

  // The page head + notices lead the FORM column, so the card-preview rail beside it starts at
  // the top of the page: on a laptop the whole worker card and the publish button are on screen
  // from the first paint, not only after scrolling past the notices.
  const lead = (
    <>
      <PageHeader
        title="Create Job Posting"
        description="Describe the role — candidate names and contact details remain faceless until you review and unlock them."
        badge={<span className="mw-badge">FACELESS HIRING MODE</span>}
        actionsSlot={
          <button type="button" className="bb-btn bb-btn--secondary bb-btn--sm">
            Save Draft
          </button>
        }
      />

      <div className="mw-ai">
        <span className="mw-ai__icon" aria-hidden="true">
          <Icon name="sparkle" />
        </span>
        <div className="mw-ai__body">
          <p className="mw-ai__title">Short of time? Build posting with AI</p>
          <p className="mw-ai__sub">
            Tell us about the role in casual Hindi/English and we&rsquo;ll draft all technical
            fields.
          </p>
        </div>
        <PortalLink
          className="bb-btn bb-btn--secondary bb-btn--sm"
          href="/postings/ai/new"
          pendingLabel="Post with AI"
        >
          <span>Post with AI</span>
          <Icon name={ACTION_ICON.next} />
        </PortalLink>
      </div>

      {atCapacity ? (
        <div className="alert alert--warning">
          <Icon name="gauge" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">At capacity</p>
            <p className="alert__body">
              You are at capacity; this posting may be paused until you{" "}
              <PortalLink href={HIRING_CAPACITY_HREF} pendingLabel="Plans & capacity">
                add capacity
              </PortalLink>
              .
            </p>
          </div>
        </div>
      ) : null}

      {!live ? <CachedPricingNote /> : null}
    </>
  );

  return (
    <PostingForm
      quotaStep={quotaStep}
      matchSkills={matchSkills}
      postingTrades={postingTrades}
      lead={lead}
      free={free}
    />
  );
}
