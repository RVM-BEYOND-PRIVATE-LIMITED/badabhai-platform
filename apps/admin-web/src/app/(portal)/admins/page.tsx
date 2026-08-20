import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listAdmins } from "../../../lib/entities";
import { identityPosture } from "../../../lib/identity";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { InviteAdminForm } from "./invite-admin-form";
import { AdminRowActions } from "./admin-row-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin users" };

/**
 * Admin users — a security-audit view of who holds access.
 *
 * ── NAMES YES, EMAILS NO, AND BOTH HALVES ARE OWNER RULINGS ─────────────────────────────
 * `admin_users.email_enc` and `name_enc` are both AES-256-GCM ciphertext at rest. The 2026-08-04
 * ruling made this screen entirely faceless; the CTO REVERSED the name half on 2026-08-18,
 * because a directory of uuids cannot answer the question people actually open it with — "who is
 * this account?". So the Name column is served behind `read_identity`, capped and audited like
 * every other name on this console.
 *
 * The EMAIL half stands, and nothing here has reversed it. It is the one that would turn this
 * screen into the complete admin ADDRESS BOOK — a phishing target list for precisely the accounts
 * with the most reach — so there is no email column, no email in the row shape, and no
 * `mfa_secret_enc` ever.
 *
 * A null name is COMMON on this screen rather than exceptional: the invite flow does not collect
 * one, so an account invited and never named renders the dash. That is why the screen's own
 * questions are still framed around role, MFA and recency, all of which were always answerable
 * without a name and none of which a name changes:
 *   - how many people hold `super_admin`, and is that number 1 (a lockout risk) or many
 *     (an over-privilege smell)
 *   - who has never enrolled a second factor
 *   - who has never logged in, or has gone quiet
 *   - who is still `pending` long after being invited
 *
 * The admin id remains the join to everything else — it is the `actor_id` on every
 * `admin.action_performed` event — so the id cell links straight to that account's slice of
 * the audit spine, and the header links to the whole `admin.action_performed` stream.
 *
 * ── THE ONE POSTURE THAT IS SPECIAL HERE ────────────────────────────────────────────────
 * This route is deliberately UNPAGINATED, so above the server's 50-name response bound it serves
 * every row faceless rather than naming the first fifty (which would report the rest as "no name
 * on record") or truncating the audit list to fifty (which would drop admin accounts off the one
 * screen that exists to enumerate them). So the CAPPED banner here has two possible causes, and
 * it names both rather than asserting the wrong one.
 *
 * ── WHY THERE IS NO IN-PAGE `can(...)` GATE HERE ────────────────────────────────────────
 * `session.ts` guides page-level `requireCapability` for whole pages and `can(...)` for
 * in-page controls, so that an operator who may READ a screen sees it without the controls
 * they may not use. That split does not apply on this page: the backend's own read route,
 * `GET /admin/admins`, is `@RequireAdminRole("manage_admins")` (see
 * `apps/api/src/admin/admin-directory.controller.ts` — the directory is deliberately scoped
 * to the role that can act on it, not to the read floor). So "can view but cannot manage" is
 * not a state that exists: anyone who can load this list holds `manage_admins` by
 * construction. A `canManage` flag computed after the gate would be unconditionally `true`
 * and would read like a real permission check while deciding nothing.
 *
 * If that backend requirement is ever relaxed to `read_entities`, the controls below become
 * genuinely conditional and this is where `can(session.capabilities, "manage_admins")` goes.
 */
export default async function AdminsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("manage_admins");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const role = one(sp.role);
  const status = one(sp.status);

  // The URL the operator is already on, so a retry after a failed read keeps their filters
  // instead of silently dropping them and showing a different list than the one that broke.
  const selfParams = new URLSearchParams();
  if (role) selfParams.set("role", role);
  if (status) selfParams.set("status", status);
  const selfQuery = selfParams.toString();
  const selfHref = selfQuery ? `/admins?${selfQuery}` : "/admins";

  let directory: Awaited<ReturnType<typeof listAdmins>> | null = null;
  let failed = false;
  try {
    directory = await listAdmins({ role, status });
  } catch {
    failed = true;
  }

  const admins = directory?.admins ?? [];
  const noMfa = admins.filter((a) => a.status === "active" && !a.mfa_enrolled).length;
  const neverLoggedIn = admins.filter((a) => a.last_login_at === null).length;
  const supers = directory?.active_super_admins ?? 0;

  const posture = identityPosture(admins, "name", can(session.capabilities, "read_identity"));

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Admin users</h1>
          <p className="page__sub">
            Who holds access to this portal.{" "}
            {posture === "faceless"
              ? "Names are not served to your role and emails are served to no role at all"
              : "Names are shown to your role and every read of one is audited; emails stay encrypted and are served to no role at all"}{" "}
            — the id is the handle, and it appears on every audit event.
          </p>
        </div>
        {/* The way back to the audit spine. Every governed admin action emits an
            `admin.action_performed`, and without this the page states that fact and then
            offers no way to go and read them. */}
        <div className="page__actions">
          <Link className="btn btn--ghost" href="/events?eventName=admin.action_performed">
            View all admin actions
          </Link>
        </div>
      </header>

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: either this admin account has
          spent its hourly name budget, or this directory now holds more than the 50 accounts a
          single response may name — this route is unpaginated, so it serves every row without a
          name rather than naming only some of them.
        </IdentityCapNotice>
      )}

      {/* The two failure modes of a super_admin population, neither visible from a row. */}
      {directory && supers === 1 && (
        <section className="notice notice--warn" role="status">
          <strong>Only one active super admin.</strong> If that person loses their second
          factor, nobody can grant <code>manage_admins</code> again without a database-level
          recovery. Consider a second one.
        </section>
      )}
      {directory && noMfa > 0 && (
        <section className="notice notice--bad" role="status">
          <strong>
            {formatCount(noMfa)} active admin{noMfa === 1 ? "" : "s"} without a second factor.
          </strong>{" "}
          An admin session is the most privileged credential on the platform; a password-only
          path to it is the weakest link in the whole model.
        </section>
      )}

      <section aria-labelledby="ad-stats">
        <h2 className="sr-only" id="ad-stats">
          Access summary
        </h2>
        <div className="stats">
          <div className="stat">
            <span className="stat__value">{formatCount(admins.length)}</span>
            <span className="stat__label">Admin accounts</span>
          </div>
          <div className={`stat${supers === 1 ? " stat--warn" : ""}`}>
            <span className="stat__value">{formatCount(supers)}</span>
            <span className="stat__label">Active super admins</span>
          </div>
          <div className={`stat${noMfa > 0 ? " stat--warn" : ""}`}>
            <span className="stat__value">{formatCount(noMfa)}</span>
            <span className="stat__label">Active without MFA</span>
          </div>
          <div className="stat">
            <span className="stat__value">{formatCount(neverLoggedIn)}</span>
            <span className="stat__label">Never signed in</span>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="ad-list" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="ad-list">
              Accounts
            </h2>
            <p className="panel__sub">
              Oldest first. The whole list is shown — admin access is scarce by design, so
              there is nothing to page through.
            </p>
          </div>
          {(role || status) && (
            <Link className="btn btn--ghost" href="/admins">
              Clear filters
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {["super_admin", "ops_admin", "support", "analyst"].map((r) => (
            <Link
              className={`btn btn--sm ${r === role ? "btn--primary" : "btn--ghost"}`}
              href={`/admins?role=${r}`}
              key={r}
            >
              {r.replace(/_/g, " ")}
            </Link>
          ))}
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The admin directory could not be loaded</h3>
            <p className="state__body">
              The directory read failed, so this list is missing rather than empty — and the
              counters above are computed from it, so they read zero and mean nothing right
              now. Do not conclude from this screen that nobody holds access.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={selfHref}>
                Retry
              </Link>
            </div>
          </div>
        ) : admins.length === 0 ? (
          <div className="state">
            <h3 className="state__title">
              {role || status ? "No admins match these filters" : "No admin accounts exist"}
            </h3>
            <p className="state__body">
              {role || status
                ? "The directory loaded, but nobody holds this combination of role and status. Clear the filters to see everyone."
                : "The directory loaded and it is genuinely empty. On a running platform that is not a normal state — you are signed in, so at least your own account should be here."}
            </p>
            {(role || status) && (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/admins">
                  Clear filters
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Admin accounts, oldest first</caption>
              <thead>
                <tr>
                  {/* Named posture only. Here the dash is the ordinary case — an invited
                      account nobody has named — which is exactly why it must not also be
                      made to mean "withheld from you". */}
                  {posture === "named" && <th scope="col">Name</th>}
                  <th scope="col">Admin</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Second factor</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Added</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.id}>
                    {posture === "named" && (
                      <td>
                        <NameCell value={a.name} />
                        {/* "you" moves onto the name cell when there is one: it belongs
                            beside whatever this row's primary label is. */}
                        {a.is_self && <span className="table__meta">you</span>}
                      </td>
                    )}
                    <td>
                      {/* Every OTHER entity now has a per-entity timeline route; admins do
                          not, and deliberately so — `admin_session` is absent from
                          ADMIN_TIMELINE_SUBJECT_TYPES (mirrored verbatim from the server in
                          `lib/events.ts`), so a per-admin timeline would be a server-side
                          400. This link is therefore subject-type-wide, and it says so: the
                          id is the visible label, so without the title it would read as a
                          promise of THIS admin's history. A `subjectId` param is not carried
                          — `EventFilters` has no such field, so it would make that false
                          promise and then quietly show every admin's events. */}
                      <Link
                        className="mono link"
                        href="/events?subjectType=admin_session"
                        title={`${a.id} — opens every admin_session event, not only this admin's`}
                      >
                        {shortId(a.id)}
                      </Link>
                      {a.is_self && posture !== "named" && (
                        <span className="table__meta">you</span>
                      )}
                    </td>
                    <td>
                      {/* Explicit tone: super_admin is not a "good" state, it is the most
                          privileged one, and it should read as something to notice. */}
                      <StatusPill
                        value={a.role}
                        label={a.role.replace(/_/g, " ")}
                        tone={a.role === "super_admin" ? "warn" : "muted"}
                        title={
                          a.role === "super_admin"
                            ? "Break-glass: every capability, including kill switches and admin management"
                            : undefined
                        }
                      />
                    </td>
                    <td>
                      <StatusPill value={a.status} />
                    </td>
                    <td>
                      {a.mfa_enrolled ? (
                        <StatusPill value="enrolled" label="enrolled" tone="ok" />
                      ) : (
                        // Only alarming for an account that can actually sign in; a pending
                        // invite legitimately has no second factor yet.
                        <StatusPill
                          value="not enrolled"
                          label="not enrolled"
                          tone={a.status === "active" ? "bad" : "muted"}
                        />
                      )}
                    </td>
                    <td>
                      {a.last_login_at ? (
                        <time
                          dateTime={a.last_login_at}
                          title={formatTimestamp(a.last_login_at)}
                        >
                          {formatRelative(a.last_login_at)}
                        </time>
                      ) : (
                        <span className="table__meta">never</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={a.created_at} title={formatTimestamp(a.created_at)}>
                        {formatRelative(a.created_at)}
                      </time>
                    </td>
                    <td>
                      <AdminRowActions
                        admin={{
                          id: a.id,
                          role: a.role,
                          status: a.status,
                          is_self: a.is_self,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <InviteAdminForm />
    </div>
  );
}
