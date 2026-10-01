import { notFound } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { listAgencyWorkers } from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import type { AgencyWorker } from "../../../../lib/contracts";
import { PageHeader } from "../../../../components/page-header";
import { RetryButton } from "../../../../components/retry-button";
import { REFERRED_WORKERS_HEADING_ID, WorkerActivityList } from "./worker-activity-list";

export const dynamic = "force-dynamic";

/** The backend's hard cap on this list (AgencyWorkersService.MAX_ROWS) — a full page means
 *  the tail was truncated, and we say so rather than implying it is the whole picture. */
const MAX_ROWS = 200;

/**
 * Agency-only "Worker activity" (ADR-0022 portal, B5) — the ENGAGEMENT view of the workers
 * this agency referred, answering the only question an agency actually needs answered: are my
 * referrals worth anything? It answers it as a FUNNEL (profile done / applying / being
 * unlocked / still around), never as people.
 *
 * SECURITY (role authz / XB-A): `requireAgent()` is the FIRST statement — an employer session
 * gets the SAME neutral 404 every other agency route gives, before any read runs. No
 * client-side hiding. Tenancy is the SESSION: the endpoint takes no payer/agency parameter at
 * all, so there is nothing to tamper with.
 *
 * FACELESS (CLAUDE.md §2 #2): the payload is opaque per-agency handles, booleans, counts and
 * coarse UTC days. No worker name/phone/employer/address; no WHICH job and no WHO unlocked.
 * The seam already crosses {@link assertNoAgencyPII}; the render boundary crosses it again
 * (defence-in-depth), so a regressed backend payload fails loudly in dev/test and is stripped
 * in prod rather than rendered.
 *
 * CONSENT (invariant #6): the backend selects only workers carrying an ACTIVE
 * `agent_activity_visibility` consent, and a non-consenting worker is absent IDENTICALLY to a
 * never-referred one — the list is not a consent oracle. No client asks for that consent
 * purpose yet, so EMPTY is the state this page ships in; it is handled as a first-class,
 * honest state, not an error and not a "coming soon" tease.
 *
 * DEGRADE: the read is isolated in a try/catch. A backend failure — including the 429 from the
 * per-payer hourly scrape cap this route rides — renders a neutral `.state--error` with a retry
 * instead of blanking the page or, worse, showing an empty table that would read as "you have no
 * referrals". The copy stays neutral: the CLASS of failure is never surfaced (no-oracle).
 * LOADING is the portal-level `loading.tsx` skeleton (this page is force-dynamic).
 */
export default async function AgencyWorkersPage() {
  // 1) SERVER-enforced role gate — an `employer` session 404s here before any read runs.
  await requireAgent();

  // 2) Public flag fail-close: agency portal off → the route does not exist.
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  // 3) LIVE faceless read, isolated: `null` means the read FAILED (retry card) and is
  //    deliberately distinct from `[]`, which means "no consenting referred workers".
  let workers: AgencyWorker[] | null = null;
  try {
    workers = assertNoAgencyPII(await listAgencyWorkers(), "payer/agency/workers");
  } catch {
    workers = null;
  }

  // The truthful count/truncation line. Computed here (not inline) because it is the panel's
  // sub-line AND gates the handle-uniqueness line in the privacy alert, and an empty list must
  // produce NO count line at all rather than "0".
  const countLine =
    workers !== null && workers.length > 0
      ? workers.length >= MAX_ROWS
        ? `Showing your ${MAX_ROWS} most recently active referrals.`
        : `Showing ${workers.length} referred ${workers.length === 1 ? "worker" : "workers"}.`
      : null;

  return (
    // `.agency-workers-page` only NAMESPACES this screen's layout rules (see the "AGENCY ·
    // REFERRALS & EARNINGS + WORKER ACTIVITY (W2-B polish)" block in globals.css). Not
    // `.agency-workers`: that is the retired B5 wrapper, whose grid rules are still fenced by
    // agency-b5-layout.css.test.
    <div className="agency-workers-page">
      <PageHeader
        title="Worker activity"
        description="How the workers you referred are getting on — as a funnel, not as a contact list."
      />

      {/* THE PRIVACY BOUNDARY, stated once, before the data — the same icon-led `.alert` the
          applicant feed uses for "Applicants are faceless". Its first sentence is the headline;
          the rest of the copy is unchanged, only moved out of the panel head. The
          handle-uniqueness line is still shown only alongside a populated list. */}
      <div className="alert alert--info">
        <Icon name="mask-happy" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__title">Every row is a private handle, not a person.</p>
          <p className="alert__body">
            BadaBhai never shows an agency a worker&rsquo;s name, phone number or employer, which
            posting they applied to, or who unlocked them. What you get is the funnel: whether they
            finished their profile, how many times they applied, how many times a company unlocked
            them, and the last day they were active.
          </p>
          {countLine ? (
            <p className="alert__body">
              Handles are unique to your agency — another agency that referred the same worker sees
              a different one, so no two agencies can combine their lists.
            </p>
          ) : null}
        </div>
      </div>

      {/* `.panel--table` because the body IS the table (or, when there is nothing to show, the
          state that stands in for it) — the cell padding is the rhythm, so the body owns none.
          The head is the title + the truthful count, so nothing floats below the table. */}
      <section className="panel panel--table">
        <div className="panel__head">
          <div className="panel__text">
            <h2 className="panel__title" id={REFERRED_WORKERS_HEADING_ID}>
              Referred workers
            </h2>
            {countLine ? <p className="panel__sub">{countLine}</p> : null}
          </div>
        </div>
        <div className="panel__body">
          {workers === null ? (
            <div className="state state--error">
              <span className="state__icon">
                <Icon name="warning-circle" />
              </span>
              <h3 className="state__title">Worker activity is unavailable</h3>
              <p className="state__body">
                This list could not load right now. Nothing has changed — your referrals are
                safe. Please retry shortly.
              </p>
              <div className="state__actions">
                <RetryButton />
              </div>
            </div>
          ) : (
            <WorkerActivityList workers={workers} />
          )}
        </div>
      </section>
    </div>
  );
}
