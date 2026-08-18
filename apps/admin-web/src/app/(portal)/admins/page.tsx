import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listAdmins } from "../../../lib/entities";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { InviteAdminForm } from "./invite-admin-form";
import { AdminRowActions } from "./admin-row-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin users" };

/**
 * Admin users — a security-audit view of who holds access.
 *
 * ── WHY THERE IS NO NAME OR EMAIL COLUMN ────────────────────────────────────────────────
 * `admin_users.email_enc` and `name_enc` are AES-256-GCM ciphertext at rest, and no route on
 * this platform has ever decrypted ANOTHER admin's identity. Serving them here would be a new
 * cross-actor PII path and would turn one screen into the complete admin address book, so it
 * was escalated rather than assumed. **Owner ruling, 2026-08-04: faceless.**
 *
 * That is not a crippled screen, because the questions this page exists to answer are
 * security questions and none of them need a name:
 *   - how many people hold `super_admin`, and is that number 1 (a lockout risk) or many
 *     (an over-privilege smell)
 *   - who has never enrolled a second factor
 *   - who has never logged in, or has gone quiet
 *   - who is still `pending` long after being invited
 *
 * The admin id is the join to everything else — it is the `actor_id` on every
 * `admin.action_performed` event, so "what has this account actually done" is one click away.
 */
export default async function AdminsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("manage_admins");
  const canManage = can(session.capabilities, "manage_admins");

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

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Admin users</h1>
          <p className="page__sub">
            Who holds access to this portal. Names and emails are encrypted at rest and are
            deliberately not shown — the id is the handle, and it appears on every audit event.
          </p>
        </div>
      </header>

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
                  <th scope="col">Admin</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Second factor</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Added</th>
                  {canManage && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="mono" title={a.id}>
                        {shortId(a.id)}
                      </span>
                      {a.is_self && <span className="table__meta">you</span>}
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
                    {canManage && (
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
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && <InviteAdminForm />}
    </div>
  );
}
