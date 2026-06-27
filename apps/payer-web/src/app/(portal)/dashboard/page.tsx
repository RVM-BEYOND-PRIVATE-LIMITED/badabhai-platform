import Link from "next/link";
import { getDashboard } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import type { Dashboard } from "../../../lib/contracts";
import { Badge, Card, MaskedCandidate, StatTile } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { formatInr } from "../../../lib/format";
import { AgentSections } from "./agent-sections";

export const dynamic = "force-dynamic";

/**
 * Payer dashboard (ADR-0019 Phase 1) — DS1.2 re-skin + MERGE-1 (the single role-aware
 * dashboard). SHARED top by both roles; the role only adjusts user-facing LABELS (job vs
 * vacancy), never the shared data path or the authz.
 *
 * Reads the payer's OWN live data (XB-A binds to the server-held session id): GET
 * /payer/credits + /payer/unlocks (+ /payer/job-postings) via getDashboard(). Counts and the
 * ₹ price render in mono tabular (.bb-stat__value / .bb-mono). The recent-unlock teasers use
 * the MaskedCandidate primitive and stay FACELESS — no worker name/phone, no opaque id, ever
 * reaches the DOM.
 *
 * MERGE-1 (agent branch): when `session.role === "agent"` the agency demand modules render
 * INLINE below the shared top via {@link AgentSections} (a SERVER component that re-asserts
 * `requireAgent()`, fail-closes on the portal flag, and wraps every agency payload in
 * `assertNoAgencyPII`). An EMPLOYER never renders/reaches that branch, so an employer never
 * fetches or sees any agency module.
 *
 * DATA-COHERENCE (the agent case): the shared top reads the EMPLOYER `job-postings` entity
 * while the agency modules read the `jobs.payer_id` entity — DIFFERENT data sets for an agent.
 * For an agent the AGENCY data is the source of truth for vacancies, so the shared top OMITS
 * its `job-postings`-derived "Open vacancies" tile + "Your vacancies" section for agents (they
 * would contradict the agency Demand summary / manager, and an agent's job-postings list is
 * empty). Credit balance + Contacts unlocked + Recent unlocks are COHERENT (same payer-authed
 * reads) and render for BOTH roles. Employers see the unchanged 3 tiles + both sections.
 */
export default async function DashboardPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";

  let data: Dashboard | null = null;
  let failed = false;
  try {
    data = await getDashboard();
  } catch {
    failed = true;
  }

  if (failed || !data) {
    return (
      <>
        <h1 className="dash-title">Dashboard</h1>
        <Card className="dash-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="dash-state__msg">
            We couldn&rsquo;t load your account right now. Please retry shortly.
          </p>
          <RetryButton />
        </Card>
      </>
    );
  }

  const openCount = data.postings.filter((p) => p.status === "open").length;
  const recentUnlocks = data.unlocks.slice(0, 5);

  return (
    <>
      <h1 className="dash-title">Dashboard</h1>
      <p className="dash-sub">
        Your {isAgency ? "vacancies" : "postings"}, credits, and unlocked contacts.
      </p>

      <div className="dash-stats">
        <StatTile
          label="Credit balance"
          value={data.credits.balance}
          icon="wallet"
          href="/credits"
          ariaLabel={`Credit balance ${data.credits.balance} credits — open wallet`}
          delta={
            <>
              <span className="bb-mono">{formatInr(40)}</span> per unlock
            </>
          }
          deltaDir="flat"
        />
        {/* DATA-COHERENCE: the "Open postings" tile comes from the EMPLOYER `job-postings`
            read. For an AGENT that entity is NOT where their vacancies live (those are the
            `jobs.payer_id` entity shown in the Demand summary below), so we OMIT this tile for
            agents to avoid a contradictory "Open vacancies = 0" next to a populated agency
            demand summary. Employers keep it unchanged. */}
        {isAgency ? null : (
          <StatTile
            label="Open postings"
            value={openCount}
            icon="briefcase"
            href="/postings"
            ariaLabel={`Open postings ${openCount} — manage postings`}
            delta={`${data.postings.length} total`}
            deltaDir="flat"
          />
        )}
        <StatTile
          label="Contacts unlocked"
          value={data.unlocks.length}
          icon="lock-key-open"
          href="/postings"
          ariaLabel={`Contacts unlocked ${data.unlocks.length} — manage postings`}
          delta="1 credit each"
          deltaDir="flat"
        />
      </div>

      <section className="dash-section">
        <div className="dash-section__head">
          <h2>Recent unlocks</h2>
          <Link className="bb-btn bb-btn--success bb-btn--sm dash-action" href="/postings">
            <span>{isAgency ? "Manage vacancies" : "Manage postings"}</span>
            <i className="ph ph-arrow-right" aria-hidden="true" />
          </Link>
        </div>
        {recentUnlocks.length === 0 ? (
          <Card className="dash-empty">
            No contacts unlocked yet. Open a posting&rsquo;s applicants to unlock a
            candidate&rsquo;s routed contact.
          </Card>
        ) : (
          <div className="dash-candlist">
            {recentUnlocks.map((u) => (
              // Whole-row link to the postings list (no dedicated unlocks route exists; this is
              // the most relevant destination). FACELESS: the href is a static literal — NO
              // worker id/phone/name ever enters it. The wrapper Card supplies the stretched
              // link + relative context; its own surface is zeroed (.dash-unlock-link) so only
              // the inner MaskedCandidate row shows. The unmasked row holds no interactive child.
              <Card
                key={u.unlockId}
                variant="flat"
                padding="none"
                className="dash-unlock-link"
                href="/postings"
                ariaLabel="Unlocked contact — manage"
              >
                <MaskedCandidate
                  masked={false}
                  verified={u.status === "granted"}
                  name="Unlocked contact"
                  experience={u.status === "granted" ? "Active access" : "Access expired"}
                />
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* DATA-COHERENCE: the "Your postings" list is the EMPLOYER `job-postings` entity. An
          AGENT's vacancies live in the `jobs.payer_id` entity (the AgencyJobsManager below,
          full CRUD), so this employer-postings section is OMITTED for agents — keeping it
          would render a second, contradictory vacancy list. Employers keep it unchanged. */}
      {isAgency ? null : (
        <section className="dash-section">
          <div className="dash-section__head">
            <h2>Your postings</h2>
            <Link className="bb-btn bb-btn--success bb-btn--sm dash-action" href="/postings/new">
              <span>Post a job</span>
              <i className="ph ph-arrow-right" aria-hidden="true" />
            </Link>
          </div>
          {data.postings.length === 0 ? (
            <Card className="dash-empty">
              You haven&rsquo;t posted a job yet — free through launch.
            </Card>
          ) : (
            <div className="dash-postings">
              {data.postings.slice(0, 6).map((post) => (
                // Whole-card link to THIS posting's applicants (the nested route exists). The id
                // is the posting's OWN opaque uuid (never a worker id/phone). The previous inner
                // "View" link is removed — the stretched link is now the single target (a kept
                // inner link would be a redundant/duplicate-link a11y defect). The status Badge is
                // a non-interactive status indicator and stays.
                <Card
                  key={post.id}
                  padding="sm"
                  className="dash-posting"
                  href={`/postings/${post.id}/applicants`}
                  ariaLabel={`${post.roleTitle} — view applicants`}
                >
                  <div className="dash-posting__main">
                    <div className="dash-posting__title">{post.roleTitle}</div>
                    <div className="dash-posting__meta">
                      {post.locationLabel ?? "Location flexible"} · {post.vacancyBand} ·{" "}
                      <span className="bb-mono">{post.applicantCount}</span> applicants
                    </div>
                  </div>
                  <div className="dash-posting__right">
                    <Badge tone={post.status === "open" ? "success" : "neutral"} upper>
                      {post.status}
                    </Badge>
                    <i className="ph ph-arrow-right dash-view__arrow" aria-hidden="true" />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      {/* MERGE-1: the agency demand modules render INLINE for an AGENT only. AgentSections is a
          SERVER component that re-asserts requireAgent() (defence-in-depth), fail-closes on the
          agency portal flag, and wraps every agency payload in assertNoAgencyPII. An EMPLOYER
          never renders this branch, so an employer never fetches or sees any agency module. */}
      {isAgency ? <AgentSections /> : null}
    </>
  );
}
