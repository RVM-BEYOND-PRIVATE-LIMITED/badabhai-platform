import { notFound } from "next/navigation";
import { requireAgent } from "../../../lib/auth/roles";
import { agencyFlags } from "../../../lib/config";
import {
  getAgencyAccount,
  getAgencyReferralsSummary,
  listAgencyJobs,
} from "../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../lib/assert-no-agency-pii";
import { summarizeAgencyJobs } from "../../../lib/agency-summary";
import type {
  AgencyAccount,
  AgencyJob,
  AgencyReferralsSummary,
} from "../../../lib/contracts";
import { Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { AgencyJobsManager } from "../agency/dashboard/agency-jobs-manager";
import { AgencyInvitePanel } from "../agency/dashboard/invite-panel";
import { ReferralFunnel } from "../agency/dashboard/referral-funnel";
import { AgencyParkedModules } from "../agency/dashboard/parked-modules";

/**
 * AGENT DEMAND SECTIONS (MERGE-1) — the agency-only modules of the unified `/dashboard`.
 * DS3.1 visual layer; SERVER component. Rendered by `dashboard/page.tsx` ONLY in the
 * `session.role === "agent"` branch; an EMPLOYER never imports/reaches this (the page does
 * not render it for them), so an employer never fetches or sees any agency read.
 *
 * SECURITY / authz (XB-A / XT3 — DEFENCE-IN-DEPTH): the FIRST statement is `requireAgent()`,
 * which reads the SERVER-HELD signed session and returns a NEUTRAL 404 for any non-`agent`.
 * This re-asserts the role server-side independently of the page's own `isAgency` label, so
 * the agency reads CANNOT run for a non-agent even if a future caller composed it wrong. The
 * agency-portal public flag additionally fail-closes (off → notFound()).
 *
 * FACELESS (CLAUDE.md §2 #2 + #6 / B-R2): the agency sees ONLY opaque ids, COUNTS, status
 * enums, coarse bands, timestamps, and its OWN org label — NEVER a worker name/phone/raw
 * resume/unconsented data. Every payload crosses {@link assertNoAgencyPII} at the render
 * boundary (defence-in-depth; the data seam also wraps it). k-anon flooring is applied inside
 * the referral funnel. NO worker id/phone/name ever enters the DOM or an href.
 *
 * LIVE (honest labelling): the account identity, the agency's OWN vacancies
 * (`/payer/agency/jobs` — list + create + edit + pause + close), the invite mint
 * (`POST /payer/agency/invites`), and the referral funnel
 * (`/payer/agency/referrals/summary`, aggregate + k-anon) are ALL LIVE payer-authed,
 * agent-role-gated reads/writes (ADR-0022). DATA-COHERENCE: for an agent these AGENCY
 * vacancies (`jobs.payer_id`) — NOT the employer `job-postings` the shared dashboard top
 * reads — are the source of truth for the vacancy count + listing; the shared top therefore
 * omits its `job-postings`-derived "Open vacancies" tile + "Your vacancies" section for agents
 * so the two never contradict (see dashboard/page.tsx).
 *
 * The credits + unlocked-count stat tiles are NOT repeated here: they are coherent between
 * the two surfaces (same payer-authed reads) and already render in the shared top, so this
 * section adds only the agency-SPECIFIC identity + demand modules.
 */
export async function AgentSections() {
  // 1) SERVER-enforced role gate — employer → neutral 404, before any agency read runs.
  const session = await requireAgent();

  // 2) Public flag fail-close: agency portal off → the section (and the route) does not exist.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  // 3) LIVE reads, each isolated so a single failing source degrades to "—"/empty rather
  //    than blanking the page. Credits + unlocks are intentionally NOT re-read here — the
  //    shared dashboard top owns those (coherent, same reads).
  let account: AgencyAccount | null = null;
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
    jobs = assertNoAgencyPII(await listAgencyJobs(), "payer/agency/jobs");
  } catch {
    readError = true;
  }
  try {
    referrals = assertNoAgencyPII(
      await getAgencyReferralsSummary(),
      "payer/agency/referrals/summary",
    );
  } catch {
    readError = true;
  }

  const demand = jobs ? summarizeAgencyJobs(jobs) : null;
  const dash = (n: number | null): string => (n === null ? "—" : String(n));
  const accountActive = account?.status === "active";

  return (
    <>
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

      {/* a) AGENCY IDENTITY — the agency's OWN non-PII org label + account status. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Your agency</h2>
        <div className="agency-stats">
          <Card
            className="agency-stat"
            href="/account"
            ariaLabel={`Account ${account?.displayLabel ?? "Your agency"} — manage account`}
          >
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
        </div>
      </section>

      {/* b) DEMAND SUMMARY — counts derived from the agency's OWN LIVE jobs. This is the
          AGENT's authoritative vacancy count (NOT the shared top's job-postings tile). */}
      <section className="agency-section">
        <h2 className="agency-section__title">Demand summary</h2>
        <div className="agency-stats">
          {/* Whole-card link to the vacancy manager section below (same page now, #-fragment). */}
          <Card
            className="agency-stat"
            href="/dashboard#agency-vacancies"
            ariaLabel={`Total vacancies ${dash(demand ? demand.total : null)} — manage vacancies`}
          >
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

      {/* c) VACANCY MANAGEMENT — LIVE list + create/edit/pause/close on the agency jobs.
          `id` is the in-page anchor target for the "Total vacancies" demand tile (#-fragment). */}
      <section id="agency-vacancies" className="agency-section">
        <h2 className="agency-section__title">Your vacancies</h2>
        {jobs ? (
          <AgencyJobsManager jobs={jobs} />
        ) : (
          <Card variant="flat" className="agency-jobs__empty">
            Vacancies are unavailable right now. Please retry shortly. <RetryButton />
          </Card>
        )}
      </section>

      {/* d) INVITE — LIVE faceless mint (opaque code only; consent-first). */}
      <AgencyInvitePanel />

      {/* e) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). */}
      <section className="agency-section">
        <h2 className="agency-section__title">Referral funnel</h2>
        <ReferralFunnel summary={referrals} />
      </section>

      {/* f) PARKED MODULE CARDS — disabled, informational, NOT clickable fake flows. */}
      <AgencyParkedModules flags={flags} />
    </>
  );
}
