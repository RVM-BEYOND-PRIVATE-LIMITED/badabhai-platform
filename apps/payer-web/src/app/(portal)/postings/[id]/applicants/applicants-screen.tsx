import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { getApplicantFeed, getDashboard } from "../../../../../lib/payer-api";
import type { ApplicantFeed, Dashboard } from "../../../../../lib/contracts";
import { Card } from "../../../../../components/ds";
import { PageHeader, type PageHeaderBack } from "../../../../../components/page-header";
import { RetryButton } from "../../../../../components/retry-button";
import { ApplicantActions } from "./applicant-actions";

/**
 * The faceless applicant feed for ONE job the payer owns (ADR-0019 Decision E), shared by the
 * two routes that open it:
 *   - `/postings/[id]/applicants`        a company posting (`job_postings`);
 *   - `/agency/jobs/[jobId]/applicants`  an agency posting (`jobs`).
 * Both read the SAME payer-scoped endpoint (`GET /payer/reach/jobs/:jobId/applicants`, which the
 * agency controller documents as its applicant route). Each route keeps its own gate and passes
 * its own way back up (`back`) and its own list (`listHref`).
 *
 * A plain async function, not a component: the routes `await` it so the tree they return is the
 * same element tree the previous single page rendered.
 *
 * XB-A: the feed is fetched payer-scoped; a job that isn't the payer's returns null ⇒ a NEUTRAL
 * not-found (no cross-tenant existence oracle). XB-C: applicants are faceless (opaque id + banded
 * taxonomy signals) — no name/phone/employer.
 *
 * BALANCE (shown ONCE): the shell header's credits chip is the balance. This screen still reads
 * it, independently, as an AFFORDANCE for the unlock band (a real zero disables Unlock; an unread
 * balance never does) — it does not print it a second time.
 */
export async function applicantsScreen({
  jobId,
  back,
  listHref,
  canBuyCredits,
}: {
  jobId: string;
  back: PageHeaderBack;
  /** The postings list a not-found / empty feed points back to. */
  listHref: string;
  /** Owner-only: whether a zero balance may link to Credits (recruiters get no /credits). */
  canBuyCredits: boolean;
}) {
  // The two concerns are DECOUPLED (C2): a failure fetching the balance/dashboard must
  // NOT blank the applicant feed. The feed is the page's primary content; the balance is
  // only an affordance signal. Each has its own try/catch and its own degraded state.
  let feed: ApplicantFeed | null = null;
  let feedError = false;
  let notFound = false;
  try {
    feed = await getApplicantFeed(jobId);
    if (!feed) notFound = true;
  } catch {
    feedError = true;
  }

  let balance: number | null = null;
  try {
    const dashboard: Dashboard = await getDashboard();
    balance = dashboard.credits.balance;
  } catch {
    // Balance unavailable → the feed renders with Unlock enabled; never blank it.
    balance = null;
  }

  // `.applicants-page` only NAMESPACES this screen's layout rules (see the "APPLICANT FEED
  // (DS1.3 · W2-B polish)" block in globals.css); it carries no styling of its own.
  return (
    <div className="applicants-page">
      <PageHeader
        back={back}
        title="Applicants"
        description="Everyone who applied, in the engine’s best-first order and faceless until you unlock a contact."
      />

      {notFound ? (
        // NEUTRAL not-found (XB-A): the copy is the UNION of "does not exist" and "not yours",
        // so it can never be read as an existence oracle for another payer's posting.
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name="file-dashed" />
            </span>
            <h2 className="state__title">No posting found here</h2>
            <p className="state__body">
              It may not exist, or it isn&rsquo;t one of your postings.
            </p>
            <div className="state__actions">
              <Link className="bb-btn bb-btn--secondary bb-btn--sm" href={listHref}>
                <Icon name={ACTION_ICON.posting} />
                <span>Postings</span>
              </Link>
            </div>
          </div>
        </Card>
      ) : feedError ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">We couldn&rsquo;t load applicants</h2>
            <p className="state__body">
              This is usually temporary — nothing about this posting has changed. Please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : feed ? (
        <>
          <div className="alert alert--info">
            <Icon name="mask-happy" className="alert__icon" />
            <div className="alert__text">
              <p className="alert__title">Applicants are faceless</p>
              <p className="alert__body">
                Each row is an opaque id plus deterministic relevance (rank / score / signals),
                shown in the engine&rsquo;s best-first order. No name, phone, or employer is
                shown. Sort them with <strong>Keep</strong> (→ Shortlist) and{" "}
                <strong>Pass</strong> (dismiss). <strong>Call</strong> / <strong>WhatsApp</strong>{" "}
                open only after you unlock and reveal an applicant&rsquo;s <strong>routed</strong>{" "}
                contact — an opaque relay, never a phone. Unlocking spends 1 credit. An
                &ldquo;unavailable&rdquo; result never discloses its cause.
              </p>
            </div>
          </div>

          {/* The feed itself is a run of cards that carry their own surface, so it is a
              `.section` (a titled block) rather than a `.panel` — a panel around them would
              be a box inside a box. The role title is the section heading; the balance is NOT
              repeated here (the shell header shows it). */}
          <section className="section">
            <div className="section__head">
              <div className="section__text">
                <h2 className="section__title">{feed.roleTitle}</h2>
                <p className="section__sub">
                  {feed.applicants.length} faceless applicant
                  {feed.applicants.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            {feed.applicants.length === 0 ? (
              <Card>
                <div className="state">
                  <span className="state__icon">
                    <Icon name={ACTION_ICON.users} />
                  </span>
                  <h3 className="state__title">No applicants on this posting yet</h3>
                  <p className="state__body">
                    Matching workers appear here — faceless — as they apply. Nothing is needed
                    from you meanwhile; a wider skill list on the posting reaches more of them.
                  </p>
                  <div className="state__actions">
                    <Link className="bb-btn bb-btn--secondary bb-btn--sm" href={listHref}>
                      <Icon name={ACTION_ICON.posting} />
                      <span>Postings</span>
                    </Link>
                  </div>
                </div>
              </Card>
            ) : (
              <ApplicantActions
                postingId={feed.postingId}
                applicants={feed.applicants}
                // Balance is an affordance hint only. If it failed to load (null), keep
                // unlock ENABLED — the no-oracle server still makes the real decision; we
                // never block on a UI-side balance we couldn't read.
                balance={balance ?? 1}
                canBuyCredits={canBuyCredits}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
