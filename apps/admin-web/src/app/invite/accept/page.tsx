import { AcceptForm } from "./accept-form";
import { MISSING_TOKEN_ERROR } from "./messages";

// Per request, never at build time: the token lives in the query string.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Accept invite · BadaBhai Admin",
  // Never indexed — and an invite URL in a search result would be a leaked credential.
  robots: { index: false, follow: false },
};

/**
 * Redeem an admin invite (#1494).
 *
 * OUTSIDE `(portal)` on purpose. Every page in that group is capability-gated behind a
 * session, and the invitee has neither — they are being given the account this page
 * activates. It sits beside `/login`, which is the only other unauthenticated surface.
 *
 * THE TOKEN IS READ HERE, server-side, and handed to a client component only so a human
 * can press a button. It is never placed in the page's HTML, a data attribute, or an
 * analytics event. It is a bearer secret with a 48-hour life and exactly one use.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  // A repeated ?token= yields an array; take the first rather than joining, which would
  // build a token that was never issued.
  const raw = Array.isArray(token) ? token[0] : token;

  return (
    <main className="auth-wrap">
      <div className="auth-shell">
        <header className="auth-brand">
          <span className="auth-brand__mark" aria-hidden="true">
            BB
          </span>
          <span className="auth-brand__text">
            <span className="auth-brand__name">BadaBhai</span>
            <span className="auth-brand__role">Admin</span>
          </span>
        </header>

        <h1 className="auth-title">Accept your invite</h1>

        {raw && raw.trim() !== "" ? (
          <AcceptForm token={raw} />
        ) : (
          <p className="field__error" role="alert">
            {MISSING_TOKEN_ERROR}
          </p>
        )}

        <footer className="auth-foot">
          <p>
            Access is logged. Every privileged action is recorded against your admin
            identity.
          </p>
        </footer>
      </div>
    </main>
  );
}
