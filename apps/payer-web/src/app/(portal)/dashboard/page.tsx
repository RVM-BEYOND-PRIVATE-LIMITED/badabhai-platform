import Link from "next/link";
import { getDashboard } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import type { Dashboard } from "../../../lib/contracts";
import { Badge, Card, MaskedCandidate, StatTile } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { formatInr } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Payer dashboard (ADR-0019 Phase 1) — DS1.2 re-skin. SHARED by both roles; the role
 * only adjusts user-facing LABELS (job vs vacancy), never the data path or the authz.
 *
 * Reads the payer's OWN live data (XB-A binds to the server-held session id): GET
 * /payer/credits + /payer/unlocks (+ /payer/job-postings for the open count) via
 * getDashboard(). Counts and the ₹ price render in mono tabular (.bb-stat__value /
 * .bb-mono). The recent-unlock teasers use the MaskedCandidate primitive and stay
 * FACELESS — no worker name/phone, no opaque id, ever reaches the DOM.
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
          delta={
            <>
              <span className="bb-mono">{formatInr(40)}</span> per unlock
            </>
          }
          deltaDir="flat"
        />
        <StatTile
          label={isAgency ? "Open vacancies" : "Open postings"}
          value={openCount}
          icon="briefcase"
          delta={`${data.postings.length} total`}
          deltaDir="flat"
        />
        <StatTile
          label="Contacts unlocked"
          value={data.unlocks.length}
          icon="lock-key-open"
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
              <MaskedCandidate
                key={u.unlockId}
                masked={false}
                verified={u.status === "granted"}
                name="Unlocked contact"
                experience={u.status === "granted" ? "Active access" : "Access expired"}
              />
            ))}
          </div>
        )}
      </section>

      <section className="dash-section">
        <div className="dash-section__head">
          <h2>Your {isAgency ? "vacancies" : "postings"}</h2>
          <Link className="bb-btn bb-btn--success bb-btn--sm dash-action" href="/postings/new">
            <span>{isAgency ? "Post a vacancy" : "Post a job"}</span>
            <i className="ph ph-arrow-right" aria-hidden="true" />
          </Link>
        </div>
        {data.postings.length === 0 ? (
          <Card className="dash-empty">
            You haven&rsquo;t posted {isAgency ? "a vacancy" : "a job"} yet — free through
            launch.
          </Card>
        ) : (
          <div className="dash-postings">
            {data.postings.slice(0, 6).map((post) => (
              <Card key={post.id} padding="sm" className="dash-posting">
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
                  <Link
                    className="bb-btn bb-btn--tonal bb-btn--sm dash-view"
                    href={`/postings/${post.id}/applicants`}
                  >
                    <span>View</span>
                    <i className="ph ph-arrow-right dash-view__arrow" aria-hidden="true" />
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
