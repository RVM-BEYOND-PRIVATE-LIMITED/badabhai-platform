import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { getAgencyAccount, getCredits, getPostings, getUnlocks } from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import { summarizeJobStatuses } from "../../../../lib/agency-summary";
import type { AgencyAccount, CreditBalance, PostingSummary } from "../../../../lib/contracts";
import { PostingsManager } from "../../postings/postings-manager";
import { AgencyInvitePanel } from "./invite-panel";
import { AgencyParkedModules } from "./parked-modules";

export const dynamic = "force-dynamic";

/**
 * AGENCY DASHBOARD (ADR-0019 DEMAND extension) — READ-ONLY, FACELESS.
 *
 * SECURITY / authz (XB-A / XT3): the FIRST statement is `requireAgent()`, which reads
 * the SERVER-HELD signed session and returns a NEUTRAL 404 for any non-`agent` (an
 * employer cannot reach, read, or confirm this page exists). The agency-portal public
 * flag additionally fail-closes the route (off → notFound()).
 *
 * FACELESS (CLAUDE.md §2 #2 + #6 / B-R2): the agency sees ONLY opaque worker ids,
 * COUNTS, status enums, timestamps, and its OWN org label — NEVER a worker name/phone/
 * raw resume/unconsented data. Every payload crosses {@link assertNoAgencyPII} at the
 * render boundary as defence-in-depth (in dev it throws on a forbidden key; in prod it
 * strips). No mutating action ships here — read-only + a DISABLED, consent-first invite.
 *
 * LIVE vs MOCK (honest labelling): credits + unlocks + the account identity are LIVE
 * payer-authed reads; postings/jobs are MOCK until a payer-authed job-postings endpoint
 * lands (the panels say so). The invite control is DISABLED — there is NO agency invite
 * API (POST /invites is WORKER-authed). Nothing fakes success.
 */
export default async function AgencyDashboardPage() {
  // 1) SERVER-enforced role gate — employer → neutral 404, before anything renders.
  const session = await requireAgent();

  // 2) Public flag fail-close: agency portal off → the route does not exist.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  // 3) LIVE reads (account/credits/unlocks) + MOCK read (postings). Each isolated so a
  //    single failing source degrades to "—"/"unavailable", never a blank screen.
  let account: AgencyAccount | null = null;
  let credits: CreditBalance | null = null;
  let unlocksCount: number | null = null;
  let postings: PostingSummary[] | null = null;
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
    postings = assertNoAgencyPII(await getPostings(), "payer/job-postings (mock)");
  } catch {
    readError = true;
  }

  const jobs = postings ? summarizeJobStatuses(postings) : null;
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
          not load right now — those panels show &ldquo;&mdash;&rdquo; until they recover.
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

      {/* b) DEMAND JOB SUMMARY — counts derived from the MOCK postings seam. */}
      <section className="section">
        <h2>Demand summary</h2>
        <div className="note warn">
          <strong>Preview.</strong> Vacancy counts are a preview until the backend posting API lands
          — they are not yet a live payer-authed read.
        </div>
        <div className="cards">
          <div className="card">
            <h3>Total vacancies</h3>
            <div className="big">{dash(jobs ? jobs.total : null)}</div>
            <p>
              <span className="badge badge-warn">Preview</span>{" "}
              <Link href="/postings/new">Post a vacancy →</Link>
            </p>
          </div>
          <div className="card">
            <h3>Open</h3>
            <div className="big">{dash(jobs ? jobs.open : null)}</div>
            <p>Paused {dash(jobs ? jobs.paused : null)}</p>
          </div>
          <div className="card">
            <h3>Closed</h3>
            <div className="big">{dash(jobs ? jobs.closed : null)}</div>
            <p>Draft {dash(jobs ? jobs.draft : null)}</p>
          </div>
        </div>

        {/* Counts with NO backend source — honest "not available yet", never fabricated. */}
        <div className="cards">
          <div className="card">
            <h3>Workers reached</h3>
            <div className="big">—</div>
            <p>
              <span className="badge badge-warn">Not available yet</span> No backend source.
            </p>
          </div>
          <div className="card">
            <h3>Eligible / consented</h3>
            <div className="big">—</div>
            <p>
              <span className="badge badge-warn">Not available yet</span> No backend source.
            </p>
          </div>
          <div className="card">
            <h3>Invite intent</h3>
            <div className="big">—</div>
            <p>
              <span className="badge badge-warn">Not available yet</span> No agency invite API.
            </p>
          </div>
        </div>
      </section>

      {/* d) JOBS LIST/TABLE — reuse the postings manager (MOCK until backend). */}
      <section className="section">
        <h2>Your vacancies</h2>
        <div className="note warn">
          <strong>Mock.</strong> Vacancy management is a preview until the backend posting API
          lands; pause / resume / quota top-up act on local preview rows only.
        </div>
        {postings ? (
          <PostingsManager postings={postings} />
        ) : (
          <div className="empty">Vacancies are unavailable right now. Please retry shortly.</div>
        )}
      </section>

      {/* e) INVITE INTENT — DISABLED, consent-first explainer. NO link is generated. */}
      <AgencyInvitePanel />

      {/* f) PARKED MODULE CARDS — disabled, informational, NOT clickable fake flows. */}
      <AgencyParkedModules flags={flags} />
    </>
  );
}
