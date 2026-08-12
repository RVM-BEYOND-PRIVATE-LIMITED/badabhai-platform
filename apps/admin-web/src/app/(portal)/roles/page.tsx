import Link from "next/link";
import { requireSession } from "../../../lib/auth";
import { getCapabilityMatrix } from "../../../lib/entities";
import { CAPABILITY_LABELS, ROLE_LABELS, isAdminCapability } from "../../../lib/auth/capabilities";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roles and capabilities" };

/**
 * Roles and capabilities — the authorization model, read from the server.
 *
 * ── WHY THE MATRIX IS FETCHED AND NOT HARDCODED ─────────────────────────────────────────
 * `ADMIN_CAPABILITY_MATRIX` lives in `apps/api` and is what the guards actually enforce. A
 * sibling app cannot import it, and typing the table out here would create a second
 * authorization model that drifts the first time a row changes — precisely what CLAUDE.md
 * invariant #9 forbids. So the server serves it, derived through the SAME `can()` the guard
 * calls, and this page renders whatever it is told.
 *
 * The consequence worth stating: if this page is ever wrong, the server is wrong too. It
 * cannot disagree with enforcement, which is the only property that makes a permissions
 * screen worth showing at all.
 */
export default async function RolesPage() {
  // Every authenticated admin may see the model — including the parts denied to them. It is
  // published in ADR-0025 §3.1, and hiding it would only make the portal's own limits opaque
  // to the people working inside them.
  const session = await requireSession();

  let matrix: Awaited<ReturnType<typeof getCapabilityMatrix>> | null = null;
  try {
    matrix = await getCapabilityMatrix();
  } catch {
    matrix = null;
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Roles and capabilities</h1>
          <p className="page__sub">
            The authorization model, read live from the server — the same matrix the guards
            enforce, so this table cannot disagree with what is actually permitted.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="rc-you">
        <div className="panel__head">
          <h2 className="panel__title" id="rc-you">
            Your access
          </h2>
          <p className="panel__sub">
            You are signed in as <strong>{ROLE_LABELS[session.role] ?? session.role}</strong>.
          </p>
        </div>
        <ul className="chips">
          {session.capabilities.map((c) => (
            <li className="chip" key={c}>
              {CAPABILITY_LABELS[c] ?? c}
            </li>
          ))}
        </ul>
        {/* `.field__help` is the FORM caption class; this is a standing statement about how
            authorization works, which is what `.alert--info` is the primitive for. */}
        <div className="alert alert--info">
          <div className="alert__text">
            <p className="alert__title">This list is not the enforcement</p>
            <p className="alert__body">
              Hiding a control you cannot use is a convenience, not a security boundary —
              every request is re-checked server-side regardless of what this list says.
            </p>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="rc-matrix">
        <div className="panel__head">
          <h2 className="panel__title" id="rc-matrix">
            Full matrix
          </h2>
          <p className="panel__sub">
            Deny-by-default: a cell is permitted only where it is marked. An unlisted
            capability, or an unknown role, is denied — never defaulted to a privileged one.
          </p>
        </div>

        {matrix === null ? (
          <div className="state state--error">
            <h3 className="state__title">The capability matrix could not be loaded</h3>
            <p className="state__body">
              This table is served by the API from the same matrix the guards enforce, and
              that read failed — so the model is unknown here, not empty. Nothing about what
              is permitted has changed; only this view of it is missing. Your own
              capabilities are listed above and came from your session, not from this read.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/roles">
                Retry
              </Link>
            </div>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Capability by role</caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  {matrix.roles.map((r) => (
                    <th scope="col" key={r}>
                      {ROLE_LABELS[r] ?? r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.matrix.map((row) => (
                  <tr key={row.capability}>
                    <th scope="row" className="table__rowhead">
                      {isAdminCapability(row.capability)
                        ? CAPABILITY_LABELS[row.capability]
                        : // An unmapped capability is shown RAW, not hidden: the server has
                          // one this portal has not been taught about, and that is worth
                          // seeing rather than silently dropping a row.
                          row.capability.replace(/_/g, " ")}
                    </th>
                    {matrix.roles.map((r) => {
                      const allowed = row.roles.includes(r);
                      const mine = r === session.role;
                      return (
                        <td key={r} className={mine ? "cell--mine" : undefined}>
                          <span
                            className={`mark mark--${allowed ? "yes" : "no"}`}
                            aria-label={allowed ? "permitted" : "denied"}
                            title={`${ROLE_LABELS[r] ?? r}: ${allowed ? "permitted" : "denied"}`}
                          >
                            {allowed ? "✓" : "·"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="alert alert--info">
          <div className="alert__text">
            <p className="alert__title">Your column is highlighted</p>
            <p className="alert__body">
              Changing a role is a governed action (<code>manage_admins</code>, super admin
              only) and emits an audited event. It cannot be done from this portal.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
