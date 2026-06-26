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
import { Badge, Card } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";
import { AgencyJobsManager } from "./agency-jobs-manager";
import { AgencyInvitePanel } from "./invite-panel";
import { ReferralFunnel } from "./referral-funnel";
import { AgencyParkedModules } from "./parked-modules";

export const dynamic = "force-dynamic";

/**
 * AGENCY DASHBOARD (ADR-0019 DEMAND extension + ADR-0022 demand slice) — FACELESS.
 * DS3.1 re-skin onto the BadaBhai Design System (VISUAL layer only).
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
 *
 * VISUAL: identity + credit + demand counts render as DS `Card` stat tiles (counts + ₹ in
 * mono tabular); the live/account status is a DS `Badge` (green = live/active). The
 * error/degrade/empty states are DS `Card`s with a neutral message + `RetryButton`. Tokens
 * only (no raw hex/px). The page holds NO form/input controls — those live in the child
 * client components.
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
  const accountActive = account?.status === "active";

  return (
    <>
      <p className="agency-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="agency-title">Agency dashboard</h1>
      <p className="agency-sub">
        Post roles and manage demand like a payer account. BadaBhai protects worker privacy.
        Agencies see only consent-safe progress and aggregate signals.
      </p>

      {readError ? (
        <Card variant="flat" className="agency-degrade">
          <Badge tone="warning" upper>
            Some signals unavailable
          </Badge>
          <p className="agency-degrade__msg">
            One or more reads could not load right now — those panels show
            &ldquo;&mdash;&rdquo; until they recover. <RetryButton />
          </p>
        </Card>
      ) : null}

      {/* a) IDENTITY + FACELESS REACH SUMMARY — LIVE credits + unlocked count. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Your agency</h2>
        <div className="agency-stats">
          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Account</span>
            </div>
            <div className="agency-stat__value">{account?.displayLabel ?? "Your agency"}</div>
            <div className="agency-stat__foot">
              <Badge tone="brand" upper>
                Agency
              </Badge>
              <Badge tone={accountActive ? "success" : "warning"} upper>
                {account?.status ?? "—"}
              </Badge>
            </div>
          </Card>

          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Credit balance</span>
            </div>
            <div className="agency-stat__value bb-mono">{dash(credits ? credits.balance : null)}</div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>
                Live
              </Badge>
              <Link className="agency-link" href="/credits">
                Top up credits →
              </Link>
            </div>
          </Card>

          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Contacts unlocked</span>
            </div>
            <div className="agency-stat__value bb-mono">{dash(unlocksCount)}</div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>
                Live
              </Badge>
              <span className="agency-stat__hint">1 credit per contact</span>
            </div>
          </Card>
        </div>
      </section>

      {/* b) DEMAND JOB SUMMARY — counts derived from the agency's OWN LIVE jobs. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Demand summary</h2>
        <div className="agency-stats">
          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Total vacancies</span>
            </div>
            <div className="agency-stat__value bb-mono">{dash(demand ? demand.total : null)}</div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>
                Live
              </Badge>
              <span className="agency-stat__hint">Your agency&rsquo;s own roles</span>
            </div>
          </Card>
          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Open</span>
            </div>
            <div className="agency-stat__value bb-mono">{dash(demand ? demand.open : null)}</div>
            <div className="agency-stat__foot">
              <span className="agency-stat__hint">
                Closed <span className="bb-mono">{dash(demand ? demand.closed : null)}</span>
              </span>
            </div>
          </Card>
          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Applicants received</span>
            </div>
            <div className="agency-stat__value bb-mono">
              {dash(demand ? demand.applicantsReceived : null)}
            </div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>
                Live
              </Badge>
              <span className="agency-stat__hint">Across all your roles</span>
            </div>
          </Card>
        </div>
      </section>

      {/* d) VACANCY MANAGEMENT — LIVE list + create/edit/pause/close on the agency jobs. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Your vacancies</h2>
        {jobs ? (
          <AgencyJobsManager jobs={jobs} />
        ) : (
          <Card variant="flat" className="agency-jobs__empty">
            Vacancies are unavailable right now. Please retry shortly. <RetryButton />
          </Card>
        )}
      </section>

      {/* e) INVITE — LIVE faceless mint (opaque code only; consent-first). */}
      <AgencyInvitePanel />

      {/* f) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). */}
      <section className="agency-section">
        <h2 className="agency-section__title">Referral funnel</h2>
        <ReferralFunnel summary={referrals} />
      </section>

      {/* g) PARKED MODULE CARDS — disabled, informational, NOT clickable fake flows. */}
      <AgencyParkedModules flags={flags} />
    </>
  );
}
