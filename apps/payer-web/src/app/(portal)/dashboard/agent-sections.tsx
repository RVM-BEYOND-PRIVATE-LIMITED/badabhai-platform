import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireAgent } from "../../../lib/auth/roles";
import { agencyFlags } from "../../../lib/config";
import {
  getAgencyAccount,
  getAgencyReferralsSummary,
  listAgencyJobs,
} from "../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../lib/assert-no-agency-pii";
import { summarizeAgencyJobs } from "../../../lib/agency-summary";
import { tradeLabel } from "../../../lib/agency-view";
import { bandLabel } from "../../../lib/masking";
import { AGENCY_POSTING_ROUTES } from "../../../lib/posting-routes";
import type {
  AgencyAccount,
  AgencyJob,
  AgencyReferralsSummary,
} from "../../../lib/contracts";
import { Badge, Card } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
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
 * agency-portal public flag additionally fail-closes (off → these sections render NOTHING;
 * the rest of the shared dashboard is unaffected — see the note at the flag check).
 *
 * FACELESS (CLAUDE.md §2 #2 + #6 / B-R2): the agency sees ONLY opaque ids, COUNTS, status
 * enums, coarse bands, timestamps, and its OWN org label — NEVER a worker name/phone/raw
 * resume/unconsented data. Every payload crosses {@link assertNoAgencyPII} at the render
 * boundary (defence-in-depth; the data seam also wraps it). k-anon flooring is applied inside
 * the referral funnel. NO worker id/phone/name ever enters the DOM or an href.
 *
 * LIVE (honest labelling): the account identity, a glance at the agency's OWN postings
 * (`/payer/agency/jobs`; they are created on `/agency/jobs/new` and managed on `/agency/jobs`),
 * the invite mint
 * (`POST /payer/agency/invites`), and the referral funnel
 * (`/payer/agency/referrals/summary`, aggregate + k-anon) are ALL LIVE payer-authed,
 * agent-role-gated reads/writes (ADR-0022). DATA-COHERENCE: for an agent these AGENCY
 * postings (`jobs.payer_id`) — NOT the employer `job-postings` the shared dashboard top
 * reads — are the source of truth for the posting count + listing; the shared top therefore
 * omits its `job-postings`-derived tile + "Your postings" section for agents so the two never
 * contradict (see dashboard/page.tsx). Every "New posting" for an agency opens the AGENCY form.
 *
 * The credits + unlocked-count stat tiles are NOT repeated here: they are coherent between
 * the two surfaces (same payer-authed reads) and already render in the shared top, so this
 * section adds only the agency-SPECIFIC identity + demand modules.
 */
/** How many of the agency's postings the dashboard glances at (the company panel's count). */
const GLANCE_ROWS = 6;

export async function AgentSections() {
  // 1) SERVER-enforced role gate — employer → neutral 404, before any agency read runs.
  const session = await requireAgent();

  // 2) Public flag fail-close: agency portal off → these sections do not render.
  //
  // RENDERS NOTHING, RATHER THAN 404-ing THE PAGE — and the difference only became visible
  // once MERGE-1 moved these modules INLINE. `notFound()` was right when this code guarded a
  // standalone `/agency/dashboard`: a surface that is switched off should not exist. Inline on
  // the SHARED `/dashboard`, the same call takes the whole page down for an agent, including
  // the shared top (credits, attention items, quick actions) that has nothing to do with
  // agency demand. And since `/agency/dashboard` is now a `redirect()` to here, an agent whose
  // flag was off had NO reachable home screen at all: every nav target, the brand lockup and
  // any old bookmark landed on the same 404. README called this flag the way to "roll back"
  // the agency surface; it bricked the portal instead.
  //
  // THE FAIL-CLOSED PROPERTY IS UNCHANGED, which is what makes this safe: authorization is
  // `requireAgent()` above, not this flag, and returning here still runs ZERO agency reads —
  // no account, jobs or referral fetch, nothing rendered, no PII surface. The flag gates a
  // SHELL, and a shell that is off should be absent, not fatal.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) return null;

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
      {/* Partial-read degrade: the UI-1 `alert` primitive (the DS replacement for the
          flat-Card + uppercase-Badge + paragraph this used to build by hand). The tone spine
          carries the "warning" the Badge used to; the recovery action moves into the
          alert's own action slot so a degraded read always offers the way out. */}
      {readError ? (
        <div className="alert alert--warning">
          <Icon name="warning" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Some signals unavailable</p>
            <p className="alert__body">
              One or more reads could not load right now — those panels show
              &ldquo;&mdash;&rdquo; until they recover.
            </p>
          </div>
          <div className="alert__actions">
            <RetryButton />
          </div>
        </div>
      ) : null}

      {/* a) AGENCY IDENTITY — the agency's OWN non-PII org label + account status.
          The tile row is the shared `stat-row` grid, which also carries the section's
          bottom rhythm — hence no block class on the <section> itself. */}
      <section>
        <div className="section__head">
          <h2 className="section__title">Your agency</h2>
        </div>
        <div className="stat-row">
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
          AGENT's authoritative posting count (NOT the shared top's job-postings tile). */}
      <section>
        <div className="section__head">
          <div className="section__text">
            <h2 className="section__title">Demand summary</h2>
            <p className="section__sub">Counts across the postings your agency has published.</p>
          </div>
        </div>
        <div className="stat-row">
          {/* A count, not a door: "All postings" on the panel below is this screen's one link
              to the Postings page. */}
          <Card className="agency-stat">
            <div className="agency-stat__head">
              <span className="agency-stat__label">Total postings</span>
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
          {/* NAV card (not a metric): the faceless engagement view of referred workers.
              It shows NO count here — a count would itself be a signal about how many
              referrals consented, and the page's own empty state tells that story
              honestly. */}
          <Card
            className="agency-stat"
            href="/agency/workers"
            ariaLabel="Worker activity — how the workers you referred are getting on"
          >
            <div className="agency-stat__head">
              <span className="agency-stat__label">Worker activity</span>
            </div>
            <div className="agency-stat__value">View activity</div>
            <div className="agency-stat__foot">
              <span className="agency-stat__hint">
                Referred workers who opted in <Icon name={ACTION_ICON.next} />
              </span>
            </div>
          </Card>
          {/* No Revenue card here: the shared top's Revenue tile is the dashboard's one way to
              that (parked) page — two on one screen, one captioned "View earnings" for a page
              that has none, was the duplicate. */}
        </div>
      </section>

      {/* c) YOUR POSTINGS — a glance at the agency's OWN postings: each card opens that
          posting's details, and the panel's one link opens the Postings page where they are
          managed. (An agency posting's applicants are not reachable in the UI yet — the feed
          endpoint does not serve agency jobs correctly; backend issue #1898.) `id` keeps old
          `#agency-vacancies` deep links landing here. */}
      <section id="agency-vacancies" className="panel">
        <div className="panel__head">
          <div className="panel__text">
            <h2 className="panel__title">Your postings</h2>
            <p className="panel__sub">The roles your agency has published, newest first.</p>
          </div>
          <div className="panel__actions">
            <Link className="bb-btn bb-btn--secondary bb-btn--sm" href={AGENCY_POSTING_ROUTES.list}>
              <span>All postings</span>
              <Icon name={ACTION_ICON.next} />
            </Link>
          </div>
        </div>
        <div className="panel__body">
          {jobs === null ? (
            <div className="state state--error">
              <span className="state__icon">
                <Icon name="warning-circle" />
              </span>
              <h3 className="state__title">Postings are unavailable right now</h3>
              <p className="state__body">
                The list could not be read. Nothing has changed — your postings are still there.
                Please retry shortly.
              </p>
              <div className="state__actions">
                <RetryButton />
              </div>
            </div>
          ) : jobs.length === 0 ? (
            <div className="state">
              <span className="state__icon">
                <Icon name={ACTION_ICON.posting} />
              </span>
              <h3 className="state__title">No postings yet</h3>
              <p className="state__body">
                Matched workers can only find your agency once a role is live — use New posting
                above. Posting is free through launch.
              </p>
            </div>
          ) : (
            <div className="dash-postings">
              {jobs.slice(0, GLANCE_ROWS).map((j) => (
                // Whole-card link to THIS posting's details. The id is the posting's OWN opaque
                // uuid (never a worker id/phone).
                <Card
                  key={j.id}
                  padding="sm"
                  className="dash-posting"
                  href={`${AGENCY_POSTING_ROUTES.list}/${j.id}`}
                  ariaLabel={`${j.title} — view posting`}
                >
                  <div className="dash-posting__main">
                    <div className="dash-posting__title">{j.title}</div>
                    <div className="dash-posting__meta">
                      {tradeLabel(j.tradeKey)} ·{" "}
                      {bandLabel([j.city, j.area]) || "Location flexible"}
                    </div>
                  </div>
                  <div className="dash-posting__right">
                    <Badge tone={j.status === "open" ? "success" : "neutral"} upper>
                      {j.status}
                    </Badge>
                    <span className="dash-posting__cta">
                      View posting
                      <Icon name={ACTION_ICON.next} className="dash-view__arrow" />
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* d) INVITE — LIVE faceless mint (opaque code only; consent-first). */}
      <AgencyInvitePanel />

      {/* d2) INVITE TOOLS — the LIVE ways to hand out invites (QR, batch mint) plus the ONE
          module that is not available. HONESTY (ADR-0022 Amdt 3): "Bulk invite upload"
          (module 2) is DEAD with NO gate — it would have the agency upload real people's
          contacts before consent (invariant #2 + the faceless rails) — so it is NEVER
          advertised as coming. Batch invite MINTING is the shipped answer to the same need
          and is the opposite shape: BadaBhai generates anonymous links that identify nobody.
          The two must stay distinguishable in the copy, not blurred into "bulk unavailable".
          The bulk card still LINKS to /agency/bulk-upload, which explains the reason (the
          route stays so the tile never 404s) — and it is the portal's ONE way there: the rail
          and the parked-modules list no longer show it. */}
      <section>
        <div className="section__head">
          <div className="section__text">
            <h2 className="section__title">Invite tools</h2>
            <p className="section__sub">More ways to hand out invite links.</p>
          </div>
        </div>
        <div className="stat-row">
          <Card
            className="agency-stat"
            href="/agency/qr"
            ariaLabel="Generate a scannable invite QR code"
          >
            <div className="agency-stat__head">
              <span className="agency-stat__label">QR invite</span>
            </div>
            <div className="agency-stat__value">Generate QR</div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>Live</Badge>
              <span className="agency-stat__hint">Share a scannable invite QR</span>
            </div>
          </Card>
          {/* LIVE batch mint — lives on /agency/referrals; this tile is how it is found. */}
          <Card
            className="agency-stat"
            href="/agency/referrals#batch-invites"
            ariaLabel="Batch invite links — create several anonymous invite links at once"
          >
            <div className="agency-stat__head">
              <span className="agency-stat__label">Batch invites</span>
            </div>
            <div className="agency-stat__value">Create links</div>
            <div className="agency-stat__foot">
              <Badge tone="success" upper>Live</Badge>
              <span className="agency-stat__hint">
                Several anonymous links at once &mdash; each identifies nobody
              </span>
            </div>
          </Card>
          <Card
            className="agency-stat"
            href="/agency/bulk-upload"
            ariaLabel="Bulk invite upload — not available: consent violation"
          >
            <div className="agency-stat__head">
              <span className="agency-stat__label">Bulk invite upload</span>
            </div>
            <div className="agency-stat__value">Not available</div>
            <div className="agency-stat__foot">
              <Badge tone="warning" upper>Not available</Badge>
              <span className="agency-stat__hint">
                Uploading a list of workers&rsquo; contacts is a consent violation
              </span>
            </div>
          </Card>
        </div>
      </section>

      {/* e) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). */}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Referral funnel</h2>
        </div>
        <div className="panel__body">
          <ReferralFunnel summary={referrals} />
        </div>
      </section>

      {/* f) PARKED MODULE CARDS — disabled, informational, NOT clickable fake flows. */}
      <AgencyParkedModules flags={flags} />
    </>
  );
}
