import { requireSession } from "../../lib/auth";
import { CAPABILITY_LABELS, ROLE_LABELS } from "../../lib/auth/capabilities";

export const dynamic = "force-dynamic";

export const metadata = { title: "Dashboard" };

/**
 * Dashboard — the ADMIN-4 shell.
 *
 * Deliberately shows only what this milestone can show TRUTHFULLY: who you are and what
 * you may do, both straight from the server. The live event feed and system-health tiles
 * arrive in ADMIN-5 against `GET /admin/events` + `/events/metrics`.
 *
 * No placeholder metrics, no fake sparklines, no "1,248 workers" mock. A number on an
 * operations console is a claim, and an invented one teaches operators to distrust the
 * real ones next to it.
 */
export default async function DashboardPage() {
  const session = await requireSession();

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Dashboard</h1>
          <p className="page__sub">
            Signed in as <strong>{ROLE_LABELS[session.role]}</strong>.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="perm-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="perm-heading">
            Your permissions
          </h2>
          <p className="panel__sub">
            Resolved by the server for this session. The portal hides what you cannot do;
            every action is re-checked server-side when you perform it.
          </p>
        </div>

        <ul className="caplist">
          {session.capabilities.map((c) => (
            <li className="caplist__item" key={c}>
              <span className="caplist__dot" aria-hidden="true" />
              {CAPABILITY_LABELS[c]}
            </li>
          ))}
        </ul>

        {session.capabilities.length === 0 && (
          <p className="empty">
            This session holds no capabilities. That is unusual — contact a super admin.
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="next-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="next-heading">
            Coming next
          </h2>
          <p className="panel__sub">
            Operations, finance and administration modules land in ADMIN-5 through
            ADMIN-8. Sections appear here as they ship.
          </p>
        </div>
      </section>
    </div>
  );
}
