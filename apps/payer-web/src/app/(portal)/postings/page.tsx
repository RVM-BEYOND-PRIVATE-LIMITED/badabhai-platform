import Link from "next/link";
import { redirect } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { getPostings } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { quotaTopUpTier } from "../../../lib/pricing-config";
import {
  agentPostingRedirect,
  COMPANY_POSTING_ROUTES,
  postingRoutes,
} from "../../../lib/posting-routes";
import type { PostingSummary } from "../../../lib/contracts";
import { Card } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { priceFigure } from "../../../components/price-figure";
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { PostingsManager, type TopUpOffer } from "./postings-manager";

export const dynamic = "force-dynamic";

/**
 * Postings (ADR-0019 Phase 1) — a COMPANY's own postings (XB-A: the seam binds to the
 * server-held session id) via the LIVE `GET /payer/job-postings` read. `postings/new` owns
 * CREATE; each row's title opens the posting, and its links open the faceless applicant feed
 * and the edit form.
 *
 * The PAUSE / RESUME / ADD APPLICANT SLOTS / CLOSE lifecycle is LIVE: the payer-authed
 * `POST /payer/job-postings/:id/{pause|resume|quota-topup|close}` routes (#178/#180),
 * wired in the manager with per-row busy state + inline retryable errors. ADD APPLICANT SLOTS is
 * a purchase: its button shows its slots and ₹ and asks first (owner ruling 2026-10-07, F11). That
 * offer is `quotaTopUpTier()` of the LIVE catalog, and the confirm sends that tier back — the
 * seam buys exactly it or nothing (#2085 L1) — so the button, the dialog and the quota note below
 * all name what is actually bought (D-6; fetch
 * failure ⇒ compile-time defaults + the cached-pricing note). Never a hardcoded price or quota.
 *
 * AN AGENT (owner ruling 2026-10-01): agencies post AGENCY jobs only, so this company surface
 * is never linked for them. An agent who opens it directly is redirected to their own Postings
 * — UNLESS they own older `job_postings` rows (made here before the ruling). Those are not
 * hidden behind a 404: the agent sees them READ-ONLY (no lifecycle, no edit, no applicants), by
 * direct link only — nothing in an agency's portal links here — with a pointer to their own
 * Postings while the agency surface is on. The backend role gate for this surface is #1885.
 */
export default async function PostingsPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // An agent's own postings page — null when the agency surface is off (it would 404).
  const agencyPostings = isAgency ? postingRoutes(true) : null;
  const catalog = await getLiveCatalog();
  const { live } = catalog;
  // The slot top-up on offer, at the price it is charged (#2085): its code, slots and price are
  // what the row's confirm shows AND sends back — the seam buys exactly this tier or nothing.
  const topUpOffer: TopUpOffer | null = quotaTopUpTier(catalog);

  let postings: PostingSummary[] | null = null;
  let error: string | null = null;
  try {
    postings = await getPostings();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try: `redirect()` signals by throwing.
  if (isAgency && postings !== null && postings.length === 0) {
    redirect(agentPostingRedirect("list"));
  }

  // `.postings-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  return (
    <div className="postings-page">
      {isAgency ? (
        <PageHeader
          title="Older postings"
          description="Postings your agency published with the company form, before agencies had their own Postings page — view only."
        />
      ) : (
        <PageHeader
          title="Postings"
          description="Every posting you have opened, its applicant feed, and the controls to pause, resume, add applicant slots or close it."
          primaryAction={{
            href: COMPANY_POSTING_ROUTES.create,
            label: "New posting",
            icon: ACTION_ICON.create,
          }}
        />
      )}

      {isAgency ? (
        agencyPostings ? (
          <div className="alert alert--info">
            <Icon name="info" className="alert__icon" />
            <div className="alert__text">
              <p className="alert__title">Your agency&rsquo;s postings are in Postings</p>
              <p className="alert__body">
                New postings and edits for your agency live there. These older ones stay visible
                here, view only, so nothing you made is lost.
              </p>
            </div>
            <div className="alert__actions">
              <Link className="bb-btn bb-btn--secondary bb-btn--sm" href={agencyPostings.list}>
                <span>Go to Postings</span>
                <Icon name={ACTION_ICON.next} />
              </Link>
            </div>
          </div>
        ) : null
      ) : (
        <div className="alert alert--info">
          <Icon name="info" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Applicant quota</p>
            <p className="alert__body">
              Seeing more of a posting&rsquo;s applicants costs more.{" "}
              {topUpOffer !== null ? (
                <>
                  Each &ldquo;Add applicant slots&rdquo; adds{" "}
                  <span className="bb-mono">{topUpOffer.additionalViews}</span> more applicant slots
                  for <span className="bb-mono">{priceFigure(topUpOffer)}</span> (from the
                  pricing config).
                </>
              ) : (
                "Slot amounts come from the pricing config."
              )}
            </p>
          </div>
        </div>
      )}

      {!live && !isAgency ? <CachedPricingNote /> : null}

      {error || !postings ? (
        // B7: the seam either threw (→ `error`) OR returned no postings array (the future
        // real-fetch failure path). BOTH degrade to the SAME neutral fallback + in-page
        // Retry — never a blank-content path. (No route loading state: the previous page stays on
        // screen until this one renders — app/no-suspense-above-a-page.test.ts.)
        // NO-LEAK: the caught `error` string is never rendered; the copy stays neutral.
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">We couldn&rsquo;t load your postings</h2>
            <p className="state__body">
              This is usually temporary and nothing has changed — your postings and their
              applicants are safe. Retry to run the read again.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : (
        <PostingsManager postings={postings} readOnly={isAgency} topUpOffer={topUpOffer} />
      )}
    </div>
  );
}
