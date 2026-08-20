import Link from "next/link";
import { getDashboard } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { getOrgRole } from "../../../lib/auth/org-roles";
import type { Dashboard } from "../../../lib/contracts";
import { Badge, Card, MaskedCandidate, StatTile } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { formatInr } from "../../../lib/format";
import { AgentSections } from "./agent-sections";
import { buildAttentionItems } from "./attention";

export const dynamic = "force-dynamic";

/**
 * Payer dashboard — rebuilt as a COMMAND CENTRE (UI-1).
 *
 * The screen used to be three counters and two lists at equal visual weight, which answered
 * "what are my totals?" but never "what needs me?". It now reads top-down in the order a
 * payer actually needs:
 *
 *   1. NEEDS YOU     — only rendered when something genuinely does (see attention.ts).
 *   2. POSITION      — the counters, now secondary to the alerts above them.
 *   3. DO SOMETHING  — the high-frequency actions, as first-class targets.
 *   4. YOUR WORK     — the postings/vacancies themselves.
 *   5. RECENT        — unlock history, quietest of the five.
 *
 * Nothing here invents data: every alert is a statement about a field that is in the
 * payload, and no new endpoint was added.
 *
 * UNCHANGED: the authz path (requirePayer → XB-A binds every read to the server-held payer
 * id), the role branching, and the FACELESS invariant — no worker name, phone or opaque id
 * ever reaches the DOM; recent unlocks still render through MaskedCandidate.
 *
 * MERGE-1 (agent branch): when `session.role === "agent"` the agency demand modules render
 * INLINE below via {@link AgentSections}, a SERVER component that re-asserts requireAgent(),
 * fail-closes on the portal flag, and wraps every agency payload in assertNoAgencyPII.
 *
 * DATA-COHERENCE (the agent case): the shared top reads the EMPLOYER `job-postings` entity
 * while the agency modules read the `jobs.payer_id` entity — DIFFERENT data sets for an
 * agent. The agency data is the source of truth for their vacancies, so the shared top OMITS
 * its `job-postings`-derived tile and section for agents.
 */
export default async function DashboardPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const isOwner = getOrgRole(session) === "owner";

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
        <div className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">Dashboard</h1>
          </div>
        </div>
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h2 className="state__title">We could not load your account</h2>
            <p className="state__body">
              This is usually temporary. Your data is safe — nothing has changed.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      </>
    );
  }

  const openCount = data.postings.filter((p) => p.status === "open").length;
  const recentUnlocks = data.unlocks.slice(0, 5);
  const attention = buildAttentionItems(data, { isAgency, isOwner });

  return (
    <>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Dashboard</h1>
          <p className="page-head__sub">
            {isAgency
              ? "Your vacancies, referred workers and unlocked contacts."
              : "Your postings, credits and unlocked contacts — and anything that needs you."}
          </p>
        </div>
        <div className="page-head__actions">
          <Link className="bb-btn bb-btn--primary bb-btn--sm" href="/postings/new">
            <i className="ph ph-plus" aria-hidden="true" />
            <span>{isAgency ? "Post a vacancy" : "Post a job"}</span>
          </Link>
        </div>
      </div>

      {/* 1 · NEEDS YOU — absent entirely when nothing does, so its presence always means
          something. A permanent "all clear" panel trains people to stop reading it. */}
      {attention.length > 0 ? (
        <section className="attention" aria-labelledby="attention-heading">
          <h2 className="attention__heading" id="attention-heading">
            Needs your attention
          </h2>
          <ul className="attention__list">
            {attention.map((item) => (
              <li className={`attention__item attention__item--${item.tone}`} key={item.id}>
                <i
                  className={`ph ph-${
                    item.tone === "critical"
                      ? "warning-octagon"
                      : item.tone === "warning"
                        ? "warning"
                        : "info"
                  } attention__icon`}
                  aria-hidden="true"
                />
                <div className="attention__text">
                  <p className="attention__title">{item.title}</p>
                  <p className="attention__body">{item.body}</p>
                </div>
                {item.actionHref ? (
                  <Link
                    className="bb-btn bb-btn--secondary bb-btn--sm attention__action"
                    href={item.actionHref}
                  >
                    {item.actionLabel}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 2 · POSITION */}
      <div className="stat-row">
        <StatTile
          label="Credit balance"
          value={data.credits.balance}
          icon="wallet"
          href="/credits"
          ariaLabel={`Credit balance ${data.credits.balance} credits — open wallet`}
          caption={
            <>
              <span className="bb-mono">{formatInr(40)}</span> per unlock
            </>
          }
        />
        {isAgency ? null : (
          <StatTile
            label="Open postings"
            value={openCount}
            icon="briefcase"
            href="/postings"
            ariaLabel={`Open postings ${openCount} — manage postings`}
            caption={`${data.postings.length} total`}
          />
        )}
        {/* PARKED, not removed. /agency/revenue renders a real page explaining what is
            coming, so the tile stays a link to that explanation rather than vanishing —
            an agent looking for earnings should find an answer, not silence. */}
        {isAgency ? (
          <StatTile
            label="Revenue"
            value="—"
            icon="currency-inr"
            href="/agency/revenue"
            ariaLabel="Revenue — coming soon"
            caption="Coming soon"
          />
        ) : null}
        <StatTile
          label="Contacts unlocked"
          value={data.unlocks.length}
          icon="lock-key-open"
          href="/postings"
          ariaLabel={`Contacts unlocked ${data.unlocks.length} — manage postings`}
          caption="1 credit each"
        />
      </div>

      {/* 3 · DO SOMETHING — the handful of things a payer does over and over. These were
          previously buried as small links inside section headers. */}
      <section className="quick" aria-labelledby="quick-heading">
        <h2 className="quick__heading" id="quick-heading">
          Quick actions
        </h2>
        <div className="quick__grid">
          <Link className="quick__card" href="/postings/new">
            <span className="quick__icon">
              <i className="ph ph-plus-circle" aria-hidden="true" />
            </span>
            <span className="quick__label">{isAgency ? "Post a vacancy" : "Post a job"}</span>
            <span className="quick__desc">Describe the role and reach matched workers.</span>
          </Link>
          <Link className="quick__card" href="/postings">
            <span className="quick__icon">
              <i className="ph ph-users-three" aria-hidden="true" />
            </span>
            <span className="quick__label">Review applicants</span>
            <span className="quick__desc">
              Open a {isAgency ? "vacancy" : "posting"} and work through its feed.
            </span>
          </Link>
          {isAgency ? (
            <Link className="quick__card" href="/agency/referrals">
              <span className="quick__icon">
                <i className="ph ph-share-network" aria-hidden="true" />
              </span>
              <span className="quick__label">Invite workers</span>
              <span className="quick__desc">Mint an invite link or print a QR poster.</span>
            </Link>
          ) : null}
          {isOwner ? (
            <Link className="quick__card" href="/credits">
              <span className="quick__icon">
                <i className="ph ph-wallet" aria-hidden="true" />
              </span>
              <span className="quick__label">Top up credits</span>
              <span className="quick__desc">Add unlocks so shortlisting never stalls.</span>
            </Link>
          ) : null}
          <Link className="quick__card" href="/plans">
            <span className="quick__icon">
              <i className="ph ph-chart-donut" aria-hidden="true" />
            </span>
            <span className="quick__label">Plans &amp; capacity</span>
            <span className="quick__desc">
              How many {isAgency ? "vacancies" : "roles"} you can run at once.
            </span>
          </Link>
        </div>
      </section>

      {/* 4 · YOUR WORK — omitted for agents (different entity; see the header note). */}
      {isAgency ? null : (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Your postings</h2>
            <div className="panel__actions">
              <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings">
                <span>Manage all</span>
                <i className="ph ph-arrow-right" aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className="panel__body">
            {data.postings.length === 0 ? (
              <div className="state">
                <span className="state__icon">
                  <i className="ph ph-briefcase" aria-hidden="true" />
                </span>
                <h3 className="state__title">No postings yet</h3>
                <p className="state__body">
                  Matched workers can only find you once a role is live. Posting is free
                  through launch.
                </p>
                <div className="state__actions">
                  <Link className="bb-btn bb-btn--primary bb-btn--sm" href="/postings/new">
                    Post a job
                  </Link>
                </div>
              </div>
            ) : (
              <div className="dash-postings">
                {data.postings.slice(0, 6).map((post) => (
                  // Whole-card link to THIS posting's applicants. The id is the posting's OWN
                  // opaque uuid (never a worker id/phone).
                  <Card
                    key={post.id}
                    padding="sm"
                    className="dash-posting"
                    href={`/postings/${post.id}/applicants`}
                    ariaLabel={`${post.roleTitle} — view applicants`}
                  >
                    <div className="dash-posting__main">
                      <div className="dash-posting__title">{post.roleTitle}</div>
                      {/* The applicant COUNT is deliberately not shown. It is not in the
                          job-posting projection (see toPostingSummary in payer-api.ts), so it
                          was hardcoded to 0 and every row read "0 applicants" — telling an
                          employer they had none when they may have had many. Until the count
                          is on the wire, the row offers the feed instead of a false figure. */}
                      <div className="dash-posting__meta">
                        {post.locationLabel ?? "Location flexible"} · {post.vacancyBand}
                      </div>
                    </div>
                    <div className="dash-posting__right">
                      <Badge tone={post.status === "open" ? "success" : "neutral"} upper>
                        {post.status}
                      </Badge>
                      <span className="dash-posting__cta">
                        View applicants
                        <i className="ph ph-arrow-right dash-view__arrow" aria-hidden="true" />
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 5 · RECENT — the quietest band. */}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Recent unlocks</h2>
          <p className="panel__sub">
            Contacts you have revealed. Identities stay masked until you unlock them.
          </p>
        </div>
        <div className="panel__body">
          {recentUnlocks.length === 0 ? (
            <div className="state">
              <span className="state__icon">
                <i className="ph ph-lock-key-open" aria-hidden="true" />
              </span>
              <h3 className="state__title">No contacts unlocked yet</h3>
              <p className="state__body">
                Open a {isAgency ? "vacancy" : "posting"}&rsquo;s applicants and unlock a
                candidate to see their routed contact here.
              </p>
              <div className="state__actions">
                <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings">
                  Browse applicants
                </Link>
              </div>
            </div>
          ) : (
            <div className="dash-candlist">
              {recentUnlocks.map((u) => (
                // FACELESS: the href is a static literal — NO worker id/phone/name ever
                // enters it. The wrapper Card supplies the stretched link; its own surface is
                // zeroed so only the inner MaskedCandidate row shows.
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
        </div>
      </section>

      {/* MERGE-1: agency demand modules render INLINE for an AGENT only. */}
      {isAgency ? <AgentSections /> : null}
    </>
  );
}
