import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireAgent } from "../../../lib/auth/roles";
import { agencyFlags } from "../../../lib/config";
import { getAgencyReferralsSummary, listAgencyJobs } from "../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../lib/assert-no-agency-pii";
import { formatInr } from "../../../lib/format";
import { summarizeAgencyJobs } from "../../../lib/agency-summary";
import { kAnonCount, tradeLabel } from "../../../lib/agency-view";
import { lowBalanceThreshold } from "../../../lib/pricing-config";
import { bandLabel } from "../../../lib/masking";
import { AGENCY_POSTING_ROUTES } from "../../../lib/posting-routes";
import { recentUnlockRows } from "../../../lib/unlock-history";
import type {
  AgencyJob,
  AgencyReferralsSummary,
  CreditBalance,
  UnlockHistoryItem,
} from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { PortalLink } from "../../../components/portal-link";
import { RetryButton } from "../../../components/retry-button";

/**
 * AGENCY DASHBOARD (designr8) — the agency-only half of the unified `/dashboard`.
 *
 * SERVER component. The FIRST statement is `requireAgent()`, so an employer can never reach
 * an agency read even if a future caller composed this wrongly; the agency-portal flag then
 * fail-closes (off → render nothing, read nothing) without taking the shared page down.
 *
 * FACELESS: only opaque ids, counts, status enums, coarse bands and the agency's own label
 * reach the DOM. Every payload crosses `assertNoAgencyPII` at the render boundary. No worker
 * name/phone/raw resume/unconsented data is read or rendered.
 *
 * The credit/unlock reads belong to the shared page (one payer-scoped read each); they arrive
 * as props so this section never fetches them twice. Everything agency-specific — the jobs
 * list and the k-anon referral funnel — is read here, each isolated so one failure degrades
 * that panel only.
 */
export interface AgentSectionsProps {
  credits: CreditBalance | null;
  unlocks: UnlockHistoryItem[] | null;
  unitPriceInr: number | null;
}

const GLANCE_ROWS = 3;

export async function AgentSections({
  credits = null,
  unlocks = null,
  unitPriceInr = null,
}: Partial<AgentSectionsProps> = {}) {
  // 1) SERVER-enforced role gate — employer → neutral 404, before any agency read runs.
  await requireAgent();

  // 2) Public flag fail-close: agency portal off → these sections do not render.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) return null;

  // 3) LIVE reads, each isolated so a single failing source degrades to "—"/empty rather
  //    than blanking the page.
  let jobs: AgencyJob[] | null = null;
  let referrals: AgencyReferralsSummary | null = null;
  let readError = false;

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
  const unlockRows = recentUnlockRows(unlocks ?? [], [], Date.now());
  const lowBalance = credits !== null && credits.balance < lowBalanceThreshold();

  return (
    <>
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

      {/* KPI strip — the four cards designr8 opens with. */}
      <div className="stat-row stat-row--kpi">
        <StatTile
          className="dash-kpi dash-kpi--credit"
          label="Credit balance"
          value={credits?.balance ?? "—"}
          icon={ACTION_ICON.credits}
          status={
            credits === null ? undefined : (
              <span
                className={
                  lowBalance
                    ? "dash-stat-pill dash-stat-pill--low"
                    : "dash-stat-pill dash-stat-pill--ready"
                }
              >
                {lowBalance ? "Low" : "Ready"}
              </span>
            )
          }
          caption={
            credits === null ? (
              "Not available right now"
            ) : unitPriceInr !== null ? (
              <>
                <span className="bb-mono">{formatInr(unitPriceInr)}</span> per contact unlock
              </>
            ) : undefined
          }
          foot={
            <PortalLink className="dash-kpi__link" href="/credits" pendingLabel="Credits">
              <Icon name="plus" /> Top-up
            </PortalLink>
          }
        />

        <StatTile
          className="dash-kpi dash-kpi--unlocks"
          label="Contacts unlocked"
          value={unlocks?.length ?? "—"}
          icon="lock-key"
          status={unlocks === null ? undefined : <span className="dash-stat-note">revealed</span>}
          caption={unlocks === null ? "Not available right now" : "1 credit / 1 profile"}
          foot={<span className="dash-kpi__meta">Direct verified phone &amp; email access</span>}
        />

        <StatTile
          className="dash-kpi dash-kpi--postings"
          label="Demand summary"
          value={demand ? demand.open : "—"}
          icon={ACTION_ICON.posting}
          status={demand ? <span className="dash-stat-pill dash-stat-pill--ready">Live</span> : undefined}
          caption={demand ? `${demand.applicantsReceived} applicants` : "Not available right now"}
          foot={<span className="dash-kpi__meta">Open roles across your agency</span>}
        />

        <StatTile
          className="dash-kpi dash-kpi--referrals"
          label="Worker referrals"
          value={referrals ? kAnonCount(referrals.created, referrals.minBucket) : "—"}
          icon="users-three"
          status={
            referrals ? (
              <span className="dash-stat-pill dash-stat-pill--ready">Consent Ready</span>
            ) : undefined
          }
          caption={
            referrals ? "Privacy-first worker conversion" : "Not available right now"
          }
          foot={<span className="dash-kpi__meta">Invites sent</span>}
        />
      </div>

      <div className="agency-dash-grid">
        {/* Your postings & recruitment pipeline */}
        <section
          id="agency-vacancies"
          className="panel dash-panel agency-pipeline-panel anchor-target"
        >
          <div className="panel__head">
            <div className="panel__text">
              <div className="dash-panel__titlerow">
                <h2 className="panel__title">Your Postings &amp; Recruitment Pipeline</h2>
                {demand ? <span className="dash-count">{demand.open} Active roles</span> : null}
              </div>
              <p className="panel__sub">
                Roles your agency has published, newest first.
              </p>
            </div>
            <div className="panel__actions">
              <PortalLink
                className="dash-panel__link"
                href={AGENCY_POSTING_ROUTES.list}
                pendingLabel="Postings"
              >
                View all <Icon name={ACTION_ICON.next} />
              </PortalLink>
            </div>
          </div>

          <div className="agency-pipeline">
            <div>
              <span>TOTAL POSTINGS</span>
              <strong className="bb-mono">{demand ? demand.total : "—"}</strong>
              <em>created</em>
            </div>
            <div>
              <span>ACTIVE OPEN</span>
              <strong className="bb-mono">{demand ? demand.open : "—"}</strong>
              <em>filled</em>
            </div>
            <div>
              <span>APPLICANTS RECEIVED</span>
              <strong className="bb-mono">
                {demand ? demand.applicantsReceived : "—"}
              </strong>
              <em>across all</em>
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
              <div className="state dash-empty-panel agency-empty-panel">
                <span className="state__icon dash-empty-panel__icon">
                  <Icon name={ACTION_ICON.posting} />
                </span>
                <h3 className="state__title">No active postings yet</h3>
                <p className="state__body">
                  Matched workers can only find your agency once a role is published. Postings are
                  100% free through launch.
                </p>
                <div className="dash-empty-panel__actions">
                  <PortalLink
                    className="bb-btn bb-btn--primary"
                    href={AGENCY_POSTING_ROUTES.create}
                    pendingLabel="New posting"
                  >
                    <Icon name={ACTION_ICON.create} />
                    <span>Create New Posting</span>
                  </PortalLink>
                  <PortalLink
                    className="bb-btn bb-btn--secondary"
                    href={AGENCY_POSTING_ROUTES.list}
                    pendingLabel="Postings"
                  >
                    <span>View postings</span>
                  </PortalLink>
                </div>
              </div>
            ) : (
              <div className="dash-postings">
                {jobs.slice(0, GLANCE_ROWS).map((j) => (
                  <Card
                    key={j.id}
                    padding="sm"
                    className="dash-posting"
                    href={`${AGENCY_POSTING_ROUTES.list}/${j.id}`}
                    ariaLabel={`${j.title} — view posting`}
                    pendingLabel={j.title}
                  >
                    <span className="dash-posting__icon" aria-hidden="true">
                      <Icon name={ACTION_ICON.posting} />
                    </span>
                    <div className="dash-posting__main">
                      <div className="dash-posting__title">{j.title}</div>
                      <div className="dash-posting__meta">
                        <span>
                          <Icon name="map-pin" />
                          {bandLabel([j.city, j.area]) || "Location flexible"}
                        </span>
                        <span>
                          <Icon name="briefcase" />
                          {tradeLabel(j.tradeKey)}
                        </span>
                      </div>
                    </div>
                    <div className="dash-posting__right">
                      <PortalLink
                        className="dash-posting__applicants"
                        href={`${AGENCY_POSTING_ROUTES.list}/${j.id}/applicants`}
                        pendingLabel="Applicants"
                      >
                        Applicants
                      </PortalLink>
                      <Badge tone={j.status === "open" ? "success" : "neutral"} upper>
                        {j.status}
                      </Badge>
                      <span className="dash-posting__cta">
                        View posting <Icon name={ACTION_ICON.next} className="dash-view__arrow" />
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="agency-pipeline__foot">
            <Icon name="sparkle" />
            <p>
              <strong>Need help drafting?</strong> Our talent engine matches candidates within
              minutes.
            </p>
            <PortalLink
              className="dash-panel__link"
              href={AGENCY_POSTING_ROUTES.create}
              pendingLabel="New posting"
            >
              Learn how <Icon name={ACTION_ICON.next} />
            </PortalLink>
          </div>
        </section>

        {/* Right rail — funnel + recent unlocks */}
        <div className="agency-dash-side">
          <section className="panel dash-panel">
            <div className="panel__head">
              <div className="panel__text">
                <h2 className="panel__title">Referral Funnel &amp; Growth</h2>
                <p className="panel__sub">
                  How workers you invite are joining, in aggregate.
                </p>
              </div>
              <div className="panel__actions">
                <PortalLink
                  className="bb-btn bb-btn--primary bb-btn--sm"
                  href="/agency/referrals"
                  pendingLabel="Referrals"
                >
                  <Icon name="user-plus" /> Invite workers
                </PortalLink>
              </div>
            </div>
            <div className="panel__body">
              {referrals === null ? (
                <div className="state state--error">
                  <span className="state__icon">
                    <Icon name="warning-circle" />
                  </span>
                  <h3 className="state__title">Referral funnel unavailable</h3>
                  <p className="state__body">
                    Your funnel counts could not load right now. Nothing has changed — please
                    retry shortly.
                  </p>
                  <div className="state__actions">
                    <RetryButton />
                  </div>
                </div>
              ) : (
                <>
                  <div className="agency-stages">
                    <div className="agency-stage">
                      <span>INVITES SENT</span>
                      <strong className="bb-mono">
                        {kAnonCount(referrals.created, referrals.minBucket)}
                      </strong>
                      <em>Links generated</em>
                    </div>
                    <div className="agency-stage">
                      <span>CLICKED</span>
                      <strong className="bb-mono">
                        {kAnonCount(referrals.clicked, referrals.minBucket)}
                      </strong>
                      <em>Opened link</em>
                    </div>
                    <div className="agency-stage">
                      <span>ACCEPTED</span>
                      <strong className="bb-mono">
                        {kAnonCount(referrals.accepted, referrals.minBucket)}
                      </strong>
                      <em>Joined agency</em>
                    </div>
                  </div>
                  <p className="agency-privacy-note">
                    <Icon name="shield-check" />
                    Aggregate only — counts below {referrals.minBucket} show as &ldquo;&lt;
                    {referrals.minBucket}&rdquo; to protect individual worker privacy.
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="panel dash-panel">
            <div className="panel__head">
              <div className="panel__text">
                <h2 className="panel__title">Recent Candidate Unlocks</h2>
                <p className="panel__sub">Direct phone &amp; WhatsApp reveal vault.</p>
              </div>
              <div className="panel__actions">
                <PortalLink
                  className="dash-panel__link"
                  href="/credits"
                  pendingLabel="Credits"
                >
                  Usage log <Icon name={ACTION_ICON.next} />
                </PortalLink>
              </div>
            </div>
            <div className="panel__body">
              {unlocks === null ? (
                <div className="state state--error">
                  <span className="state__icon">
                    <Icon name="warning-circle" />
                  </span>
                  <h3 className="state__title">Recent unlocks unavailable</h3>
                  <p className="state__body">
                    Your unlocked contacts are safe. Please retry to read them again.
                  </p>
                  <div className="state__actions">
                    <RetryButton />
                  </div>
                </div>
              ) : unlockRows.length === 0 ? (
                <div className="state dash-empty-panel agency-empty-panel">
                  <span className="state__icon dash-empty-panel__icon">
                    <Icon name="lock-key" />
                  </span>
                  <h3 className="state__title">No contacts unlocked yet</h3>
                  <p className="state__body">
                    Open candidate profiles to reveal verified direct mobile, WhatsApp, and
                    complete verified work history.
                  </p>
                </div>
              ) : (
                <div className="dash-candlist">
                  {unlockRows.map((row) => (
                    <div className="dash-unlock" key={row.key}>
                      <span
                        className={
                          row.live
                            ? "dash-unlock__icon dash-unlock__icon--live"
                            : "dash-unlock__icon"
                        }
                        aria-hidden="true"
                      >
                        <Icon name={row.live ? "lock-key-open" : "lock-key"} />
                      </span>
                      <div className="dash-unlock__main">
                        <div className="dash-unlock__title">Unlocked contact</div>
                        <div className="dash-unlock__meta">
                          Unlocked <span className="bb-mono">{row.unlockedOn}</span> ·{" "}
                          {row.live ? "until" : "ended"}{" "}
                          <span className="bb-mono">{row.endsOn}</span>
                        </div>
                      </div>
                      <div className="dash-unlock__right">
                        <Badge tone={row.live ? "success" : "neutral"} upper>
                          {row.live ? "Unlocked" : "Expired"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="dash-panel__foot">
              <span className="dash-panel__footstart">
                <Icon name="check-circle" /> Auto-refund if phone number is invalid
              </span>
              <span className="dash-panel__footend">Consent-gated</span>
            </div>
          </section>
        </div>
      </div>

      <footer className="dash-foot">
        <div className="dash-foot__status">
          <span className="dash-foot__dot" aria-hidden="true" />
          <span>Gateway Online: BadaBhai Recruiter Engine v2.8</span>
          <span className="dash-foot__sep" aria-hidden="true">
            ·
          </span>
          <span>Candidate Database: 180,000+ Verified Workers</span>
        </div>
        <div className="dash-foot__links">
          <span>Worker identities masked until consent-granted</span>
          <span>Employer Helpdesk</span>
          <span>Pricing Terms</span>
        </div>
      </footer>
    </>
  );
}
