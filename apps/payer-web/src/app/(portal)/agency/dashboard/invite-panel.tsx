/**
 * AGENCY INVITE INTENT panel — CONSENT-FIRST explainer with a DISABLED control.
 *
 * HARD TRUTH (do not "fix" by wiring it up): there is NO agency-callable invite API.
 * `POST /invites` is WORKER-authed — it mints a worker's OWN onboarding link, not an
 * agency's. So the agency invite hook is NON-FUNCTIONAL today. This panel therefore:
 *  - generates NO link, fakes NO success, and accepts NO phone/name/CSV input
 *    (a worker phone/name here would breach the faceless boundary + consent gate);
 *  - renders a DISABLED "Generate invite link (coming soon)" button only;
 *  - states the consent requirement EXACTLY (workers self-onboard + accept consent
 *    before BadaBhai processes their data — CLAUDE.md invariant #6, DPDP gate).
 *
 * It is a Server Component: there is no client state because there is nothing to do.
 */
export function AgencyInvitePanel() {
  return (
    <section className="section">
      <h2>Invite workers</h2>
      <div className="note">
        <strong>Consent-first.</strong> Share this link with workers. They must self-onboard and
        accept consent before BadaBhai processes their data.
      </div>
      <p className="page-sub">
        Agencies never upload worker phone numbers or names here — workers join themselves and give
        their own consent. You will only ever see consent-safe, aggregate progress.
      </p>
      <div className="btn-row">
        <button className="btn secondary" type="button" disabled aria-disabled="true">
          Generate invite link (coming soon)
        </button>
      </div>
      <p className="page-sub">
        <span className="badge badge-warn">Not available yet</span> The worker-invite flow is
        worker-initiated; an agency-issued link is not wired in this preview.
      </p>
    </section>
  );
}
