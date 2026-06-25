import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import {
  getAgencyAccount,
  getAgencyReferralsSummary,
  getCredits,
  getUnlocks,
  listAgencyJobs,
} from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import { summarizeAgencyJobs } from "../../../../lib/agency-summary";
import type {
  AgencyAccount,
  AgencyJob,
  AgencyReferralsSummary,
  CreditBalance,
} from "../../../../lib/contracts";
import { RetryButton } from "../../../../components/retry-button";
import { AgencyJobsManager } from "./agency-jobs-manager";
import { AgencyInvitePanel } from "./invite-panel";
import { ReferralFunnel } from "./referral-funnel";
import { AgencyParkedModules } from "./parked-modules";

export const dynamic = "force-dynamic";

/**
 * AGENCY DASHBOARD (ADR-0019 DEMAND extension + ADR-0022 demand slice) — FACELESS.
 *
 * SECURITY / authz (XB-A / XT3): the FIRST statement is `requireAgent()`, which reads the
 * SERVER-HELD signed session and returns a NEUTRAL 404 for any non-`agent` (an employer
 * cannot reach, read, or confirm this page exists). The agency-portal public flag
 * additionally fail-closes the route (off → notFound()).
 *
 * FACELESS (CLAUDE.md §2 #2 + #6 / B-R2): the agency sees ONLY opaque ids, COUNTS, status
 * enums, coarse bands, timestamps, and its OWN org label — NEVER a worker name/phone/raw
 * resume/unconsented data. Every payload crosses {@link assertNoAgencyPII} at the render
 * boundary (defence-in-depth; the data seam also wraps it).
 *
 * LIVE vs MOCK (honest labelling): the account identity, credits, unlocked count, the
 * agency's OWN vacancies (`/payer/agency/jobs` — list + create + edit + pause + close),
 * the invite mint (`POST /payer/agency/invites`), and the referral funnel
 * (`/payer/agency/referrals/summary`, aggregate + k-anon) are ALL LIVE payer-authed,
 * agent-role-gated reads/writes (ADR-0022, #127). The separate EMPLOYER `posting_plans`
 * surface remains its own escalated track and is not used here. Nothing fakes success.
 */
export default async function AgencyDashboardPage() {
  // 1) SERVER-enforced role gate — employer → neutral 404, before anything renders.
  const session = await requireAgent();

  // 2) Public flag fail-close: agency portal off → the route does not exist.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  // 3) LIVE reads, each isolated so a single failing source degrades to "—"/empty rather
  //    than blanking the page.
  let account: AgencyAccount | null = null;
  let credits: CreditBalance | null = null;
  let unlocksCount: number | null = null;
  let jobs: AgencyJob[] | null = null;
  let referrals: AgencyReferralsSummary | null = null;
  let readError = false;

  try {
    account = assertNoAgencyPII(await getAgencyAccount(), "payer/me");
  } catch {
    // Fall back to the session's own non-PII label; never block the page on /me.
    account = { role: "agent", status: "active", displayLabel: session.displayLabel };
    readError = true;
  }
  try {
    credits = assertNoAgencyPII(await getCredits(), "payer/credits");
  } catch {
    readError = true;
  }
  try {
    const unlocks = assertNoAgencyPII(await getUnlocks(), "payer/unlocks");
    unlocksCount = unlocks.length;
  } catch {
    readError = true;
  }
  try {
    jobs = assertNoAgencyPII(await listAgencyJobs(), "payer/agency/jobs");
  } catch {
    readError = true;
  }
  try {
    referrals = assertNoAgencyPII(await getAgencyReferralsSummary(), "payer/agency/referrals/summary");
  } catch {
    readError = true;
  }

  const demand = jobs ? summarizeAgencyJobs(jobs) : null;
  const dash = (n: number | null): string => (n === null ? "—" : String(n));

  return (
    <>
      <p className="page-sub">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="page-title">Agency dashboard</h1>
      <p className="page-sub">
        Post roles and manage demand like a payer account. BadaBhai protects worker privacy.
        Agencies see only consent-safe progress and aggregate signals.
      </p>

      {readError ? (
        <p className="page-sub">
          <span className="badge badge-warn">Some signals unavailable</span> One or more reads could
          not load right now — those panels show &ldquo;&mdash;&rdquo; until they recover.{" "}
          <RetryButton />
        </p>
      ) : null}

      {/* a) IDENTITY CARD — the agency's OWN non-PII identity only. */}
      <section className="section">
        <h2>Your agency</h2>
        <div className="cards">
          <div className="card">
            <h3>Account</h3>
            <div className="big">{account?.displayLabel ?? "Your agency"}</div>
            <p>
              Role <span className="badge">Agency</span> · status{" "}
              <span
                className={account?.status === "active" ? "badge badge-ok" : "badge badge-warn"}
              >
                {account?.status ?? "—"}
              </span>
            </p>
          </div>

          {/* c) FACELESS REACH SUMMARY — LIVE credits + unlocked count. */}
          <div className="card">
            <h3>Credit balance</h3>
            <div className="big">{dash(credits ? credits.balance : null)}</div>
            <p>
              <span className="badge badge-ok">Live</span>{" "}
              <Link href="/credits">Top up credits →</Link>
            </p>
          </div>
          <div className="card">
            <h3>Contacts unlocked</h3>
            <div className="big">{dash(unlocksCount)}</div>
            <p>
              <span className="badge badge-ok">Live</span> 1 credit per contact
            </p>
          </div>
        </div>
      </section>

      {/* b) DEMAND JOB SUMMARY — counts derived from the agency's OWN LIVE jobs. */}
      <section className="section">
        <h2>Demand summary</h2>
        <div className="cards">
          <div className="card">
            <h3>Total vacancies</h3>
            <div className="big">{dash(demand ? demand.total : null)}</div>
            <p>
              <span className="badge badge-ok">Live</span> Your agency&rsquo;s own roles
            </p>
          </div>
          <div className="card">
            <h3>Open</h3>
            <div className="big">{dash(demand ? demand.open : null)}</div>
            <p>Closed {dash(demand ? demand.closed : null)}</p>
          </div>
          <div className="card">
            <h3>Applicants received</h3>
            <div className="big">{dash(demand ? demand.applicantsReceived : null)}</div>
            <p>
              <span className="badge badge-ok">Live</span> Across all your roles
            </p>
          </div>
        </div>
      </section>

      {/* d) VACANCY MANAGEMENT — LIVE list + create/edit/pause/close on the agency jobs. */}
      <section className="section">
        <h2>Your vacancies</h2>
        {jobs ? (
          <AgencyJobsManager jobs={jobs} />
        ) : (
          <div className="empty">
            Vacancies are unavailable right now. Please retry shortly. <RetryButton />
          </div>
        )}
      </section>

      {/* e) INVITE — LIVE faceless mint (opaque code only; consent-first). */}
      <AgencyInvitePanel />

      {/* f) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). */}
      <section className="section">
        <h2>Referral funnel</h2>
        <ReferralFunnel summary={referrals} />
      </section>

      {/* g) PARKED MODULE CARDS — disabled, informational, NOT clickable fake flows. */}
      <AgencyParkedModules flags={flags} />
    </>
  );
}
