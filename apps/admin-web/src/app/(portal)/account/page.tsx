import Link from "next/link";
import { requireSession } from "../../../lib/auth";
import { readAccountSecurity, type AccountSecurity } from "../../../lib/account";
import { PageHeader } from "../../../components/page-header";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { PasswordPanel } from "./password-panel";
import { MfaPanel } from "./mfa-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

/**
 * Account — how the signed-in admin signs in (ADR-0060 A2/A5): their password and their
 * two-step verification switch.
 *
 * SESSION-ONLY, deliberately: every admin, whatever their role, may manage their OWN sign-in, so
 * the gate is `requireSession()` and nothing more, and every route it calls is `AdminAuthGuard`
 * only. Each acts on the session's admin; no id is ever sent, so nothing here can be pointed at
 * another account.
 *
 * Each panel renders from what the SERVER reports on `GET /admin/me`. A field the server did not
 * send is "could not be read", never a guessed default — a page that said "two-step verification
 * is off" because a field was missing would invite the operator to turn on something already on.
 */
export default async function AccountPage() {
  await requireSession();

  let security: AccountSecurity | null = null;
  try {
    security = await readAccountSecurity();
  } catch {
    security = null;
  }

  return (
    <div className="page">
      <PageHeader
        title="Account"
        description="How you sign in to this portal: your password and two-step verification."
      />

      {security?.mustChangePassword ? (
        <section className="notice notice--warn" role="status">
          <strong>You are signed in with a temporary password.</strong> Replace it below with one
          only you know.
        </section>
      ) : null}

      {security === null ? (
        <section className="panel" aria-labelledby="ac-failed">
          <div className="state state--error">
            <h2 className="state__title" id="ac-failed">
              Your sign-in settings could not be loaded
            </h2>
            <p className="state__body">
              Nothing has changed on your account. The read failed, so this page cannot say
              whether you have a password or two-step verification on.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/account">
                <Icon name={ACTION_ICON.retry} />
                Retry
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <div className="cols">
          {security.hasPassword === null ? (
            <Unreported title="Password" />
          ) : (
            <PasswordPanel hasPassword={security.hasPassword} />
          )}
          {security.mfaEnabled === null ? (
            <Unreported title="Two-step verification" />
          ) : (
            <MfaPanel enabled={security.mfaEnabled} />
          )}
        </div>
      )}
    </div>
  );
}

/** A panel whose state this API build does not report: said plainly, with nothing to press. */
function Unreported({ title }: { title: string }) {
  const id = `ac-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel__head">
        <h2 className="panel__title" id={id}>
          {title}
        </h2>
      </div>
      <div className="state">
        <h3 className="state__title">Not available on this server yet</h3>
        <p className="state__body">
          The admin API did not report this setting, so it cannot be shown or changed here. It
          appears once the API that supports it is deployed.
        </p>
      </div>
    </section>
  );
}
